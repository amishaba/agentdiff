import type { Decision, Snapshot, ToolCall } from "../../types.ts";
import type { ToolSession } from "../replay.ts";
import { markHandoff, markToolStart, startsSoFar } from "../decisions.ts";
import { importFromProject } from "../peer.ts";
import { parseMaybe, type AgentAdapter, type NormalizedResult, type Runnable, type RunInput } from "./adapter.ts";
import type { AnyAgent } from "../load.ts";

// Duck-typed like the Mastra path: agentdiff never depends on @openai/agents.

/** An `Agent` from the OpenAI Agents SDK (`@openai/agents`). */
export function isOpenAIAgent(value: unknown): value is AnyAgent {
  const a = value as AnyAgent;
  return (
    !!a &&
    typeof a === "object" &&
    typeof a.generate !== "function" &&
    typeof a.clone === "function" &&
    Array.isArray(a.tools) &&
    Array.isArray(a.handoffs) &&
    "modelSettings" in a
  );
}

/** The SDK the agent file itself resolves, so the runner and the agent share one module instance. */
async function loadSdk(agentFile: string): Promise<AnyAgent> {
  const sdk = await importFromProject(agentFile, "@openai/agents");
  if (!sdk)
    throw new Error(
      `Found an OpenAI Agents SDK agent in ${agentFile}, but couldn't resolve @openai/agents from it. Install it in the agent's project.`,
    );
  return sdk;
}

function modelName(agent: AnyAgent, sdk: AnyAgent): string {
  const m = agent.model;
  if (typeof m === "string") return m || sdk.getDefaultModel?.() || "default";
  if (m && typeof m === "object") return m._model ?? m.model ?? m.modelId ?? m.constructor?.name ?? "custom model";
  return sdk.getDefaultModel?.() ?? "default";
}

const SETTING_KEYS = [
  "temperature",
  "topP",
  "maxTokens",
  "toolChoice",
  "parallelToolCalls",
  "truncation",
  "reasoning",
  "text",
];

async function instructionsOf(agent: AnyAgent, sdk: AnyAgent): Promise<string> {
  let instructions = "";
  if (typeof agent.instructions === "string") instructions = agent.instructions;
  else if (typeof agent.instructions === "function") {
    try {
      instructions = (await agent.getSystemPrompt(new sdk.RunContext({}))) ?? "";
    } catch {
      instructions =
        "(instructions come from a function that needs a run context; agentdiff can't read them ahead of a run)";
    }
  }
  if (agent.prompt && typeof agent.prompt === "object")
    instructions += `${instructions ? "\n" : ""}stored prompt ${agent.prompt.promptId}${agent.prompt.version ? ` v${agent.prompt.version}` : ""}`;
  return instructions;
}

function settingsOf(agent: AnyAgent): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const key of SETTING_KEYS)
    if (agent.modelSettings?.[key] !== undefined) settings[key] = agent.modelSettings[key];
  if (agent.handoffs.length) settings.handoffs = agent.handoffs.map((h: AnyAgent) => h.agentName ?? h.name);
  if (agent.inputGuardrails?.length) settings.inputGuardrails = agent.inputGuardrails.map((g: AnyAgent) => g.name);
  if (agent.outputGuardrails?.length) settings.outputGuardrails = agent.outputGuardrails.map((g: AnyAgent) => g.name);
  if (agent.outputType && agent.outputType !== "text") settings.structuredOutput = true;
  if (agent.toolUseBehavior && agent.toolUseBehavior !== "run_llm_again")
    settings.toolUseBehavior = typeof agent.toolUseBehavior === "string" ? agent.toolUseBehavior : "custom";
  return settings;
}

/** The agent and every agent it can hand off to, directly or not, root first. */
function agentTeam(root: AnyAgent): AnyAgent[] {
  const team: AnyAgent[] = [];
  const visit = (a: AnyAgent) => {
    if (!a || team.includes(a)) return;
    team.push(a);
    for (const h of a.handoffs ?? []) visit(h?.agent ?? h);
  };
  visit(root);
  return team;
}

/**
 * One snapshot for the whole team, so a change to any agent shows up: each
 * agent's instructions under its name, every tool, and per-agent settings
 * (model, handoffs) keyed by agent name. A single agent reads as before.
 */
