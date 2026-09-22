import type { ReplayResponse, RunRecord, ToolCall } from "../types.ts";
import { strictCanonical } from "../lib/canonical.ts";
import type { AnyAgent } from "./load.ts";
import { isAdapter } from "./adapters/adapter.ts";

export class ReplaySession {
  failure: string | null = null;
  calls: ToolCall[] = [];
  missing: NonNullable<RunRecord["replay"]>["missing"] = [];
  readonly controller = new AbortController();
  private counts = new Map<string, number>();
  constructor(private responses: ReplayResponse[]) {}

  fail(message: string): never {
    this.failure = message;
    this.controller.abort();
    throw new Error(message);
  }

  execute(tool: string, input: unknown): unknown {
    if (this.controller.signal.aborted) throw new Error("Replay blocked by a missing tool response.");
    const key = `${tool}:${strictCanonical(input)}`;
    const occurrence = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, occurrence);
    const response = this.responses.find(
      (r) => r.tool === tool && r.occurrence === occurrence && strictCanonical(r.input) === strictCanonical(input),
    );
    this.calls.push({
      tool,
      input: structuredClone(input),
      output: response ? structuredClone(response.output) : null,
    });
    if (!response) {
      this.missing.push({ tool, input: structuredClone(input), occurrence });
      this.controller.abort();
      throw new Error(`Missing test response for ${tool} (call ${occurrence}). Supply it in the incident review.`);
    }
    return structuredClone(response.output);
  }
}

/**
 * A run's tool calls when a session answered them. The framework's own record
 * also has the handoffs, the agent behind each call and when it started, so
 * it is used when every tool call in it was answered by the session, in
 * order, with the session's input and output. Otherwise the session's calls
 * are the truth.
 */
export function answeredCalls(reported: ToolCall[], answered: ToolCall[]): ToolCall[] {
  const out: ToolCall[] = [];
  let next = 0;
  for (const call of reported) {
    const a = answered[next];
    if (a && a.tool === call.tool) {
      out.push({ ...call, input: a.input, output: a.output });
      next++;
    } else if (call.tool.startsWith("transfer_to_")) out.push(call);
    else return answered;
  }
  return next === answered.length ? out : answered;
}

export interface ToolSession {
  controller: AbortController;
  /** Every call answered so far, in order. */
  calls: ToolCall[];
  /** Why the session stopped the run, once it has. */
  failure: string | null;
  execute(tool: string, input: unknown): unknown | Promise<unknown>;
  fail(message: string): never;
}

/** Only a known, plain Mastra agent is eligible. A fresh instance prevents shared
 * mock queues, production memory, exporters, or tool executors from carrying over.
 * importAgent verifies the installed version before this path is available. */
export async function replayAgent(
  original: AnyAgent,
  session: ToolSession,
  limits?: { maxSteps: number },
): Promise<AnyAgent> {
  if (isAdapter(original)) {
    if (!original.withTools)
      throw new Error(
        "Replay needs an agent framework agentdiff can swap tools in. A plain function agent runs its own tools.",
      );
    return original.withTools(session, limits);
  }
  if (!original.__agentdiffReplaySupported)
    throw new Error(
      "Replay supports @mastra/core 1.63.2 and later 1.x versions. Other versions need a verified adapter.",
    );
  if (original.constructor.name !== "Agent" || Object.hasOwn(original, "generate"))
    throw new Error("Custom agent execution needs a verified replay adapter.");
  const unsupported: Array<[string, unknown]> = [
    ["memory", await original.getMemory()],
    ["workspace", await original.getWorkspace()],
    ["subagents", await original.listAgents()],
    ["workflows", await original.listWorkflows()],
    ["input processors", await original.listConfiguredInputProcessors()],
    ["output processors", await original.listConfiguredOutputProcessors()],
    ["error processors", await original.listErrorProcessors()],
    ["tool hooks", original.getConfiguredToolHooks()],
    ["background tasks", original.getBackgroundTasksConfig()],
    ["goal", original.__getGoalConfig()],
    ["editor overrides", original.__getEditorConfig()],
    ["durable execution", original.durable],
    ["tool payload transforms", original.getToolPayloadTransform()],
    ["browser", original.browser],
    ["request context", original.requestContextSchema],
  ];
  const collections = new Set(["subagents", "workflows", "input processors", "output processors", "error processors"]);
  for (const [name, value] of unsupported) {
    if (value && (!collections.has(name) || typeof value !== "object" || Object.keys(value).length))
      throw new Error(`Replay needs an adapter for this agent's ${name}. No tools were executed.`);
  }
  const defaults = (await original.getDefaultOptions()) ?? {};
  const allowed = new Set(["maxSteps", "modelSettings", "toolChoice", "maxRetries"]);
  for (const key of Object.keys(defaults))
    if (!allowed.has(key)) throw new Error(`Replay cannot safely restore the agent option ${key} yet.`);
  const tools = await original.listTools({ resolveWebSearch: false });
  const mocked: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(tools ?? {}) as Array<[string, any]>) {
    if (!tool.inputSchema || typeof tool.execute !== "function" || tool.type === "provider-defined")
      throw new Error(`Tool ${name} needs a supported local tool schema for replay.`);
    if (tool.onInputAvailable || tool.onOutput || tool.hooks || tool.requireApproval)
      throw new Error(`Tool ${name} has execution hooks or approval requirements that need a replay adapter.`);
    if (tool.outputSchema && typeof tool.outputSchema.safeParseAsync !== "function")
      throw new Error(`Tool ${name} needs a Zod output schema for replay validation.`);
    // Copy only the schema/description. Never retain execution hooks or providers.
    mocked[name] = {
      id: tool.id ?? name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      execute: async (input: unknown) => {
        const output = await session.execute(name, input);
        if (tool.outputSchema) {
          const result = await tool.outputSchema.safeParseAsync(output);
          if (!result.success)
            session.fail(
              `Test response for ${name} does not match this version's output schema. Update the saved response before retrying.`,
            );
        }
        return output;
      },
    };
  }
  const AgentConstructor = original.constructor as new (config: Record<string, unknown>) => AnyAgent;
  const instance = new AgentConstructor({
    id: original.id,
    name: original.name,
    instructions: await original.getInstructions(),
    model: await original.getModel(),
    tools: mocked,
    defaultOptions: defaults,
    maxRetries: original.maxRetries,
  });
  return {
    generate: async (input: unknown, options: Record<string, unknown> = {}) => {
      const result = await instance.generate(input, {
        ...options,
        abortSignal: session.controller.signal,
        ...(limits ? { maxSteps: Math.min(defaults.maxSteps ?? limits.maxSteps, limits.maxSteps) } : {}),
      });
      if (limits && result.finishReason === "tool-calls")
        session.fail("Discovery stopped at the step limit before the agent finished.");
      return result;
    },
  };
}
