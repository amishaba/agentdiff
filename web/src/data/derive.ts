// Everything the page computes from a Dataset. Regression, grade, and
// sequence logic is the CLI's own (src/summary.ts) — the page never
// reinterprets a number the terminal already printed.
import { costOf } from "../../../src/compare/pricing.ts";
import { stepsOf } from "../../../src/compare/steps.ts";
import { gradeChange, sequenceShift, severity, testChanged, toolRegressions } from "../../../src/compare/signals.ts";
import { fmtMoney, fmtNum, fmtSequence, pctChange } from "../../../src/compare/format.ts";
import { sortedTests } from "../../../src/compare/change-kind.ts";
import type { Dataset, GradeRecord, RunRecord, TestComparison, Version } from "./types.ts";

export {
  fmtMoney,
  fmtNum,
  fmtSequence,
  gradeChange,
  pctChange,
  sequenceShift,
  severity,
  sortedTests,
  testChanged,
  toolRegressions,
};

export const VERSIONS: Version[] = ["old", "new"];

/** Runs of one test on one side, in run order. */
export function runsFor(d: Dataset, test: string, version: Version): RunRecord[] {
  return d.traces[version].filter((r) => r.test === test).sort((a, b) => a.run - b.run);
}

export function gradeFor(d: Dataset, test: string, version: Version, run: number): GradeRecord | undefined {
  return d.grades.find((g) => g.test === test && g.version === version && g.run === run);
}

/** The run's path, the same way the CLI counts paths (src/steps.ts). */
export function sequenceOf(r: RunRecord): string[] {
  return stepsOf(r);
}

/** Required tools this run never called. */
export function missingRequired(t: TestComparison, r: RunRecord): string[] {
  const called = new Set(sequenceOf(r));
  return t.mustCallTools.filter((tool) => !called.has(tool));
}

export function runCost(d: Dataset, r: RunRecord): number | null {
  const model = r.version === "old" ? d.comparison.oldSnapshot.model : d.comparison.newSnapshot.model;
  return costOf(model, r.tokens);
}

export function fmtMs(ms: number | null): string {
  if (ms == null) return "n/a";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

export function fmtDate(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

/** "1 test", "3 tests". */
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** `./agents/support-v1.ts` → `support-v1.ts` */
export function baseName(p: string): string {
  return p.split("/").pop() ?? p;
}
