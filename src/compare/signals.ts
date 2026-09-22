// Behaviour-change signals derived from a Comparison: what regressed, what
// shifted, whether a change held up in both halves. The CLI report and the web
// dashboard both read these, so a number means the same thing everywhere. Browser-safe.
import type { Comparison, DecisionStats, SequenceCount, TestComparison, VersionStats } from "../types.ts";
import { checkIdOf } from "./steps.ts";
import { pctChange, fmtSequence } from "./format.ts";
import { checkShifts, decisionShifts } from "./check-rows.ts";
import { average } from "./stats.ts";

/**
 * The share of finished runs that replied, old → new, when it moved 20+ points.
 * `started` is true when the new version replies where the old one stayed silent.
 */
export function replyShift(t: TestComparison): { old: string; new: string; started: boolean } | null {
  const o = t.old.replied;
  const n = t.new.replied;
  if (!o?.of || !n?.of) return null;
  if (Math.abs(Math.round((o.runs / o.of - n.runs / n.of) * 100)) < 20) return null;
  return { old: `${o.runs}/${o.of}`, new: `${n.runs}/${n.of}`, started: n.runs / n.of > o.runs / o.of };
}

/** A check id with where it comes from, for listing. */
export interface CheckRef {
  id: string;
  source?: DecisionStats["source"];
}

/** Checks the agent runs somewhere in one version and nowhere in the other: removed from or added to the agent. */
export function checkInventory(tests: TestComparison[]): { removed: CheckRef[]; added: CheckRef[] } {
  const asked = (side: "old" | "new") => {
    const out = new Map<string, CheckRef>();
    for (const t of tests) {
      for (const [id, d] of Object.entries(t[side].decisions ?? {}))
        if (d.runsAsking > 0 && !out.has(id)) out.set(id, { id, ...(d.source ? { source: d.source } : {}) });
    }
    return out;
  };
  const o = asked("old");
  const n = asked("new");
  return { removed: [...o.values()].filter((c) => !n.has(c.id)), added: [...n.values()].filter((c) => !o.has(c.id)) };
}

/** "`opt_out` guardrail, `needs_reply`" */
export function fmtChecks(refs: CheckRef[]): string {
  return refs
    .map((r) => `\`${r.id}\`${r.source === "guardrail" ? " guardrail" : r.source === "agent" ? " (own check)" : ""}`)
    .join(", ");
}

/** A tool the test must never call, now called in more runs: a regression. */
export function forbiddenCalls(t: TestComparison): { tool: string; oldRate: string; newRate: string }[] {
  const out: { tool: string; oldRate: string; newRate: string }[] = [];
  for (const tool of t.mustNotCallTools ?? []) {
    const o = t.old.toolCallRate[tool];
    const n = t.new.toolCallRate[tool];
    if (!o || !n) continue;
    if ((n.of ? n.called / n.of : 0) > (o.of ? o.called / o.of : 0)) {
      out.push({ tool, oldRate: `${o.called}/${o.of}`, newRate: `${n.called}/${n.of}` });
    }
  }
  return out;
}

/** A required tool whose call rate dropped is a regression. */
export function toolRegressions(t: TestComparison): { tool: string; oldRate: string; newRate: string }[] {
  const out: { tool: string; oldRate: string; newRate: string }[] = [];
  for (const tool of t.mustCallTools) {
    const o = t.old.toolCallRate[tool];
    const n = t.new.toolCallRate[tool];
    if (!o || !n) continue;
    const oldFrac = o.of ? o.called / o.of : 0;
    const newFrac = n.of ? n.called / n.of : 0;
    if (newFrac < oldFrac) {
      out.push({ tool, oldRate: `${o.called}/${o.of}`, newRate: `${n.called}/${n.of}` });
    }
  }
  return out;
}

const GRADE_NOISE_THRESHOLD = 1.0;

/** Latency counts as a change at 25%+ and a full second or more: smaller moves are network noise. */
const LATENCY_PCT = 25;
const LATENCY_MIN_MS = 1000;

/** Average run time, old → new, when it moved enough to count. */
export function latencyChange(t: TestComparison): { old: number; new: number; slower: boolean } | null {
  const o = t.old.avgLatencyMs;
  const n = t.new.avgLatencyMs;
  if (o == null || n == null || o <= 0) return null;
  if (Math.abs(n - o) < LATENCY_MIN_MS || (Math.abs(n - o) / o) * 100 < LATENCY_PCT) return null;
  return { old: o, new: n, slower: n > o };
}

export interface GradeChange {
  old: number;
  new: number;
  delta: number;
  meaningful: boolean;
}