async function snapshotOf(root: AnyAgent, sdk: AnyAgent): Promise<Snapshot> {
  const team = agentTeam(root);
  const toolDefinitions: NonNullable<Snapshot["toolDefinitions"]> = {};
  for (const a of team)
    for (const t of a.tools as AnyAgent[]) {
      toolDefinitions[t.name] ??= {
        description: typeof t.description === "string" ? t.description : (t.type ?? ""),
        inputSchema: t.parameters,
      };
    }
  let instructions: string;
  let settings: Record<string, unknown>;
  if (team.length === 1) {
    instructions = await instructionsOf(root, sdk);
    settings = settingsOf(root);
  } else {
    instructions = (await Promise.all(team.map(async (a) => `## ${a.name}\n${await instructionsOf(a, sdk)}`))).join(
      "\n\n",
    );
    settings = {};
    for (const a of team) {
      settings[`${a.name}.model`] = modelName(a, sdk);
      for (const [k, v] of Object.entries(settingsOf(a))) settings[`${a.name}.${k}`] = v;
    }
  }
  return {
    name: root.name || "agent",
    instructions,
    model: modelName(root, sdk),
    tools: Object.keys(toolDefinitions),
    workflows: [],
    settings,
    toolDefinitions,
  };
}

/**
 * Tool calls and handoffs in order, each with its output (paired by call id),
 * the agent that made it, and when it started: tool calls by call id, handoffs
 * in the order the runner reported them.
 */
function toolCallsOf(items: AnyAgent[]): ToolCall[] {
  const starts = startsSoFar();
  const calls: ToolCall[] = [];
  const outputs = new Map<string, unknown>();
  let handoff = 0;
  for (const item of items) {
    const raw = item.rawItem ?? {};
    if (item.type === "tool_call_item" || item.type === "handoff_call_item") {
      const id = raw.callId ?? raw.id;
      const at_ms =
        item.type === "handoff_call_item" ? starts?.handoffs[handoff++] : id ? starts?.tools.get(id) : undefined;
      calls.push({
        tool: raw.name ?? raw.type ?? "unknown",
        input: parseMaybe(raw.arguments ?? raw.action ?? null),
        output: null,
        ...(id ? { id } : {}),
        ...(item.agent?.name ? { agent: item.agent.name } : {}),
        ...(at_ms != null ? { at_ms } : {}),
      });
    } else if (item.type === "tool_call_output_item" || item.type === "handoff_output_item") {
      const id = raw.callId ?? raw.id;
      if (id != null) outputs.set(id, parseMaybe(item.output ?? raw.output ?? null));
    }
  }
  return calls.map((c) => (c.id != null && outputs.has(c.id) ? { ...c, output: outputs.get(c.id)! } : c));
}

/** Input and output guardrails as checks: yes means it tripped. Input ones run before any tool call, output ones after the last. */
function guardrailChecks(result: AnyAgent, calls: number, tripped?: AnyAgent): Decision[] {
  const check = (r: AnyAgent, where: "input" | "output"): Decision => ({
    id: r.guardrail?.name ?? `${where}_guardrail`,
    type: "boolean",
    source: "guardrail",
    instructions: `${where} guardrail`,
    answer: { type: "boolean", probability: r.output?.tripwireTriggered ? 1 : 0 },
    after: where === "input" ? 0 : calls,
  });
  const out = [
    ...(result.inputGuardrailResults ?? []).map((r: AnyAgent) => check(r, "input")),
    ...(result.outputGuardrailResults ?? []).map((r: AnyAgent) => check(r, "output")),
  ];
  if (
    tripped &&
    !out.some(
      (d) => d.id === tripped.result?.guardrail?.name && d.answer.type === "boolean" && d.answer.probability === 1,
    )
  ) {
    out.push(
      check(
        tripped.result ?? {},
        tripped.constructor?.name === "OutputGuardrailTripwireTriggered" ? "output" : "input",
      ),
    );
  }
  return out;
}

function normalize(result: AnyAgent, tripped?: AnyAgent): NormalizedResult {
  const out = result.finalOutput;
  const responses: AnyAgent[] = result.rawResponses ?? [];
  const sum = (key: "inputTokens" | "outputTokens") => responses.reduce((s, r) => s + (r.usage?.[key] ?? 0), 0);
  const toolCalls = toolCallsOf(result.newItems ?? []);
  const checks = guardrailChecks(result, toolCalls.length, tripped);
  return {
    __agentdiffNormalized: true,
    // A tripped guardrail stops the reply: the agent answered nothing.
    text: tripped ? null : typeof out === "string" ? out : out == null ? null : JSON.stringify(out),
    toolCalls,
    steps: responses.length || null,
    tokens: responses.length ? { input: sum("inputTokens"), output: sum("outputTokens") } : null,
    ...(checks.length ? { checks } : {}),
  };
}

/** Earlier turns as Responses-style input items, then the new message. */
function inputOf(input: string, run?: RunInput): string | AnyAgent[] {
  if (!run?.conversation?.length) return input;
  return [
    ...run.conversation.map((t) =>
      t.role === "user"
        ? { role: "user", content: t.content }
        : { role: "assistant", status: "completed", content: [{ type: "output_text", text: t.content }] },
    ),
    { role: "user", content: input },
  ];
}

