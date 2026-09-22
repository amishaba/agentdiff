import { generateObject, NoObjectGeneratedError } from "ai";
import { z } from "zod";
import { openaiModel } from "../lib/llm.ts";
import type { Snapshot } from "../types.ts";

/** One structured model call: a schema, a system prompt, and the data. Passed in, so tests run without a key. */
export type AskModel = <S extends z.ZodType>(request: {
  schema: S;
  system: string;
  prompt: string;
}) => Promise<z.infer<S>>;

/** How long one call may take before it is asked again. */
const TIMEOUT_MS = 240_000;

export function openaiAsk(): AskModel {
  const once = async (request: { schema: z.ZodType; system: string; prompt: string }) =>
    (
      await generateObject({
        model: openaiModel(),
        ...request,
        // Room for the reasoning as well as the scenarios; a long rule can need both.
        maxOutputTokens: 32_000,
        // Many calls run at once (modelConcurrency), so a rate limit is likelier: retry with backoff.
        maxRetries: 3,
        abortSignal: AbortSignal.timeout(TIMEOUT_MS),
      })
    ).object;
  return (async (request) => {
    try {
      return await once(request);
    } catch (err) {
      if (!NoObjectGeneratedError.isInstance(err) && !timedOut(err)) throw err;
      // An empty, cut-off or timed-out answer is usually a one-off: ask again once, then say why.
      try {
        return await once(request);
      } catch (again) {
        if (NoObjectGeneratedError.isInstance(again))
          throw new Error(
            `the model returned no usable answer twice (finish reason: ${again.finishReason ?? "unknown"})`,
          );
        if (timedOut(again)) throw new Error(`the model took over ${TIMEOUT_MS / 60_000} minutes to answer, twice`);
        throw again;
      }
    }
  }) as AskModel;
}

/** A call cut off by its timeout, however deep the SDK wrapped the error. */
function timedOut(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) if (e.name === "TimeoutError") return true;
  return false;
}

/**
 * Told to the planner and the writer when the person running agentdiff names
 * topics to leave out (scenarios --avoid): the one part of their input that
 * is meant as an instruction rather than data.
 */
export const AVOID_TOPICS_INSTRUCTION =
  "\nWhen avoidTopics is given, it comes from the person running this, not from the agent: write nothing about those topics, not even as an edge case.";

/** What the planner and the writer are told about the agent. */
export interface AgentBrief {
  name: string;
  instructions: string;
  /** Each tool's description and the shape of its input and output, when the agent declares them. */
  tools: Record<string, { description: string; input?: unknown; output?: unknown }>;
  /** Guardrails and processors that run around the agent, by name. */
  guardrails: string[];
  /** Tools that only read, when the config's writeTools says which tools change things. */
  readOnlyTools?: string[];
}

const GUARDRAIL_SETTINGS = ["inputGuardrails", "outputGuardrails", "inputProcessors", "outputProcessors"];

export function agentBrief(snapshot: Snapshot, writeTools?: string[]): AgentBrief {
  const defs = snapshot.toolDefinitions ?? {};
  const readOnly = writeTools?.length ? snapshot.tools.filter((t) => !writeTools.includes(t)) : [];
  return {
    ...(readOnly.length ? { readOnlyTools: readOnly } : {}),
    name: snapshot.name,
    instructions: snapshot.instructions,
    tools: Object.fromEntries(
      snapshot.tools.map((tool) => [
        tool,
        {
          description: defs[tool]?.description ?? "",
          ...(defs[tool]?.inputSchema ? { input: defs[tool].inputSchema } : {}),
          ...(defs[tool]?.outputSchema ? { output: defs[tool].outputSchema } : {}),
        },
      ]),
    ),
    guardrails: GUARDRAIL_SETTINGS.flatMap((key) => {
      const list = snapshot.settings[key];
      return Array.isArray(list) ? list.map((g) => `${String(g)} (${key})`) : [];
    }),
  };
}

/** A list of the agent's tool names, for a schema; empty when the agent has no tools. */
export function toolList(brief: AgentBrief) {
  const tools = Object.keys(brief.tools);
  return tools.length ? z.array(z.enum(tools as [string, ...string[]])) : z.array(z.string()).max(0);
}
