import type { Comparison, TestComparison, VersionStats } from "./types.ts";

export function fmtMoney(n: number | null): string {
  if (n == null) return "n/a";
  return `$${n.toFixed(n < 0.01 ? 4 : 2)}`;
}

export function fmtNum(n: number | null, digits = 1): string {
  if (n == null) return "n/a";
  return n.toFixed(digits);
}

/** "+112%" style change between two averages. Null-safe. */
export function pctChange(oldV: number | null, newV: number | null): string | null {
  if (oldV == null || newV == null) return null;
  if (oldV === 0) return newV === 0 ? "+0%" : "new value";
  const pct = ((newV - oldV) / Math.abs(oldV)) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(0)}%`;
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

/** Did this test's behaviour change in any observable way? */
export function testChanged(t: TestComparison): boolean {
  if (toolRegressions(t).length > 0) return true;
  const g = gradeChange(t);
  if (g?.meaningful) return true;
  const costPct = pctChange(t.old.avgCost, t.new.avgCost);
  if (costPct && costPct !== "+0%" && Math.abs(parseFloat(costPct)) >= 10) return true;
  if (t.old.errors !== t.new.errors) return true;
  return false;
}

function statLine(label: string, s: VersionStats): string {
  return `${label}: avgCost=${fmtMoney(s.avgCost)}, avgSteps=${fmtNum(s.avgSteps)}, avgGrade=${fmtNum(s.avgGrade)}, errors=${s.errors}/${s.runs}`;
}

/** Compact plain-text summary of the comparison, fed to the AI explainer. No raw traces. */
export function buildExplainerContext(c: Comparison): string {
  const lines: string[] = [];
  lines.push(`Agent: ${c.agentName}`);
  lines.push(`Old file: ${c.oldFile}`);
  lines.push(`New file: ${c.newFile}`);
  lines.push(`Runs per test: ${c.runsPerTest}`);
  lines.push("");

  lines.push("## Prompt (instructions) diff");
  lines.push(c.snapshotDiff.instructionsDiff.trim() || "(no change)");
  lines.push("");

  lines.push("## Tool / workflow / settings changes");
  if (c.snapshotDiff.toolsAdded.length) lines.push(`Tools added: ${c.snapshotDiff.toolsAdded.join(", ")}`);
  if (c.snapshotDiff.toolsRemoved.length) lines.push(`Tools removed: ${c.snapshotDiff.toolsRemoved.join(", ")}`);
  if (c.snapshotDiff.workflowsAdded.length) lines.push(`Workflows added: ${c.snapshotDiff.workflowsAdded.join(", ")}`);
  if (c.snapshotDiff.workflowsRemoved.length) lines.push(`Workflows removed: ${c.snapshotDiff.workflowsRemoved.join(", ")}`);
  for (const s of c.snapshotDiff.settingsChanged) {
    lines.push(`Setting ${s.key}: ${JSON.stringify(s.old)} -> ${JSON.stringify(s.new)}`);
  }
  if (
    !c.snapshotDiff.toolsAdded.length &&
    !c.snapshotDiff.toolsRemoved.length &&
    !c.snapshotDiff.workflowsAdded.length &&
    !c.snapshotDiff.workflowsRemoved.length &&
    !c.snapshotDiff.settingsChanged.length
  ) {
    lines.push("(no change)");
  }
  lines.push("");

  lines.push("## Per-test measured differences");
  for (const t of c.tests) {
    lines.push(`### ${t.test}`);
    for (const tool of t.mustCallTools) {
      const o = t.old.toolCallRate[tool];
      const n = t.new.toolCallRate[tool];
      if (o && n) lines.push(`- ${tool} called: ${o.called}/${o.of} -> ${n.called}/${n.of}`);
    }
    const costPct = pctChange(t.old.avgCost, t.new.avgCost);
    lines.push(`- avg cost: ${fmtMoney(t.old.avgCost)} -> ${fmtMoney(t.new.avgCost)}${costPct ? ` (${costPct})` : ""}`);
    const g = gradeChange(t);
    if (g) lines.push(`- grade: ${fmtNum(g.old)} -> ${fmtNum(g.new)}`);
    lines.push(`- ${statLine("old", t.old)}`);
    lines.push(`- ${statLine("new", t.new)}`);
  }

  return lines.join("\n");
}