const TRIPWIRES = new Set(["InputGuardrailTripwireTriggered", "OutputGuardrailTripwireTriggered"]);

export async function openAIAgentsAdapter(
  agent: AnyAgent,
  agentFile: string,
  opts: { maxTurns?: number } = {},
): Promise<AgentAdapter> {
  const sdk = await loadSdk(agentFile);
  // Test runs shouldn't fill the user's OpenAI traces dashboard.
  const runner = new sdk.Runner({ tracingDisabled: process.env.AGENTDIFF_OPENAI_TRACING !== "1" });
  // Emitted inside each run, so they land on that run's clock.
  runner.on("agent_tool_start", (_ctx: unknown, _agent: unknown, _tool: unknown, details: AnyAgent) =>
    markToolStart(details?.toolCall?.callId ?? details?.toolCall?.id),
  );
  runner.on("agent_handoff", () => markHandoff());
  const turns = opts.maxTurns ? { maxTurns: opts.maxTurns } : {};
  const runAgent = async (
    a: AnyAgent,
    input: string,
    run: RunInput | undefined,
    extra: Record<string, unknown>,
  ): Promise<NormalizedResult> => {
    const options = { ...turns, ...extra, ...(run?.context ? { context: structuredClone(run.context) } : {}) };
    try {
      return normalize(await runner.run(a, inputOf(input, run), options));
    } catch (err) {
      // A tripped guardrail is behaviour, not an error: record what ran and that nothing was said.
      if (TRIPWIRES.has((err as Error)?.constructor?.name) && (err as AnyAgent).state)
        return normalize(new sdk.RunResult((err as AnyAgent).state), err as AnyAgent);
      throw err;
    }
  };
  return {
    __agentdiffAdapter: "openai-agents",
    __agentdiffRunnable: true,
    generate: (input, run) => runAgent(agent, input, run, {}),
    snapshot: () => snapshotOf(agent, sdk),
    // Every agent in the team, since discovery has to stand in for all of their tools.
    listTools: async () =>
      Object.fromEntries(agentTeam(agent).flatMap((a) => a.tools.map((t: AnyAgent) => [t.name, t]))),
    async withTools(session: ToolSession, limits?: { maxSteps: number }): Promise<Runnable> {
      // A copy of the whole team with every local function tool answered by the session. Anything
      // agentdiff can't stand in for stops here, before a single tool runs.
      const team = agentTeam(agent);
      for (const a of team) {
        if (a.mcpServers?.length)
          throw new Error(`Replay needs an adapter for ${a.name}'s MCP servers. No tools were executed.`);
        for (const t of a.tools)
          if (t.type !== "function")
            throw new Error(
              `Tool ${t.name} on ${a.name} runs on OpenAI's side (${t.type}) and can't be replayed. No tools were executed.`,
            );
      }
      const answered = (t: AnyAgent) => ({
        ...t,
        needsApproval: async () => false,
        invoke: async (_ctx: unknown, input: string) => {
          const output = await session.execute(t.name, parseMaybe(input || "{}"));
          return typeof output === "string" ? output : JSON.stringify(output);
        },
      });
      const copies = new Map<AnyAgent, AnyAgent>(
        team.map((a) => [a, a.clone({ tools: a.tools.map(answered), handoffs: [] })]),
      );
      for (const [original, copy] of copies) {
        copy.handoffs = original.handoffs.map((h: AnyAgent) => {
          const isHandoff = h && typeof h === "object" && "onInvokeHandoff" in h;
          const target = copies.get(isHandoff ? h.agent : h);
          if (!target)
            throw new Error(
              `Replay can't follow ${original.name}'s handoff to ${h?.agentName ?? h?.name ?? "an unknown agent"}. No tools were executed.`,
            );
          // Point a handoff() at the copy. Its onInvokeHandoff is project code that may reach the real world, so it doesn't run.
          return isHandoff ? h.clone({ agent: target, onInvokeHandoff: async () => target }) : target;
        });
      }
      const copy = copies.get(agent)!;
      return {
        __agentdiffRunnable: true,
        generate: async (input, run) => {
          try {
            return await runAgent(copy, input, run, {
              signal: session.controller.signal,
              ...(limits ? { maxTurns: limits.maxSteps } : {}),
            });
          } catch (err) {
            if (limits && (err as Error)?.constructor?.name === "MaxTurnsExceededError")
              session.fail("Discovery stopped at the step limit before the agent finished.");
            throw err;
          }
        },
      };
    },
  };
}
