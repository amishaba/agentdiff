// The review page's findings: each changed test's main shift, and tests that
// shifted the same way grouped under it, with the edits that mention it. Pure.
import { isCheckStep, stepLabel, stepsOf } from "../../../src/compare/steps.ts";
import {
  checkInventory,
  forbiddenCalls,
  gradeChange,
  inconclusiveChange,
  replyShift,
  toolRegressions,
  toolRateShifts,
  changeSignals,
  latencyChange,
  type GradeChange,
} from "../../../src/compare/signals.ts";
import { actedEarly, changeKind, sortedTests, type ChangeKind } from "../../../src/compare/change-kind.ts";
import { decisionShifts, shownCheckRows } from "../../../src/compare/check-rows.ts";
import { otherChanges, promptChanges } from "./model.ts";
import type { Comparison, RunRecord, TestComparison } from "../data/types.ts";

/** One way a test's behaviour moved, as a stable key, a plain title and its old → new rate. */
export interface Shift {
  key: string;
  title: string;
  old: string;
  new: string;
  /** What old and new count: "replied", "change_flight called". */
  metric: string;
  /** Tools the shift is about, for finding the edits that mention them. */
  tools: string[];
}

/** A check one version runs and the other doesn't, and how many runs it tripped in. */
export interface Tripped {
  id: string;
  side: "old" | "new";
  runs: number;
  of: number;
}

export interface ShiftRow {
  test: TestComparison;
  kind: ChangeKind;
  shift: Shift;
  grade: GradeChange | null;
  tripped: Tripped[];
}

export interface ShiftGroup {
  key: string;
  title: string;
  rows: ShiftRow[];
  /** The old → new rate when every test in the group moved by the same amount. */
  rate: { old: string; new: string } | null;
  related: { lines: { sign: "-" | "+"; text: string }[]; other: string[] };
}

const rate = (r?: { called: number; of: number }) => (r && r.of ? r.called / r.of : 0);
const fmt = (r?: { called: number; of: number }, of = 0) => (r ? `${r.called}/${r.of}` : `0/${of}`);

/** The signals that held up in both halves of the runs, or every signal when the runs weren't split. */
const settledOf = (t: TestComparison) => new Set(t.confirmation ? t.confirmation.confirmed : changeSignals(t));

/** The one shift a test is listed under: rules the test wrote first, then replies, checks, tools and grade. */
export function mainShift(c: Comparison, t: TestComparison): Shift {
  const settled = settledOf(t);
  const writeTools = c.writeTools ?? [];
  const runs = t.new.runs - t.new.errors;
  for (const f of forbiddenCalls(t))
    if (settled.has(`forbidden:${f.tool}`))
      return {
        key: `forbidden:${f.tool}`,
        title: `Calls ${f.tool}, which the test forbids`,
        old: f.oldRate,
        new: f.newRate,
        metric: `${f.tool} called`,
        tools: [f.tool],
      };
  for (const r of toolRegressions(t))
    if (settled.has(`required:${r.tool}`))
      return {
        key: `required:${r.tool}`,
        title: `Skips ${r.tool}, which the test requires`,
        old: r.oldRate,
        new: r.newRate,
        metric: `${r.tool} called`,
        tools: [r.tool],
      };
  if (settled.has("path"))
    for (const e of actedEarly(t, writeTools))
      return {
        key: `early:${e.tool}:${e.skipped.join(",")}`,
        title: `Calls ${e.tool} without ${e.skipped.join(", ")} first`,
        old: fmt(t.old.toolCallRate[e.tool], runs),
        new: fmt(t.new.toolCallRate[e.tool], runs),
        metric: `${e.tool} called`,
        tools: [e.tool, ...e.skipped],
      };
  const reply = replyShift(t);
  if (reply && settled.has("reply"))
    return reply.started
      ? { key: "reply:started", title: "Replies where it used to send nothing", ...reply, metric: "replied", tools: [] }
      : { key: "reply:stopped", title: "Sends nothing where it used to reply", ...reply, metric: "replied", tools: [] };
  for (const row of shownCheckRows(t))
    if (row.shifted && settled.has(`check:${row.id}`)) {
      const option = row.kind === "choice" ? row.new.slice(0, row.new.lastIndexOf(" ")) : "";
      const at = (s: string) => (row.kind === "choice" ? s.slice(s.lastIndexOf(" ") + 1) : s);
      const up = rateOf(at(row.new)) > rateOf(at(row.old));
      return {
        key: `check:${row.id}:${option}:${up ? "up" : "down"}`,
        title: option ? `Runs marked ${option}` : row.id,
        old: at(row.old),
        new: at(row.new),
        metric: option ? `${row.id} = ${option}` : `${row.id}: yes`,
        tools: [],
      };
    }
  for (const d of decisionShifts(t))
    if (settled.has(`decision:${d.id}`))
      return {
        key: `decision:${d.id}`,
        title: `${d.id} answers`,
        old: d.answer.old,
        new: d.answer.new,
        metric: d.id,
        tools: [],
      };
  const moved = toolRateShifts(t).filter((tool) => settled.has(`tool:${tool}`));
  if (moved.length) {
    const added = moved.filter((tool) => rate(t.new.toolCallRate[tool]) > rate(t.old.toolCallRate[tool]));
    const dropped = moved.filter((tool) => !added.includes(tool));
    const first = moved[0];
    return {
      key: `tools:${added.map((x) => `+${x}`).join("")}${dropped.map((x) => `-${x}`).join("")}`,
      title: [added.length && `Adds ${added.join(", ")}`, dropped.length && `drops ${dropped.join(", ")}`]
        .filter(Boolean)
        .join(", ")
        .replace(/^d/, "D"),
      old: fmt(t.old.toolCallRate[first], t.old.runs),
      new: fmt(t.new.toolCallRate[first], runs),
      metric: `${first} called`,
      tools: moved,
    };
  }
  const g = gradeChange(t);
  if (g?.meaningful)
    return {
      key: `grade:${g.delta < 0 ? "down" : "up"}`,
      title: g.delta < 0 ? "Scored lower by the judge" : "Scored higher by the judge",
      old: g.old.toFixed(1),
      new: g.new.toFixed(1),
      metric: "score of 5",
      tools: [],
    };
  const l = latencyChange(t);
  if (l && settled.has("latency"))
    return {
      key: `latency:${l.slower ? "up" : "down"}`,
      title: l.slower ? "Runs slower" : "Runs faster",
      old: `${(l.old / 1000).toFixed(1)}s`,
      new: `${(l.new / 1000).toFixed(1)}s`,
      metric: "average run time",
      tools: [],
    };
  return { key: "path", title: "Takes a different path", old: "", new: "", metric: "", tools: [] };
}

