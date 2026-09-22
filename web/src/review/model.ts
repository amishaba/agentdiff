// What the review page shows, derived from a saved comparison. Pure functions:
// the page renders them and the tests check them.
import { checkIdOf, isCheckStep, NO_REPLY, stepsOf } from "../../../src/compare/steps.ts";
import { canonical } from "../../../src/lib/canonical.ts";
import { foldedSteps, stepText } from "./tree.ts";
import {
  checkInventory,
  confirmedChange,
  dominantSequence,
  forbiddenCalls,
  gradeChange,
  inconclusiveChange,
  noisyTests,
  replyShift,
  toolRegressions,
} from "../../../src/compare/signals.ts";
import {
  CHANGE_KINDS,
  changeKind,
  earlyActions,
  ruleBreaks,
  sortedTests,
  type ChangeKind,
} from "../../../src/compare/change-kind.ts";
import { pctChange } from "../../../src/compare/format.ts";
import { shownCheckRows } from "../../../src/compare/check-rows.ts";
import type { Comparison, GradeRecord, RunRecord, TestComparison, Version } from "../data/types.ts";

/**
 * How one run looks next to the old agent. An old run is "old" unless it
 * errored. A new run broke a rule (called a forbidden tool, skipped a required
 * one, called a write tool the old agent's usual path never did, or ran a
 * write tool without steps that used to come first), graded low, followed the
 * old agent's usual path, or took a different one.
 */
export type RunStatus = "old" | "rule" | "low" | "same" | "different" | "error";

/** A path step as its tool name or check id, without the check's answer. */
const stepId = (step: string) => (isCheckStep(step) ? checkIdOf(step)! : step);

export function runStatus(t: TestComparison, r: RunRecord, writeTools: readonly string[], grade?: number): RunStatus {
  if (r.error) return "error";
  if (r.version === "old") return "old";
  const called = new Set(r.tool_calls.map((c) => c.tool));
  if ((t.mustNotCallTools ?? []).some((tool) => called.has(tool))) return "rule";
  if (t.mustCallTools.some((tool) => !called.has(tool))) return "rule";
  const hide = t.oneSidedChecks ?? [];
  const usual = dominantSequence(t.old, hide)?.seq ?? null;
  const path = stepsOf(r).filter((s) => !hide.includes(checkIdOf(s) ?? ""));
  if (usual) {
    for (const tool of writeTools) {
      const ni = path.indexOf(tool);
      if (ni < 0) continue;
      const oi = usual.indexOf(tool);
      if (oi < 0) return "rule";
      const before = new Set(path.slice(0, ni).map(stepId));
      if (
        usual
          .slice(0, oi)
          .map(stepId)
          .some((s) => s !== tool && !before.has(s))
      )
        return "rule";
    }
  }
  if (grade != null && grade < 3) return "low";
  return usual && usual.join(" ") === path.join(" ") ? "same" : "different";
}

export const KIND_LABEL: Record<ChangeKind, string> = {
  rule: "Breaks a test rule",
  worse: "Scores lower",
  better: "Scores higher",
  different: "Different path",
  inconclusive: "Didn't repeat",
  same: "No change",
};

export interface Run {
  record: RunRecord;
  status: RunStatus;
  grade?: number;
}

/** Every run of one test and version, oldest run first, with its status. */
export function runsOf(
  c: Comparison,
  traces: { old: RunRecord[]; new: RunRecord[] },
  grades: GradeRecord[],
  t: TestComparison,
  version: Version,
): Run[] {
  return traces[version]
    .filter((r) => r.test === t.test)
    .sort((a, b) => a.run - b.run)
    .map((record) => {
      const grade = grades.find((g) => g.test === t.test && g.version === version && g.run === record.run)?.score;
      return { record, grade, status: runStatus(t, record, c.writeTools ?? [], grade) };
    });
}

/** One changed test, as the page's findings list shows it. */
export interface Finding {
  test: TestComparison;
  kind: ChangeKind;
  /** Short facts, most important first: rules broken, replies, grade. */
  facts: string[];
}

export function findings(c: Comparison): Finding[] {
  return sortedTests(c)
    .map((t) => ({ test: t, kind: changeKind(t, c.writeTools), facts: factsOf(c, t) }))
    .filter((f) => f.kind !== "same");
}

/** A rate like "3/3" as a fraction. */
const share = (rate: string) => {
  const [a, b] = rate.split("/").map(Number);
  return b ? a / b : 0;
};