export function gradeChange(t: TestComparison): GradeChange | null {
  if (t.old.avgGrade == null || t.new.avgGrade == null) return null;
  const delta = t.new.avgGrade - t.old.avgGrade;
  return {
    old: t.old.avgGrade,
    new: t.new.avgGrade,
    delta,
    meaningful: Math.abs(delta) > GRADE_NOISE_THRESHOLD,
  };
}

/**
 * The single most common tool-call sequence on one side, with its share of
 * runs — `{ seq, runs, of }`. Null when nothing ran successfully.
 */
export function dominantSequence(
  s: VersionStats,
  hide: readonly string[] = [],
): { seq: string[]; runs: number; of: number } | null {
  const top = comparablePaths(s, hide)[0];
  if (!top) return null;
  return { seq: top.seq, runs: top.runs, of: s.runs - s.errors };
}

/**
 * A version's paths without the steps of the given checks, re-counted: runs
 * that differ only in a check the other version doesn't have are one path.
 */
export function comparablePaths(s: VersionStats, hide: readonly string[] = []): SequenceCount[] {
  if (!hide.length) return s.sequences ?? [];
  const counts = new Map<string, SequenceCount>();
  for (const p of s.sequences ?? []) {
    const seq = p.seq.filter((step) => !hide.includes(checkIdOf(step) ?? ""));
    const key = seq.join(" ");
    const entry = counts.get(key);
    if (entry) entry.runs += p.runs;
    else counts.set(key, { seq, runs: p.runs });
  }
  return [...counts.values()].sort((a, b) => b.runs - a.runs || a.seq.length - b.seq.length);
}

/**
 * Did the agent's *path* change — not just whether each tool fired, but the
 * order it fired in? True when the dominant sequences differ, or when the
 * dominant sequence lost its majority.
 */
export function sequenceShift(t: TestComparison): { old: string; new: string } | null {
  const o = dominantSequence(t.old, t.oneSidedChecks);
  const n = dominantSequence(t.new, t.oneSidedChecks);
  if (!o || !n) return null;
  const sameSeq = o.seq.join(" ") === n.seq.join(" ");
  const oMajority = o.of ? o.runs / o.of >= 0.5 : false;
  const nMajority = n.of ? n.runs / n.of >= 0.5 : false;
  if (sameSeq && oMajority === nMajority) return null;
  return {
    old: `${fmtSequence(o.seq)} (${o.runs}/${o.of})`,
    new: `${fmtSequence(n.seq)} (${n.runs}/${n.of})`,
  };
}

/** True when any tool's call rate swung by at least 20% of runs. */
export function toolRateShifts(t: TestComparison): string[] {
  const tools = new Set([...Object.keys(t.old.toolCallRate), ...Object.keys(t.new.toolCallRate)]);
  const out: string[] = [];
  for (const tool of tools) {
    const o = t.old.toolCallRate[tool];
    const n = t.new.toolCallRate[tool];
    const or = o && o.of ? o.called / o.of : 0;
    const nr = n && n.of ? n.called / n.of : 0;
    // Compare in whole points: 5/5 → 4/5 is exactly 20, not 19.999…
    if (Math.abs(Math.round((or - nr) * 100)) >= 20) out.push(tool);
  }
  return out;
}

/** Worst first: most skipped required tools, then shifted outcome checks, then biggest grade drop. */
export function severity(t: TestComparison): number {
  const regs = toolRegressions(t).length + forbiddenCalls(t).length + (replyShift(t) ? 1 : 0);
  const g = gradeChange(t);
  const drop = g && g.meaningful && g.delta < 0 ? -g.delta : 0;
  const score = regs * 10 + (checkShifts(t).length + decisionShifts(t).length) * 5 + drop;
  // A change that didn't repeat sorts below every one that did.
  return inconclusiveChange(t) ? score / 100 : score;
}

export interface FailedSide {
  side: "old" | "new";
  runs: number;
  /** The first error message from that side. */
  error: string | null;
}

/**
 * Sides where every single run errored. That is a broken agent, key, or API —
 * not a behaviour change — so nothing built on the numbers should be shown.
 */
export function failedSides(c: Comparison): FailedSide[] {
  const out: FailedSide[] = [];
  for (const side of ["old", "new"] as const) {
    let runs = 0;
    let errors = 0;
    for (const t of c.tests) {
      runs += t[side].runs;
      errors += t[side].errors;
    }
    if (runs > 0 && errors === runs) {
      out.push({ side, runs, error: c.tests.map((t) => t[side].sampleError).find((e) => e != null) ?? null });
    }
  }
  return out;
}

