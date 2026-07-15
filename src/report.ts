import chalk from "chalk";
import type { Comparison, TestComparison } from "./types.ts";
import {
  fmtMoney,
  fmtNum,
  gradeChange,
  pctChange,
  testChanged,
  toolRegressions,
} from "./summary.ts";

function avgOf(nums: (number | null)[]): number | null {
  const xs = nums.filter((n): n is number => n != null);
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function overallCost(c: Comparison): { old: number | null; new: number | null; pct: string | null } {
  const oldAvg = avgOf(c.tests.map((t) => t.old.avgCost));
  const newAvg = avgOf(c.tests.map((t) => t.new.avgCost));
  return { old: oldAvg, new: newAvg, pct: pctChange(oldAvg, newAvg) };
}

function countSkippedTools(c: Comparison): number {
  return c.tests.reduce((sum, t) => sum + toolRegressions(t).length, 0);
}

function gradeLine(t: TestComparison): string | null {
  const g = gradeChange(t);
  if (!g) return null;
  const base = `grade (criteria): ${fmtNum(g.old)}/5 → ${fmtNum(g.new)}/5`;
  if (!g.meaningful) return `${base}  (small change, possibly noise)`;
  return `${base}  ${g.delta < 0 ? "⚠️ REGRESSION" : "improved"}`;
}

function toolLines(t: TestComparison): string[] {
  const lines: string[] = [];
  const regressions = new Set(toolRegressions(t).map((r) => r.tool));
  for (const tool of t.mustCallTools) {
    const o = t.old.toolCallRate[tool];
    const n = t.new.toolCallRate[tool];
    if (!o || !n) continue;
    const flag = regressions.has(tool) ? "   ⚠️ REGRESSION" : "";
    lines.push(`- ${tool} called: ${o.called}/${o.of} → ${n.called}/${n.of}${flag}`);
  }
  return lines;
}

/** Build the markdown report. */
export function buildReport(c: Comparison, explanation: string): string {
  const L: string[] = [];
  L.push("# AgentDiff Report");
  L.push("");
  L.push(`Agent: ${c.agentName}`);
  L.push(`Compared: ${c.oldFile} → ${c.newFile}`);
  L.push(`Runs per test: ${c.runsPerTest}`);
  L.push("");

  const changed = c.tests.filter(testChanged).length;
  const cost = overallCost(c);
  const skipped = countSkippedTools(c);

  L.push("## Summary");
  L.push(`- ${changed} of ${c.tests.length} test(s) changed behaviour`);
  if (cost.pct) L.push(`- Cost: ${cost.pct} average (${fmtMoney(cost.old)} → ${fmtMoney(cost.new)})`);
  if (skipped > 0) L.push(`- ${skipped} required tool call(s) now being skipped`);
  const errDelta = c.tests.reduce((s, t) => s + (t.new.errors - t.old.errors), 0);
  if (errDelta > 0) L.push(`- ${errDelta} more errored run(s) on the new version`);
  L.push("");

  L.push("## Per test");
  L.push("");
  for (const t of c.tests) {
    L.push(`### ${t.test}`);
    for (const line of toolLines(t)) L.push(line);
    L.push(`- avg cost: ${fmtMoney(t.old.avgCost)} → ${fmtMoney(t.new.avgCost)}`);
    L.push(`- avg steps: ${fmtNum(t.old.avgSteps)} → ${fmtNum(t.new.avgSteps)}`);
    L.push(
      `- avg latency: ${fmtNum(t.old.avgLatencyMs, 0)}ms → ${fmtNum(t.new.avgLatencyMs, 0)}ms`,
    );
    const gl = gradeLine(t);
    if (gl) L.push(`- ${gl}`);
    if (t.old.errors || t.new.errors) L.push(`- errored runs: ${t.old.errors}/${t.old.runs} → ${t.new.errors}/${t.new.runs}`);
    L.push("");
  }

  L.push("## Prompt changes");
  const diff = c.snapshotDiff.instructionsDiff.trim();
  L.push(diff ? "```diff\n" + diff + "\n```" : "(no changes)");
  L.push("");

  const sd = c.snapshotDiff;
  if (sd.toolsAdded.length || sd.toolsRemoved.length || sd.settingsChanged.length) {
    L.push("## Tool & setting changes");
    if (sd.toolsAdded.length) L.push(`- Tools added: ${sd.toolsAdded.join(", ")}`);
    if (sd.toolsRemoved.length) L.push(`- Tools removed: ${sd.toolsRemoved.join(", ")}`);
    for (const s of sd.settingsChanged) {
      L.push(`- ${s.key}: ${JSON.stringify(s.old)} → ${JSON.stringify(s.new)}`);
    }
    L.push("");
  }

  L.push("## Likely cause (AI analysis)");
  L.push(explanation);
  L.push("");

  return L.join("\n");
}

/** Print a colored summary to the terminal. */
export function printSummary(c: Comparison, explanation: string, reportPath: string): void {
  const changed = c.tests.filter(testChanged).length;
  const cost = overallCost(c);
  const skipped = countSkippedTools(c);

  console.log("");
  console.log(chalk.bold.underline("AgentDiff"));
  console.log(`${chalk.dim("agent")}    ${c.agentName}`);
  console.log(`${chalk.dim("compared")} ${c.oldFile} ${chalk.dim("→")} ${c.newFile}`);
  console.log("");

  console.log(chalk.bold("Summary"));
  console.log(`  ${changed} of ${c.tests.length} test(s) changed behaviour`);
  if (cost.pct) {
    const up = cost.old != null && cost.new != null && cost.new > cost.old;
    const color = up ? chalk.red : chalk.green;
    console.log(`  cost ${color(cost.pct)} avg  (${fmtMoney(cost.old)} → ${fmtMoney(cost.new)})`);
  }
  if (skipped > 0) console.log(chalk.red(`  ${skipped} required tool call(s) now being skipped`));
  console.log("");

  for (const t of c.tests) {
    const regs = toolRegressions(t);
    const marker = regs.length ? chalk.red("⚠") : chalk.green("•");
    console.log(`${marker} ${chalk.bold(t.test)}`);
    for (const tool of t.mustCallTools) {
      const o = t.old.toolCallRate[tool];
      const n = t.new.toolCallRate[tool];
      if (!o || !n) continue;
      const isReg = regs.some((r) => r.tool === tool);
      const text = `    ${tool}: ${o.called}/${o.of} → ${n.called}/${n.of}`;
      console.log(isReg ? chalk.red(text + "  REGRESSION") : text);
    }
    console.log(chalk.dim(`    cost ${fmtMoney(t.old.avgCost)} → ${fmtMoney(t.new.avgCost)}`));
    const g = gradeChange(t);
    if (g) {
      const gtext = `    grade ${fmtNum(g.old)} → ${fmtNum(g.new)}` + (g.meaningful ? "" : "  (noise)");
      console.log(g.meaningful && g.delta < 0 ? chalk.red(gtext) : chalk.dim(gtext));
    }
  }
  console.log("");
  console.log(chalk.bold("Likely cause"));
  console.log("  " + explanation.split("\n").join("\n  "));
  console.log("");
  console.log(chalk.dim(`Full report: ${reportPath}`));
}