const rateOf = (s: string) => {
  const [a, b] = s.split("/").map(Number);
  return b ? a / b : 0;
};

/** Guardrails only one version runs that tripped in this test's runs: a removed opt-out guardrail, say. */
export function trippedChecks(c: Comparison, traces: { old: RunRecord[]; new: RunRecord[] }, t: TestComparison) {
  const inv = checkInventory(c.tests);
  const out: Tripped[] = [];
  for (const [side, refs] of [
    ["old", inv.removed],
    ["new", inv.added],
  ] as const) {
    const runs = traces[side].filter((r) => r.test === t.test && !r.error);
    for (const { id } of refs) {
      const n = runs.filter((r) => stepsOf(r).includes(`?${id}=tripped`)).length;
      if (n) out.push({ id, side, runs: n, of: runs.length });
    }
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[-\s]+/g, "_");
/** "CHANGES: …" and "CHANGES: …", or two versions of the same opening sentence: one edit, old and new. */
const lead = (s: string) => s.split(/[:.]/)[0].trim();

/** The prompt lines and settings that name a tool or check these tests moved on. */
export function relatedEdits(c: Comparison, rows: ShiftRow[]): ShiftGroup["related"] {
  // The shift's own tools and the guardrails that tripped; failing those, the tools whose use moved or whose definition changed.
  const tokens = new Set(rows.flatMap((r) => [...r.shift.tools, ...r.tripped.map((t) => t.id)]));
  if (!tokens.size) {
    const d = c.snapshotDiff;
    const touched = [...d.toolsAdded, ...d.toolsRemoved, ...(d.toolDefinitionsChanged ?? [])];
    const called = (t: TestComparison, tool: string) =>
      !!(t.old.toolCallRate[tool]?.called || t.new.toolCallRate[tool]?.called);
    for (const row of rows) {
      const settled = settledOf(row.test);
      for (const tool of toolRateShifts(row.test)) if (settled.has(`tool:${tool}`)) tokens.add(tool);
      for (const tool of touched) if (called(row.test, tool)) tokens.add(tool);
    }
  }
  const mentions = (text: string) => [...tokens].some((tok) => norm(text).includes(norm(tok)));
  const all = promptChanges(c).flatMap((g) => g.lines);
  const replies = rows[0]?.shift.key.startsWith("reply:");
  const sign = rows[0]?.shift.key === "reply:started" ? "+" : "-";
  const hit = all.filter((l) => mentions(l.text) || (replies && l.sign === sign && /\brepl(y|ies)\b/i.test(l.text)));
  const lines = all.filter(
    (l) => hit.includes(l) || hit.some((h) => h.sign !== l.sign && lead(h.text) && lead(h.text) === lead(l.text)),
  );
  return { lines, other: otherChanges(c).filter(mentions) };
}

/** Changed tests grouped by their main shift, in the order the page lists tests. Tests that didn't repeat go last. */
export function shiftGroups(c: Comparison, traces: { old: RunRecord[]; new: RunRecord[] }): ShiftGroup[] {
  const groups = new Map<string, ShiftGroup>();
  for (const t of sortedTests(c)) {
    const kind = changeKind(t, c.writeTools);
    if (kind === "same") continue;
    const shift = mainShift(c, t);
    const key = inconclusiveChange(t) ? "inconclusive" : shift.key;
    const row: ShiftRow = { test: t, kind, shift, grade: gradeChange(t), tripped: trippedChecks(c, traces, t) };
    const g = groups.get(key);
    if (g) g.rows.push(row);
    else
      groups.set(key, {
        key,
        title: key === "inconclusive" ? "Moved, but didn't repeat in both halves of the runs" : shift.title,
        rows: [row],
        rate: null,
        related: { lines: [], other: [] },
      });
  }
  const out = [...groups.values()];
  const last = out.findIndex((g) => g.key === "inconclusive");
  if (last >= 0) out.push(...out.splice(last, 1));
  for (const g of out) {
    const [first] = g.rows;
    g.rate =
      g.key !== "inconclusive" &&
      first.shift.old &&
      g.rows.every((r) => r.shift.old === first.shift.old && r.shift.new === first.shift.new)
        ? { old: first.shift.old, new: first.shift.new }
        : null;
    if (g.key !== "inconclusive") g.related = relatedEdits(c, g.rows);
  }
  return out;
}

/** A test as the comparison page's table lists it, with the edits that mention its shift; a test that didn't move has no shift. */
export interface TableRow extends Omit<ShiftRow, "shift"> {
  shift: Shift | null;
  related: ShiftGroup["related"];
}

/** Every test in the order the table lists them: changed tests next to others that moved the same way, then the rest. */
export function tableRows(c: Comparison, traces: { old: RunRecord[]; new: RunRecord[] }): TableRow[] {
  const moved = shiftGroups(c, traces).flatMap((g) => g.rows.map((r) => ({ ...r, related: g.related })));
  const same = sortedTests(c)
    .filter((t) => changeKind(t, c.writeTools) === "same")
    .map((t): TableRow => ({
      test: t,
      kind: "same",
      shift: null,
      grade: gradeChange(t),
      tripped: [],
      related: { lines: [], other: [] },
    }));
  return [...moved, ...same];
}

/** The path most of these runs took, with every check in it, and one run that took it. */
export function usualPath(runs: RunRecord[]): { steps: string[]; runs: number; of: number; run: RunRecord } | null {
  const done = runs.filter((r) => !r.error);
  if (!done.length) return null;
  const counts = new Map<string, RunRecord[]>();
  for (const r of done) {
    const key = stepsOf(r).join("\n");
    counts.set(key, [...(counts.get(key) ?? []), r]);
  }
  const [key, same] = [...counts].sort((a, b) => b[1].length - a[1].length)[0];
  return { steps: key ? key.split("\n") : [], runs: same.length, of: runs.length, run: same[0] };
}

export type StepType = "tool" | "check" | "handoff";

/** A path step as the page prints it: a tool call, a check with its answer, or a handoff to another agent. */
function stepView(step: string): { text: string; type: StepType; check: boolean } {
  if (step.startsWith("transfer_to_"))
    return { text: `to ${step.slice("transfer_to_".length)}`, type: "handoff", check: false };
  const check = isCheckStep(step);
  return { text: stepLabel(step), type: check ? "check" : "tool", check };
}

/** One line of two paths lined up: a step both took, or one only the old (-) or new (+) agent took. */
export interface PathLine {
  sign: " " | "-" | "+";
  text: string;
  type: StepType;
  check: boolean;
  /** Repeats in a row, on each side; the counts differ when both took the step a different number of times. */
  old: number;
  new: number;
}

/** Repeats in a row folded into one step with a count; the reply is left out. */
function folded(steps: string[]): { text: string; type: StepType; check: boolean; count: number }[] {
  const out: { text: string; type: StepType; check: boolean; count: number }[] = [];
  for (const step of steps) {
    const v = stepView(step);
    if (v.text === "no reply") continue;
    const last = out.at(-1);
    if (last && last.text === v.text && !v.check) last.count++;
    else out.push({ ...v, count: 1 });
  }
  return out;
}

/** Two usual paths as one diff, matched on the longest run of steps they share in order. */
export function pathDiff(oldSteps: string[], newSteps: string[]): PathLine[] {
  const a = folded(oldSteps),
    b = folded(newSteps);
  // lcs[i][j]: how many steps a[i..] and b[j..] share in order.
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i][j] = a[i].text === b[j].text ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: PathLine[] = [];
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i].text === b[j].text) {
      out.push({ sign: " ", text: a[i].text, type: a[i].type, check: a[i].check, old: a[i].count, new: b[j].count });
      i++;
      j++;
    } else if (j >= b.length || (i < a.length && lcs[i + 1][j] >= lcs[i][j + 1])) {
      out.push({ sign: "-", text: a[i].text, type: a[i].type, check: a[i].check, old: a[i].count, new: 0 });
      i++;
    } else {
      out.push({ sign: "+", text: b[j].text, type: b[j].type, check: b[j].check, old: 0, new: b[j].count });
      j++;
    }
  }
  return out;
}
