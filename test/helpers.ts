// Tiny builders so a test reads as the scenario it checks, not as JSON.
import { diffSnapshots } from "../src/compare/snapshot-diff.ts";
import type { Comparison, RunRecord, Snapshot, TestComparison, VersionStats } from "../src/types.ts";

let runCounter = 0;

/** A successful run that called `tools` in order. */
export function run(tools: string[], over: Partial<RunRecord> = {}): RunRecord {
  return {
    test: "t",
    version: "new",
    run: ++runCounter,
    input: "hi",
    tool_calls: tools.map((tool) => ({ tool, input: null, output: null })),
    final_response: "ok",
    steps: tools.length + 1,
    tokens: { input: 1000, output: 100 },
    latency_ms: 500,
    error: null,
    ...over,
  };
}

export function failedRun(message = "boom"): RunRecord {
  return run([], { final_response: null, steps: null, tokens: null, latency_ms: null, error: message });
}

/** Stats for a side, given how many of `runs` runs called each tool. */
export function side(
  rates: Record<string, number>,
  over: Partial<VersionStats> & { runs?: number } = {},
): VersionStats {
  const runs = over.runs ?? 5;
  const toolCallRate: VersionStats["toolCallRate"] = {};
  for (const [tool, called] of Object.entries(rates)) toolCallRate[tool] = { called, of: runs };
  return {
    runs,
    errors: 0,
    toolCallRate,
    sequences: [],
    avgTokensInput: null,
    avgTokensOutput: null,
    avgCost: null,
    avgLatencyMs: null,
    avgSteps: null,
    avgGrade: null,
    gradedRuns: 0,
    sampleResponse: null,
    sampleError: null,
    ...over,
  };
}

export function test(over: Partial<TestComparison> = {}): TestComparison {
  return {
    test: "refund",
    mustCallTools: [],
    old: side({}),
    new: side({}),
    ...over,
  };
}

export function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    name: "support-agent",
    instructions: "Be helpful.\nAlways look up the customer first.\n",
    model: "gpt-5.4",
    tools: ["lookup_customer", "refund_customer"],
    workflows: [],
    settings: { maxSteps: 5 },
    ...over,
  };
}

/** A two-file comparison; the snapshot diff is derived from the snapshots given. */
export function comparison(over: Partial<Comparison> = {}): Comparison {
  const oldSnapshot = over.oldSnapshot ?? snapshot();
  const newSnapshot = over.newSnapshot ?? snapshot();
  return {
    agentName: "support-agent",
    oldFile: "./agents/support-v1.ts",
    newFile: "./agents/support-v2.ts",
    runsPerTest: 5,
    oldSnapshot,
    newSnapshot,
    snapshotDiff: diffSnapshots(oldSnapshot, newSnapshot),
    tests: [],
    ...over,
  };
}
