import type { Decision, Snapshot, ToolCall } from "../../types.ts";
import type { ToolSession } from "../replay.ts";
import { parseMaybe, type AgentAdapter, type NormalizedResult, type Runnable, type RunInput } from "./adapter.ts";

type AnyRecord = Record<string, any>;

/**
 * Any agent, as a function that runs one input: the raw OpenAI SDK, another
 * framework, or a hand-written loop. Export the function itself, or an object
 * with `run`. It gets `(input, { conversation, context })`. `instructions`,
 * `model` and `tools` on either one are optional and feed the prompt diff and
 * the tool checks.
 */
export function isAgentFunction(value: unknown): boolean {
  return (
    typeof value === "function" ||
    (!!value && typeof value === "object" && typeof (value as AnyRecord).run === "function")
  );
}

/** Tool definitions in OpenAI's Chat Completions or Responses shape, or a name → definition map. */
function toolDefinitions(tools: unknown): NonNullable<Snapshot["toolDefinitions"]> {
  const out: NonNullable<Snapshot["toolDefinitions"]> = {};
  const add = (name: unknown, def: AnyRecord) => {
    if (typeof name === "string")
      out[name] = {
        description: typeof def?.description === "string" ? def.description : "",
        inputSchema: def?.parameters ?? def?.inputSchema,
      };
  };
  if (Array.isArray(tools))
    for (const t of tools) {
      if (typeof t === "string") add(t, {});
      else add(t?.function?.name ?? t?.name, t?.function ?? t);
    }
  else if (tools && typeof tools === "object")
    for (const [name, def] of Object.entries(tools)) add(name, def as AnyRecord);
  return out;
}

function toolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.map((c: AnyRecord) => ({
    tool: String(c?.tool ?? c?.name ?? c?.toolName ?? c?.function?.name ?? "unknown"),
    input: parseMaybe(c?.input ?? c?.args ?? c?.arguments ?? c?.function?.arguments ?? null),
    output: parseMaybe(c?.output ?? c?.result ?? null),
  }));
}

/**
 * Checks the function ran itself (a keyword rule, a quiet-hours check): `answer`
 * is yes/no, a choice, or a score; `after` is how many of its tool calls came
 * before the check.
 */
function checksOf(value: unknown, calls: number): Decision[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((c: AnyRecord): Decision[] => {
    if (typeof c?.id !== "string") return [];
    const after = Number.isInteger(c.after) && c.after >= 0 && c.after <= calls ? c.after : undefined;
    const base = {
      id: c.id,
      instructions: typeof c.question === "string" ? c.question : c.id,
      source: "agent" as const,
      ...(after != null ? { after } : {}),
    };
    if (typeof c.answer === "boolean")
      return [{ ...base, type: "boolean", answer: { type: "boolean", probability: c.answer ? 1 : 0 } }];
    if (typeof c.answer === "string")
      return [{ ...base, type: "choice", answer: { type: "choice", choice: c.answer } }];
    if (typeof c.answer === "number") return [{ ...base, type: "score", answer: { type: "score", score: c.answer } }];
    return [];
  });
}

function normalize(value: unknown): NormalizedResult {
  if (typeof value === "string")
    return { __agentdiffNormalized: true, text: value, toolCalls: [], steps: null, tokens: null };
  const r = (value ?? {}) as AnyRecord;
  const text = r.text ?? r.output ?? r.reply ?? r.response ?? null;
  const u = r.usage;
  const input = u?.inputTokens ?? u?.input_tokens ?? u?.promptTokens ?? u?.prompt_tokens ?? null;
  const output = u?.outputTokens ?? u?.output_tokens ?? u?.completionTokens ?? u?.completion_tokens ?? null;
  const calls = toolCalls(r.toolCalls ?? r.tool_calls);
  const checks = checksOf(r.checks, calls.length);
  return {
    __agentdiffNormalized: true,
    text: text == null ? null : typeof text === "string" ? text : JSON.stringify(text),
    toolCalls: calls,
    steps: typeof r.steps === "number" ? r.steps : null,
    tokens: input == null && output == null ? null : { input, output },
    ...(checks.length ? { checks } : {}),
  };
}

export function functionAdapter(value: AnyRecord | ((input: string) => unknown), exportName: string): AgentAdapter {
  const meta = value as AnyRecord;
  const run = (typeof value === "function" ? value : meta.run.bind(meta)) as (input: string, run: RunInput) => unknown;
  const defs = () => toolDefinitions(meta.tools);
  return {
    __agentdiffAdapter: "function",
    __agentdiffRunnable: true,
    generate: async (input, runInput) => normalize(await run(input, runInput ?? {})),
    snapshot: async () => ({
      name:
        typeof meta.agentName === "string"
          ? meta.agentName
          : typeof meta.name === "string" && meta.name && meta.name !== "run"
            ? meta.name
            : exportName,
      instructions: typeof meta.instructions === "string" ? meta.instructions : "",
      model: typeof meta.model === "string" ? meta.model : "unknown",
      tools: Object.keys(defs()),
      workflows: [],
      settings: meta.settings && typeof meta.settings === "object" ? { ...meta.settings } : {},
      toolDefinitions: defs(),
    }),
    listTools: async () => defs(),
    /**
     * The function gets `run.tools`, one entry per tool name, each answered by
     * the session. Whatever it reports as its tool calls must have gone
     * through them, in order: a call it made some other way is a real side
     * effect agentdiff can't vouch for, so the run stops.
     */
    async withTools(session: ToolSession): Promise<Runnable> {
      const tools = new Proxy({} as NonNullable<RunInput["tools"]>, {
        get: (_, name) =>
          typeof name === "string" ? async (input: unknown) => session.execute(name, input) : undefined,
        has: () => true,
      });
      return {
        __agentdiffRunnable: true,
        generate: async (input, runInput) => {
          const result = normalize(await run(input, { ...(runInput ?? {}), tools }));
          const answered = session.calls.map((c) => c.tool);
          const outside = result.toolCalls.find((c, i) => answered[i] !== c.tool);
          if (outside)
            session.fail(
              `${outside.tool} ran outside the tools agentdiff passed in. Call run.tools?.${outside.tool} so replay and discovery can stand in for it.`,
            );
          return result;
        },
      };
    },
  };
}