export function factsOf(c: Comparison, t: TestComparison): string[] {
  const out: string[] = [];
  for (const f of forbiddenCalls(t))
    out.push(`calls ${f.tool}, which it must never call: ${f.oldRate} → ${f.newRate} runs`);
  for (const e of earlyActions(t, c.writeTools)) out.push(e.replaceAll("`", ""));
  // The biggest drop first: a required tool no run calls any more says more than one that one run skipped.
  const skipped = [...toolRegressions(t)]
    .sort((a, b) => share(a.oldRate) - share(a.newRate) - (share(b.oldRate) - share(b.newRate)))
    .reverse();
  for (const r of skipped) out.push(`skips ${r.tool}: called in ${r.oldRate} → ${r.newRate} runs`);
  for (const w of ruleBreaks(t, c.writeTools))
    if (w.startsWith("calls `") && w.includes("more often")) out.push(w.replaceAll("`", ""));
  const reply = replyShift(t);
  if (reply) out.push(`${reply.started ? "replies" : "stays silent"} in ${reply.new} runs (was ${reply.old})`);
  const g = gradeChange(t);
  if (g?.meaningful) out.push(`grade ${g.old.toFixed(1)} → ${g.new.toFixed(1)}`);
  for (const row of shownCheckRows(t)
    .filter((r) => r.shifted)
    .slice(0, 3))
    out.push(`${row.id}: ${row.old} → ${row.new}`);
  if (inconclusiveChange(t))
    out.push("moved in one half of the runs only, or no more than the old agent moves against itself");
  return [...new Set(out)];
}

/** The headline counts: how many tests changed, by label. */
export function kindCounts(c: Comparison): Record<ChangeKind, number> {
  const out = Object.fromEntries(CHANGE_KINDS.map((k) => [k, 0])) as Record<ChangeKind, number>;
  for (const t of c.tests) out[changeKind(t, c.writeTools)]++;
  return out;
}

/** The page's one-sentence verdict. */
export function verdict(c: Comparison): string {
  const n = kindCounts(c),
    of = c.tests.length;
  const tests = (k: number) => `${k} of ${of} test${of === 1 ? "" : "s"}`;
  if (n.rule) return `Your new agent broke a rule in ${tests(n.rule)}.`;
  if (n.worse) return `Your new agent did worse in ${tests(n.worse)}.`;
  const changed = c.tests.filter(confirmedChange).length;
  if (changed) return `Your new agent behaves differently in ${tests(changed)}.`;
  return n.inconclusive
    ? "Nothing changed that repeated in both halves of the runs."
    : "Your new agent behaves like the old one.";
}

/** The changed lines of the prompt, grouped under the agent they belong to in a team. */
export interface ChangeGroup {
  agent: string;
  lines: { sign: "-" | "+"; text: string }[];
}

/** A team's instructions are "## agent" sections; a single agent's are one section under its own name. */
function sections(instructions: string, name: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let agent = name;
  for (const line of instructions.split("\n")) {
    const heading = /^## (.+)$/.exec(line.trim());
    if (heading) {
      agent = heading[1];
      continue;
    }
    if (!line.trim()) continue;
    out.set(agent, [...(out.get(agent) ?? []), line.trim()]);
  }
  return out;
}

export function promptChanges(c: Comparison): ChangeGroup[] {
  const name = c.newSnapshot.name || c.agentName;
  const before = sections(c.oldSnapshot.instructions, name),
    after = sections(c.newSnapshot.instructions, name);
  const groups: ChangeGroup[] = [];
  for (const agent of new Set([...before.keys(), ...after.keys()])) {
    const o = before.get(agent) ?? [],
      n = after.get(agent) ?? [];
    const lines = [
      ...o.filter((l) => !n.includes(l)).map((text) => ({ sign: "-" as const, text })),
      ...n.filter((l) => !o.includes(l)).map((text) => ({ sign: "+" as const, text })),
    ];
    if (lines.length) groups.push({ agent, lines });
  }
  return groups;
}

/** Model, tool and setting changes, one line each. */
export function otherChanges(c: Comparison): string[] {
  const d = c.snapshotDiff,
    out: string[] = [];
  if (c.oldSnapshot.model !== c.newSnapshot.model) out.push(`model ${c.oldSnapshot.model} → ${c.newSnapshot.model}`);
  if (d.toolsAdded.length) out.push(`tools added: ${d.toolsAdded.join(", ")}`);
  if (d.toolsRemoved.length) out.push(`tools removed: ${d.toolsRemoved.join(", ")}`);
  if (d.toolDefinitionsChanged?.length) out.push(`tool definitions changed: ${d.toolDefinitionsChanged.join(", ")}`);
  for (const s of d.settingsChanged) out.push(`${s.key}: ${JSON.stringify(s.old)} → ${JSON.stringify(s.new)}`);
  return out;
}

