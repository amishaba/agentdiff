import { checkStats } from "../grade/checks.ts";
import { decisionStats } from "../agent/decisions.ts";
import type { GradeResult } from "../grade/grader.ts";
import { changeSignals, checkInventory, confirmedChange, inconclusiveChange } from "./signals.ts";
import { computeVersionStats, recordsFor } from "./stats.ts";
import type {
  CheckResult,
  Confirmation,
  RunRecord,
  TestComparison,
  TestFile,
  Version,
  VersionStats,
} from "../types.ts";

export type Side = { runs: RunRecord[]; model: string };
export type Verdicts = { grades: GradeResult[]; checks: CheckResult[] };

function withChecks(
  stats: VersionStats,
  checks: VersionStats["checks"],
  decisions: VersionStats["decisions"],
): VersionStats {
  return { ...stats, ...(checks ? { checks } : {}), ...(decisions ? { decisions } : {}) };
}

/** Stats for one set of runs, counting only those runs' grades and check answers. */
function statsFor(t: TestFile, side: Side, { grades, checks }: Verdicts): VersionStats {
  const ids = new Set(side.runs.map((r) => `${r.version}:${r.run}`));
  const mine = (x: { test: string; version: Version; run: number }) =>
    x.test === t.name && ids.has(`${x.version}:${x.run}`);
  const scores = grades.filter(mine).map((g) => g.score);
  // checkStats reads one version's answers; these runs may come from either, so file them under one.
  const answers = checks.filter(mine).map((c) => ({ ...c, version: "old" as const }));
  const watched = [...(t.must_call_tools ?? []), ...(t.must_not_call_tools ?? [])];
  return withChecks(
    computeVersionStats(side.runs, side.model, watched, scores.length ? scores : undefined),
    checkStats(t, "old", answers),
    decisionStats(side.runs),
  );
}

export function compareSides(t: TestFile, old: Side, neu: Side, verdicts: Verdicts): TestComparison {
  const mustNot = t.must_not_call_tools ?? [];
  return {
    test: t.name,
    input: t.input,
    gradingCriteria: t.grading_criteria,
    mustCallTools: t.must_call_tools ?? [],
    ...(mustNot.length ? { mustNotCallTools: mustNot } : {}),
    old: statsFor(t, old, verdicts),
    new: statsFor(t, neu, verdicts),
  };
}

/**
 * Split each side's runs into two halves. A signal is confirmed when it moved
 * old → new in both halves, and not between the old agent's own two halves:
 * a change one lucky run can produce doesn't count.
 */
export function confirm(
  t: TestFile,
  full: TestComparison,
  old: Side,
  neu: Side,
  verdicts: Verdicts,
  runsPerTest: number,
): Confirmation {
  const half = Math.ceil(runsPerTest / 2);
  const split = (s: Side): [Side, Side] => [
    { ...s, runs: s.runs.filter((r) => r.run <= half) },
    { ...s, runs: s.runs.filter((r) => r.run > half) },
  ];
  const [oldA, oldB] = split(old);
  const [newA, newB] = split(neu);
  const signals = (a: Side, b: Side) =>
    changeSignals({ ...compareSides(t, a, b, verdicts), oneSidedChecks: full.oneSidedChecks });
  const first = signals(oldA, newA);
  const second = signals(oldB, newB);
  const noise = signals(oldA, oldB);
  const confirmed = changeSignals(full).filter((s) => first.includes(s) && second.includes(s) && !noise.includes(s));
  return { first, second, noise, confirmed };
}

/**
 * Every test's comparison from saved runs and verdicts: the stats for each
 * side, the checks only one version has (listed once, not counted per test),
 * and, with 2+ runs per test, the two-half confirmation. `compare` and
 * `report` both build tests this way.
 */
export function compareTests(
  tests: TestFile[],
  old: { records: RunRecord[]; model: string },
  neu: { records: RunRecord[]; model: string },
  verdicts: Verdicts,
  runsPerTest: number,
): TestComparison[] {
  const oldSide = (t: TestFile) => ({ runs: recordsFor(old.records, t.name, "old"), model: old.model });
  const newSide = (t: TestFile) => ({ runs: recordsFor(neu.records, t.name, "new"), model: neu.model });
  const out = tests.map((t) => compareSides(t, oldSide(t), newSide(t), verdicts));
  const inventory = checkInventory(out);
  const oneSided = [...inventory.removed, ...inventory.added].map((r) => r.id);
  if (oneSided.length) for (const t of out) t.oneSidedChecks = oneSided;
  if (runsPerTest >= 2)
    tests.forEach((t, i) => {
      out[i].confirmation = confirm(t, out[i], oldSide(t), newSide(t), verdicts, runsPerTest);
    });
  return out;
}

export function confirmationSummary(tests: TestComparison[]): string {
  const changed = tests.filter(confirmedChange).length;
  const unsure = tests.filter(inconclusiveChange).length;
  const noisy = tests.filter((t) => t.confirmation?.noise.length).length;
  const confirmed = tests.some((t) => t.confirmation);
  if (!confirmed) return `${changed} changed (one run per test, so nothing is confirmed)`;
  return `${changed} changed, ${unsure} inconclusive; the old agent moved against itself in ${noisy}`;
}
