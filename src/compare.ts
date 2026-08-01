import { diffLines } from "diff";
import type { RunRecord, Snapshot, SnapshotDiff, VersionStats } from "./types.ts";
import { costOf } from "./pricing.ts";

function avg(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v != null);
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
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

  const toolCallRate: VersionStats["toolCallRate"] = {};
  for (const tool of mustCallTools) {
    const called = records.filter((r) => r.tool_calls.some((tc) => tc.tool === tool)).length;
    toolCallRate[tool] = { called, of: runs };
  }

  const sample = records.find((r) => r.final_response && !r.error)?.final_response
    ?? records.find((r) => r.final_response)?.final_response
    ?? null;

  return {
    runs,
    errors,
    toolCallRate,
    avgTokensInput: avg(records.map((r) => r.tokens?.input ?? null)),
    avgTokensOutput: avg(records.map((r) => r.tokens?.output ?? null)),
    avgCost: avg(records.map((r) => costOf(model, r.tokens))),
    avgLatencyMs: avg(records.map((r) => r.latency_ms)),
    avgSteps: avg(records.map((r) => r.steps)),
    avgGrade: grades && grades.length ? avg(grades) : null,
    gradedRuns: grades?.length ?? 0,
    sampleResponse: sample,
  };
}

/** Build a compact +/- diff of only the changed lines between two prompts. */
export function diffInstructions(oldText: string, newText: string): string {
  const parts = diffLines(oldText || "", newText || "");
  const out: string[] = [];
  for (const part of parts) {
    if (!part.added && !part.removed) continue;
    const prefix = part.added ? "+ " : "- ";
    for (const line of part.value.split("\n")) {
      if (line.length === 0) continue;
      out.push(prefix + line);
    }
  }
  return out.join("\n");
}

export function diffSnapshots(oldSnap: Snapshot, newSnap: Snapshot): SnapshotDiff {
  const oldTools = new Set(oldSnap.tools);
  const newTools = new Set(newSnap.tools);

  const toolsAdded = newSnap.tools.filter((t) => !oldTools.has(t));
  const toolsRemoved = oldSnap.tools.filter((t) => !newTools.has(t));

  const oldWorkflows = new Set(oldSnap.workflows);
  const newWorkflows = new Set(newSnap.workflows);

  const workflowsAdded = newSnap.workflows.filter((w) => !oldWorkflows.has(w));
  const workflowsRemoved = oldSnap.workflows.filter((w) => !newWorkflows.has(w));

  const keys = new Set([...Object.keys(oldSnap.settings), ...Object.keys(newSnap.settings)]);
  const settingsChanged: SnapshotDiff["settingsChanged"] = [];
  for (const key of keys) {
    const a = oldSnap.settings[key];
    const b = newSnap.settings[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      settingsChanged.push({ key, old: a ?? null, new: b ?? null });
    }
  }

  return {
    instructionsDiff: diffInstructions(oldSnap.instructions, newSnap.instructions),
    toolsAdded,
    toolsRemoved,
    workflowsAdded,
    workflowsRemoved,
    settingsChanged,
  };
}

/** Filter a flat list of run records to one test + version. */
export function recordsFor(records: RunRecord[], test: string, version: "old" | "new"): RunRecord[] {
  return records.filter((r) => r.test === test && r.version === version);
}