/** Cost, latency and steps across all tests, old → new. */
export function totals(c: Comparison) {
  const avg = (pick: (t: TestComparison) => number | null) => {
    const v = c.tests.map(pick).filter((x): x is number => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const cost = pctChange(
    avg((t) => t.old.avgCost),
    avg((t) => t.new.avgCost),
  );
  const latency = pctChange(
    avg((t) => t.old.avgLatencyMs),
    avg((t) => t.new.avgLatencyMs),
  );
  return { cost, latency, stepsOld: avg((t) => t.old.avgSteps), stepsNew: avg((t) => t.new.avgSteps) };
}

/** What most of one agent's runs did on a discovery case. */
export interface PathShare {
  path: string;
  runs: number;
  of: number;
}

/** One of a discovery finding's two cases. */
export interface DiscoveryCase {
  message: string;
  /** The context values that differ from the other case, e.g. "now: 2026-10-13T20:00:00-07:00". */
  context: string[];
  /** What the planner said the agent should do here; the label is judged against it. */
  expected?: string;
  kind?: ChangeKind;
  old: PathShare;
  new: PathShare;
}

export interface DiscoveryFinding {
  id: string;
  name: string;
  /** Both cases send the same message, so the difference is all in the context. */
  sameMessage: boolean;
  cases: [DiscoveryCase, DiscoveryCase];
  /**
   * The agents mostly did something different in at least one case, once
   * checks only one agent runs are left out (as everywhere else on the page).
   * A finding without this differs only in the checks that were removed.
   */
  differs: boolean;
}

const brief = (v: unknown) => {
  const s = v === undefined ? "not set" : typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
};

/** The path most of these runs took, with checks in `hide` left out. */
export function mostly(runs: RunRecord[], hide: readonly string[]): PathShare {
  const counts = new Map<string, number>();
  for (const r of runs.filter((r) => !r.error)) {
    const steps = foldedSteps(r, hide).map(stepText);
    const replied = !!r.final_response?.trim();
    const path = replied ? [...steps, "reply"].join(" → ") : steps.join(" → ") || "no reply";
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  const [path, n] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? ["every run errored", 0];
  return { path, runs: n, of: runs.length };
}

/** Discovery's confirmed findings, as the page shows them; checks only one agent runs are left out of the paths. */
export function discoveryFindings(c: Comparison): DiscoveryFinding[] {
  const inv = checkInventory(c.tests);
  const hide = [...inv.removed, ...inv.added].map((r) => r.id);
  return (c.discovery?.findings ?? []).map((f) => {
    const [a, b] = f.cases;
    const keys = [...new Set([...Object.keys(a.context ?? {}), ...Object.keys(b.context ?? {})])].filter(
      (k) => canonical(a.context?.[k]) !== canonical(b.context?.[k]),
    );
    const side = (cs: typeof a, i: number): DiscoveryCase => ({
      message: cs.input,
      context: keys.map((k) => `${k}: ${brief(cs.context?.[k])}`),
      ...(cs.expected ? { expected: cs.expected } : {}),
      ...((CHANGE_KINDS as readonly string[]).includes(f.kinds?.[i] ?? "") ? { kind: f.kinds![i] as ChangeKind } : {}),
      old: mostly(cs.old, hide),
      new: mostly(cs.new, hide),
    });
    const cases: [DiscoveryCase, DiscoveryCase] = [side(a, 0), side(b, 1)];
    // Checks both agents ran the same way at the start add nothing to the comparison.
    for (const cs of cases) {
      const o = cs.old.path.split(" → "),
        n = cs.new.path.split(" → ");
      let i = 0;
      while (i < o.length - 1 && i < n.length - 1 && o[i] === n[i] && o[i].includes(": ")) i++;
      cs.old.path = o.slice(i).join(" → ");
      cs.new.path = n.slice(i).join(" → ");
    }
    return {
      id: f.id,
      name: f.probe.name.charAt(0).toUpperCase() + f.probe.name.slice(1),
      sameMessage: a.input.trim() === b.input.trim(),
      cases,
      differs: cases.some((cs) => cs.old.path !== cs.new.path),
    };
  });
}

export { noisyTests, NO_REPLY };
