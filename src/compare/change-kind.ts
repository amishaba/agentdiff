// One label per test (rule broken, worse, better, different, inconclusive,
// same) and the order a reader wants the tests in. Browser-safe.
import type { Comparison, TestComparison, VersionStats } from "../types.ts";
import { checkIdOf, isCheckStep } from "./steps.ts";
import {
  forbiddenCalls,
  toolRegressions,
  gradeChange,
  dominantSequence,
  severity,
  changeSignals,
  confirmedChange,
  inconclusiveChange,
} from "./signals.ts";

/** The tests in the order a reader wants them: regressions at the top. */
export function sortedTests(c: Comparison): TestComparison[] {
  const rank = (t: TestComparison) => CHANGE_KINDS.indexOf(changeKind(t, c.writeTools));
  return [...c.tests].sort((a, b) => rank(a) - rank(b) || severity(b) - severity(a));
}

/** Kinds of change, most serious first. */
export const CHANGE_KINDS = ["rule", "worse", "better", "different", "inconclusive", "same"] as const;

export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** What a label is built from: the confirmed signals when the runs were checked in halves. */
function settledSignals(t: TestComparison): string[] {
  return t.confirmation ? t.confirmation.confirmed : changeSignals(t);
}

/** A tool call or a check, without the check's answer. */
function stepId(step: string): string {
  return isCheckStep(step) ? checkIdOf(step)! : step;
}

/**
 * Write tools the new agent now calls without steps that came before them in
 * the old agent's usual path, e.g. `charge` without `check_trip_policy`
 * first. Read from the most common path on each side; a check only one
 * version has is left out, since it is reported once as added or removed.
 */
export function actedEarly(t: TestComparison, writeTools: readonly string[]): { tool: string; skipped: string[] }[] {
  const o = dominantSequence(t.old, t.oneSidedChecks);
  const n = dominantSequence(t.new, t.oneSidedChecks);
  if (!o || !n) return [];
  const out: { tool: string; skipped: string[] }[] = [];
  for (const tool of writeTools) {
    const oi = o.seq.indexOf(tool);
    const ni = n.seq.indexOf(tool);
    if (oi < 0 || ni < 0) continue;
    const before = new Set(n.seq.slice(0, ni).map(stepId));
    const skipped = [...new Set(o.seq.slice(0, oi).map(stepId))].filter((s) => s !== tool && !before.has(s));
    if (skipped.length) out.push({ tool, skipped });
  }
  return out;
}

/**
 * Rules the new agent broke, as plain phrases. Only settled signals count:
 * a forbidden tool called more often, a required tool skipped, a write tool
 * called more often, or a write tool called without the steps that used to
 * come before it.
 */
export function ruleBreaks(t: TestComparison, writeTools: readonly string[] = []): string[] {
  const settled = new Set(settledSignals(t));
  const out: string[] = [];
  for (const f of forbiddenCalls(t))
    if (settled.has(`forbidden:${f.tool}`)) out.push(`calls \`${f.tool}\` (forbidden) ${f.oldRate} → ${f.newRate}`);
  for (const r of toolRegressions(t))
    if (settled.has(`required:${r.tool}`)) out.push(`skips \`${r.tool}\` (required) ${r.oldRate} → ${r.newRate}`);
  for (const tool of writeTools) {
    // A forbidden tool is counted above; a required one being called more often is the test passing more often.
    if (!settled.has(`tool:${tool}`) || (t.mustNotCallTools ?? []).includes(tool) || t.mustCallTools.includes(tool))
      continue;
    const o = t.old.toolCallRate[tool],
      n = t.new.toolCallRate[tool];
    const rate = (x?: { called: number; of: number }) => (x && x.of ? x.called / x.of : 0);
    if (rate(n) > rate(o))
      out.push(`calls \`${tool}\` more often ${o ? `${o.called}/${o.of}` : "0"} → ${n!.called}/${n!.of}`);
  }
  out.push(...earlyActions(t, writeTools));
  return out;
}

/** The settled acted-early rule breaks as phrases: "`charge` without `check_trip_policy` first". */
export function earlyActions(t: TestComparison, writeTools: readonly string[] = []): string[] {
  if (!settledSignals(t).includes("path")) return [];
  return actedEarly(t, writeTools).map(
    (e) => `\`${e.tool}\` without ${e.skipped.map((s) => `\`${s}\``).join(", ")} first`,
  );
}

/** The share of runs where the built-in `failure_type` check found nothing wrong. */
function cleanShare(s: VersionStats): number | null {
  const f = s.checks?.failure_type;
  return f && f.kind === "choice" && f.of ? (f.counts.none ?? 0) / f.of : null;
}

/** Worse or better, from the settled grade and the runs `failure_type` found nothing wrong with. */
function outcome(t: TestComparison, settled: Set<string>): "worse" | "better" | null {
  let worse = false;
  let better = false;
  const g = gradeChange(t);
  if (g?.meaningful && settled.has("grade")) {
    if (g.delta < 0) worse = true;
    else better = true;
  }
  const o = cleanShare(t.old);
  const n = cleanShare(t.new);
  if (o != null && n != null && settled.has("check:failure_type") && o !== n) {
    if (n < o) worse = true;
    else better = true;
  }
  // More runs that errored is worse whatever the grades say: those runs never answered.
  if (settled.has("errors") && t.new.errors !== t.old.errors) {
    if (t.new.errors > t.old.errors) worse = true;
    else better = true;
  }
  return worse ? "worse" : better ? "better" : null;
}

/**
 * One label per test, most serious first: broke a rule, worse, better, a
 * different path to the same outcome, inconclusive (moved, but didn't repeat
 * or no more than the old agent moves against itself), or the same.
 */
export function changeKind(t: TestComparison, writeTools: readonly string[] = []): ChangeKind {
  if (inconclusiveChange(t)) return "inconclusive";
  if (!confirmedChange(t)) return "same";
  if (ruleBreaks(t, writeTools).length) return "rule";
  return outcome(t, new Set(settledSignals(t))) ?? "different";
}
