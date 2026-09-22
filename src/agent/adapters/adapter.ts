import type { Decision, Snapshot, ToolCall, Turn } from "../../types.ts";
import type { ToolSession } from "../replay.ts";

/** What a test gives the agent besides the new message. */
export interface RunInput {
  /** Earlier turns, oldest first. */
  conversation?: Turn[];
  /** State for the agent's tools, passed as the framework's run context. */
  context?: Record<string, unknown>;
  /**
   * A function agent's tools, answered by agentdiff: set during Braintrust
   * replay and discovery, absent in a normal run. `run.tools?.lookup ?? lookup`.
   */
  tools?: Record<string, (input: unknown) => Promise<unknown>>;
}

/** What agentdiff reads from one run, whatever framework made it. */
export interface NormalizedResult {
  readonly __agentdiffNormalized: true;
  text: string | null;
  toolCalls: ToolCall[];
  steps: number | null;
  tokens: { input: number | null; output: number | null } | null;
  /** Checks the framework reports itself (guardrails), already placed. */
  checks?: Decision[];
}

/** Anything agentdiff runs through an adapter: takes the test's input and returns a NormalizedResult. */
export interface Runnable {
  readonly __agentdiffRunnable: true;
  generate(input: string, run?: RunInput): Promise<NormalizedResult>;
}

export function isRunnable(value: unknown): value is Runnable {
  return !!value && typeof value === "object" && (value as Runnable).__agentdiffRunnable === true;
}

/**
 * A non-Mastra agent, wrapped when it is imported so the rest of agentdiff can
 * snapshot and run it. Mastra agents are used as they are.
 */
export interface AgentAdapter extends Runnable {
  readonly __agentdiffAdapter: "openai-agents" | "function";
  snapshot(): Promise<Snapshot>;
  /** Tool names, for discovery's fixture check. */
  listTools(): Promise<Record<string, unknown>>;
  /** The same agent with every tool call answered by `session` (recorded incidents, discovery). */
  withTools?(session: ToolSession, limits?: { maxSteps: number }): Promise<Runnable>;
}

export function isAdapter(value: unknown): value is AgentAdapter {
  return !!value && typeof value === "object" && "__agentdiffAdapter" in value;
}

export function isNormalized(value: unknown): value is NormalizedResult {
  return !!value && typeof value === "object" && (value as NormalizedResult).__agentdiffNormalized === true;
}

/** Tool inputs and outputs arrive as JSON text from some frameworks; keep objects as objects. */
export function parseMaybe(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
