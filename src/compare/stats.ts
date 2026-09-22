import type { RunRecord, SequenceCount, VersionStats } from "../types.ts";
import { costOf } from "./pricing.ts";
import { stepsOf } from "./steps.ts";

/** Mean of the non-null values, or null when there are none. */
export function average(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v != null);
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/** A run's path: tool calls, the checks placed between them, and "no reply" (see steps.ts). */
export function sequenceOf(record: RunRecord): string[] {
  return stepsOf(record);
}

/** Histogram of distinct paths, most common first (ties: shorter first). */
export function countSequences(records: RunRecord[]): SequenceCount[] {
  const counts = new Map<string, SequenceCount>();
  for (const r of records) {
    if (r.error != null) continue;
    const seq = sequenceOf(r);
    const key = seq.join("\u0000");
    const entry = counts.get(key);
    if (entry) entry.runs++;
    else counts.set(key, { seq, runs: 1 });
  }
  return [...counts.values()].sort((a, b) => b.runs - a.runs || a.seq.length - b.seq.length);
}

/** Aggregate the N run records for one test+version into stats. */
export function computeVersionStats(
  records: RunRecord[],
  model: string,
  mustCallTools: string[],
  grades?: number[],
): VersionStats {
  const runs = records.length;
  const errors = records.filter((r) => r.error != null).length;

  const observed = new Set<string>(mustCallTools);
  for (const r of records) {
    for (const tc of r.tool_calls ?? []) observed.add(tc.tool);
  }
  const toolCallRate: VersionStats["toolCallRate"] = {};
  for (const tool of observed) {
    const called = records.filter((r) => (r.tool_calls ?? []).some((tc) => tc.tool === tool)).length;
    toolCallRate[tool] = { called, of: runs };
  }

  const sample =
    records.find((r) => r.final_response && !r.error)?.final_response ??
    records.find((r) => r.final_response)?.final_response ??
    null;

  return {
    runs,
    errors,
    toolCallRate,
    sequences: countSequences(records),
    avgTokensInput: average(records.map((r) => r.tokens?.input ?? null)),
    avgTokensOutput: average(records.map((r) => r.tokens?.output ?? null)),
    avgCost: average(records.map((r) => costOf(model, r.tokens))),
    avgLatencyMs: average(records.map((r) => r.latency_ms)),
    avgSteps: average(records.map((r) => r.steps)),
    avgGrade: grades && grades.length ? average(grades) : null,
    gradedRuns: grades?.length ?? 0,
    sampleResponse: sample,
    sampleError: records.find((r) => r.error != null)?.error ?? null,
    replied: {
      runs: records.filter((r) => r.error == null && r.final_response?.trim()).length,
      of: records.filter((r) => r.error == null).length,
    },
  };
}

/** Filter a flat list of run records to one test + version. */
export function recordsFor(records: RunRecord[], test: string, version: "old" | "new"): RunRecord[] {
  return records.filter((r) => r.test === test && r.version === version);
}
