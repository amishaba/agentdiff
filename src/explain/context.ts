import type { Comparison, VersionStats } from "../types.ts";
import { fmtMoney, fmtNum, pctChange } from "../compare/format.ts";
import { shownCheckRows, decisionRows } from "../compare/check-rows.ts";
import {
  replyShift,
  checkInventory,
  forbiddenCalls,
  gradeChange,
  sequenceShift,
  inconclusiveChange,
  noisyTests,
} from "../compare/signals.ts";

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
  const noisy = noisyTests(c);
  if (noisy.length) lines.push(`Noise: the old agent differed from itself in ${noisy.map((t) => t.test).join(", ")}`);
  lines.push("");

  lines.push("## Prompt (instructions) diff");
  lines.push(c.snapshotDiff.instructionsDiff.trim() || "(no change)");
  lines.push("");

  lines.push("## Tool / workflow / settings changes");
  if (c.snapshotDiff.toolsAdded.length) lines.push(`Tools added: ${c.snapshotDiff.toolsAdded.join(", ")}`);
  if (c.snapshotDiff.toolsRemoved.length) lines.push(`Tools removed: ${c.snapshotDiff.toolsRemoved.join(", ")}`);
  if (c.snapshotDiff.toolDefinitionsChanged?.length)
    lines.push(`Tool definitions changed: ${c.snapshotDiff.toolDefinitionsChanged.join(", ")}`);
  if (c.snapshotDiff.workflowsAdded.length) lines.push(`Workflows added: ${c.snapshotDiff.workflowsAdded.join(", ")}`);
  if (c.snapshotDiff.workflowsRemoved.length)
    lines.push(`Workflows removed: ${c.snapshotDiff.workflowsRemoved.join(", ")}`);
  for (const s of c.snapshotDiff.settingsChanged) {
    lines.push(`Setting ${s.key}: ${JSON.stringify(s.old)} -> ${JSON.stringify(s.new)}`);
  }
  if (
    !c.snapshotDiff.toolsAdded.length &&
    !c.snapshotDiff.toolsRemoved.length &&
    !c.snapshotDiff.toolDefinitionsChanged?.length &&
    !c.snapshotDiff.workflowsAdded.length &&
    !c.snapshotDiff.workflowsRemoved.length &&
    !c.snapshotDiff.settingsChanged.length
  ) {
    lines.push("(no change)");
  }
  lines.push("");

  const inv = checkInventory(c.tests);
  if (inv.removed.length || inv.added.length) {
    lines.push("## Checks the agent runs");
    if (inv.removed.length)
      lines.push(
        `Removed (ran in the old version, never in the new): ${inv.removed.map((r) => r.id + (r.source === "guardrail" ? " (guardrail)" : "")).join(", ")}`,
      );
    if (inv.added.length)
      lines.push(
        `Added (ran only in the new version): ${inv.added.map((r) => r.id + (r.source === "guardrail" ? " (guardrail)" : "")).join(", ")}`,
      );
    lines.push("");
  }

  lines.push("## Per-test measured differences");
  for (const t of c.tests) {
    lines.push(
      `### ${t.test}${inconclusiveChange(t) ? " (inconclusive: this did not repeat across both halves of the runs; don't build the explanation on it)" : ""}`,
    );
    if (t.input) lines.push(`- input: ${t.input}`);
    for (const f of forbiddenCalls(t))
      lines.push(`- ${f.tool} (must never be called) called: ${f.oldRate} -> ${f.newRate}`);
    const rs = replyShift(t);
    if (rs)
      lines.push(
        `- replied in ${rs.old} -> ${rs.new} finished runs (${rs.started ? "now replies where it stayed silent" : "now stays silent where it replied"})`,
      );
    const tools = new Set([...t.mustCallTools, ...Object.keys(t.old.toolCallRate), ...Object.keys(t.new.toolCallRate)]);
    for (const tool of tools) {
      const o = t.old.toolCallRate[tool];
      const n = t.new.toolCallRate[tool];
      const oTxt = o ? `${o.called}/${o.of}` : "0";
      const nTxt = n ? `${n.called}/${n.of}` : "0";
      if (oTxt === "0" && nTxt === "0") continue;
      const extra = t.mustCallTools.includes(tool) ? "" : " (observed)";
      lines.push(`- ${tool}${extra} called: ${oTxt} -> ${nTxt}`);
    }
    const seq = sequenceShift(t);
    if (seq) lines.push(`- most common tool sequence: ${seq.old} -> ${seq.new}`);
    const costPct = pctChange(t.old.avgCost, t.new.avgCost);
    lines.push(`- avg cost: ${fmtMoney(t.old.avgCost)} -> ${fmtMoney(t.new.avgCost)}${costPct ? ` (${costPct})` : ""}`);
    const g = gradeChange(t);
    if (g) lines.push(`- grade: ${fmtNum(g.old)} -> ${fmtNum(g.new)}`);
    for (const r of shownCheckRows(t)) {
      const unit = r.kind === "yes_no" ? " runs answered yes" : " runs";
      lines.push(`- outcome check "${r.question}": ${r.old}${unit} -> ${r.new}${unit}${r.shifted ? " (changed)" : ""}`);
    }
    for (const r of decisionRows(t).filter((row) => !t.oneSidedChecks?.includes(row.id))) {
      lines.push(
        `- the agent's ${r.source === "guardrail" ? "guardrail" : r.source === "agent" ? "own check" : "Jev decision"} "${r.id}": asked in ${r.asked.old} -> ${r.asked.new} runs; answers ${r.answer.old} -> ${r.answer.new}${r.shifted ? " (changed)" : ""}`,
      );
      if (r.reworded) lines.push(`  - its question was reworded: "${r.reworded.old}" -> "${r.reworded.new}"`);
    }
    lines.push(`- ${statLine("old", t.old)}`);
    lines.push(`- ${statLine("new", t.new)}`);
  }

  return lines.join("\n");
}
