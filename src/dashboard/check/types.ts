import type { HealthResult } from "../../health/types.ts";

/** A saved `agentdiff check`, as the run picker lists it. */
export interface CheckRunSummary {
  dir: string;
  agentName: string;
  createdAt: string;
  tests: number;
  steady: number;
  runsPerTest: number;
}

/** One run of a test as the page shows it: what it did through its tools, what it said, and its grade. */
export interface CheckRunView {
  run: number;
  error: string | null;
  reply: string | null;
  score: number | null;
  latencyMs: number | null;
  /** Inputs and outputs as JSON text, clipped. */
  toolCalls: { tool: string; input: string; output: string }[];
}

/** One saved check with every test's runs. */
export interface CheckRun extends HealthResult {
  dir: string;
  /** By test name, in run order. */
  runs: Record<string, CheckRunView[]>;
}
