import { canonical } from "../lib/canonical.ts";
import { stepsOf } from "../compare/steps.ts";
import type { RunRecord } from "../types.ts";
import type { BehaviorDifference, CaseResult, Experiment, Pattern } from "./types.ts";

function dominant(records: RunRecord[], args: boolean): Pattern | null {
  if (!records.length || records.some((record) => record.error !== null)) return null;
  const groups = new Map<string, Pattern>();
  for (const record of records) {
    // The path is the one the report reads: tool calls, the checks between them, and "no reply".
    const calls = args
      ? record.tool_calls.map((call) => ({ tool: call.tool, input: call.input }))
      : stepsOf(record).map((tool) => ({ tool }));
    const key = canonical(calls);
    const pattern = groups.get(key) ?? { calls, count: 0, total: records.length };
    pattern.count++;
    groups.set(key, pattern);
  }
  const top = [...groups.values()].sort((a, b) => b.count - a.count)[0];
  // A descriptive repeatability rule, not a statistical significance claim.
  return top.count / top.total >= 0.8 ? top : null;
}

export function behaviorDifference(old: RunRecord[], current: RunRecord[]): BehaviorDifference | null {
  for (const args of [false, true]) {
    const a = dominant(old, args);
    const b = dominant(current, args);
    if (a && b && canonical(a.calls) !== canonical(b.calls)) {
      const kind = args ? "arguments" : "sequence";
      return { kind, old: a, new: b, key: canonical({ kind, old: a.calls, new: b.calls }) };
    }
  }
  return null;
}

export function experimentStatus(cases: CaseResult[]): Experiment["status"] {
  if (cases.every((c) => [...c.old, ...c.new].every((r) => r.error !== null))) return "blocked";
  if (cases.some((c) => c.difference)) return "observed";
  if (cases.some((c) => [...c.old, ...c.new].some((r) => r.error !== null))) return "inconclusive";
  const stable = cases.every((c) => dominant(c.old, true) && dominant(c.new, true));
  return stable ? "same" : "inconclusive";
}

export function reproducedCases(screen: Experiment, confirmation: Experiment): number[] {
  return screen.cases.flatMap((c, index) =>
    c.difference && c.difference.key === confirmation.cases[index].difference?.key ? [index] : [],
  );
}

export function findingKey(experiment: Experiment): string {
  return canonical(experiment.cases.map((c) => c.difference?.key ?? null));
}