/**
 * Each observable way a test's behaviour moved, as a stable key: `required:<tool>`,
 * `forbidden:<tool>`, `reply`, `tool:<tool>`, `path`, `check:<id>`,
 * `decision:<id>`, `grade`, `cost`, `latency`, `errors`. Two comparisons of the same test
 * can be checked for the same movement by comparing keys.
 */
export function changeSignals(t: TestComparison): string[] {
  const out = new Set<string>();
  for (const r of toolRegressions(t)) out.add(`required:${r.tool}`);
  for (const r of forbiddenCalls(t)) out.add(`forbidden:${r.tool}`);
  if (replyShift(t)) out.add("reply");
  for (const tool of toolRateShifts(t)) out.add(`tool:${tool}`);
  if (sequenceShift(t)) out.add("path");
  for (const r of checkShifts(t)) out.add(`check:${r.id}`);
  for (const r of decisionShifts(t)) out.add(`decision:${r.id}`);
  if (gradeChange(t)?.meaningful) out.add("grade");
  const costPct = pctChange(t.old.avgCost, t.new.avgCost);
  if (costPct && costPct !== "+0%" && Math.abs(parseFloat(costPct)) >= 10) out.add("cost");
  if (latencyChange(t)) out.add("latency");
  if (t.old.errors !== t.new.errors) out.add("errors");
  return [...out];
}

/** Did this test's behaviour change in any observable way? */
export function testChanged(t: TestComparison): boolean {
  return changeSignals(t).length > 0;
}

/**
 * A change that held up: it moved in both halves of the runs and not between
 * the old agent's own halves. Comparisons without a confirmation (saved
 * before it existed, or one run per test) count any movement.
 */
export function confirmedChange(t: TestComparison): boolean {
  return t.confirmation ? t.confirmation.confirmed.length > 0 : testChanged(t);
}

/**
 * Run time moves with the provider's load and cost with the tokens a run
 * happened to spend: on their own they make no test inconclusive. A change
 * in either that holds up in both halves still counts.
 */
const RUN_TIME_AND_COST = new Set(["latency", "cost"]);

/** Behaviour moved overall, but not in both halves, or no more than the old agent moves against itself. */
export function inconclusiveChange(t: TestComparison): boolean {
  return (
    !!t.confirmation && !t.confirmation.confirmed.length && changeSignals(t).some((s) => !RUN_TIME_AND_COST.has(s))
  );
}

/** Tests where the old agent's two halves differed from each other: how noisy this setup is. */
export function noisyTests(c: Comparison): TestComparison[] {
  return c.tests.filter((t) => t.confirmation?.noise.length);
}

/** How much the old agent moved against itself, when the runs were split in two: "noise · …". */
export function noiseLine(c: Comparison): string {
  if (!c.tests.some((t) => t.confirmation)) return "";
  const noisy = noisyTests(c);
  if (!noisy.length) return "noise · the old agent against itself: no test moved";
  // A few named, the rest counted: a long list would bury the report's headline.
  const named = noisy.slice(0, 3).map((t) => `${t.test} (${t.confirmation!.noise.join(", ")})`);
  const more = noisy.length > named.length ? `, and ${noisy.length - named.length} more` : "";
  return `noise · the old agent against itself moved in ${noisy.length} of ${c.tests.length}: ${named.join(", ")}${more}`;
}

/** Stages that were blocked or failed, e.g. "judge blocked: … · explain blocked: …"; empty when all ran. */
export function incompleteStages(c: Comparison): string {
  return (c.stages ?? [])
    .filter((s) => s.status === "blocked" || s.status === "error")
    .map((s) => `${s.stage} ${s.status}: ${s.detail}`)
    .join(" · ");
}

/** Average cost per run across all tests, before and after, with the % change. */
export function overallCost(c: Comparison): { old: number | null; new: number | null; pct: string | null } {
  const oldAvg = average(c.tests.map((t) => t.old.avgCost));
  const newAvg = average(c.tests.map((t) => t.new.avgCost));
  return { old: oldAvg, new: newAvg, pct: pctChange(oldAvg, newAvg) };
}

/** Required-tool regressions summed over every test. */
export function countSkippedTools(c: Comparison): number {
  return c.tests.reduce((sum, t) => sum + toolRegressions(t).length, 0);
}

/** Forbidden-tool calls summed over every test. */
export function countForbiddenCalls(c: Comparison): number {
  return c.tests.reduce((sum, t) => sum + forbiddenCalls(t).length, 0);
}
