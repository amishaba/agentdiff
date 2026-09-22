import { AGENTDIFF } from "../lib/invocation.ts";
import chalk from "chalk";
import type { Comparison } from "../types.ts";
import { failureHeadline, MARK } from "./markdown.ts";
import {
  replyShift,
  checkInventory,
  forbiddenCalls,
  toolRegressions,
  gradeChange,
  sequenceShift,
  failedSides,
  confirmedChange,
  inconclusiveChange,
  noiseLine,
  incompleteStages,
  overallCost,
  countSkippedTools,
  countForbiddenCalls,
} from "../compare/signals.ts";
import { fmtMoney, fmtNum } from "../compare/format.ts";
import { sortedTests, ruleBreaks, changeKind } from "../compare/change-kind.ts";
import { shownCheckRows, decisionRows } from "../compare/check-rows.ts";

/** Print a colored summary to the terminal. */
export function printSummary(c: Comparison, explanation: string, reportPath: string): void {
  const changed = c.tests.filter(confirmedChange).length;
  const cost = overallCost(c);
  const skipped = countSkippedTools(c);

  console.log("");
  console.log(chalk.bold.underline("AgentDiff"));
  console.log(`${chalk.dim("agent")}    ${c.agentName}`);
  console.log(`${chalk.dim("compared")} ${c.oldFile} ${chalk.dim("→")} ${c.newFile}`);
  console.log("");

  const failed = failedSides(c);
  if (failed.length) {
    console.log(chalk.red.bold(`  ${failureHeadline(failed)}`));
    for (const f of failed) console.log(chalk.red(`  ${f.side}: ${f.error ?? "every run errored"}`));
    console.log("");
    console.log(chalk.dim(`Full report: ${reportPath}`));
    return;
  }

  const incomplete = incompleteStages(c);
  if (incomplete) {
    console.log(chalk.yellow(`  incomplete · ${incomplete}`));
    console.log("");
  }

  console.log(chalk.bold("Summary"));
  const unsure = c.tests.filter(inconclusiveChange).length;
  console.log(`  ${changed} of ${c.tests.length} test(s) changed behaviour${unsure ? `, ${unsure} inconclusive` : ""}`);
  for (const t of sortedTests(c)) {
    const kind = changeKind(t, c.writeTools);
    if (kind === "same" || kind === "inconclusive") continue;
    const line = `  ${MARK[kind]} ${t.test}${kind === "rule" ? ` · ${ruleBreaks(t, c.writeTools).join(" · ").replaceAll("`", "")}` : ` · ${kind}`}`;
    console.log(kind === "rule" || kind === "worse" ? chalk.red(line) : line);
  }
  const noise = noiseLine(c);
  if (noise) console.log(`  ${noise}`);
  if (cost.pct) {
    const up = cost.old != null && cost.new != null && cost.new > cost.old;
    const color = up ? chalk.red : chalk.green;
    console.log(`  cost ${color(cost.pct)} avg  (${fmtMoney(cost.old)} → ${fmtMoney(cost.new)})`);
  }
  if (skipped > 0) console.log(chalk.red(`  ${skipped} required tool call(s) now being skipped`));
  const forbidden = countForbiddenCalls(c);
  if (forbidden > 0) console.log(chalk.red(`  ${forbidden} forbidden tool(s) now called more often`));
  const replies = c.tests.map(replyShift).filter((r) => r != null);
  const started = replies.filter((r) => r.started).length;
  if (started) console.log(chalk.red(`  started replying in ${started} test(s) it used to leave alone`));
  if (replies.length - started) console.log(chalk.red(`  stopped replying in ${replies.length - started} test(s)`));
  const inv = checkInventory(c.tests);
  if (inv.removed.length) console.log(chalk.yellow(`  checks removed: ${inv.removed.map((r) => r.id).join(", ")}`));
  if (inv.added.length) console.log(chalk.yellow(`  checks added: ${inv.added.map((r) => r.id).join(", ")}`));
  console.log("");

  for (const t of sortedTests(c)) {
    const regs = toolRegressions(t);
    const never = forbiddenCalls(t);
    const reply = replyShift(t);
    const marker = regs.length || never.length || reply ? chalk.red("⚠") : chalk.green("•");
    console.log(`${marker} ${chalk.bold(t.test)}`);
    for (const tool of t.mustCallTools) {
      const o = t.old.toolCallRate[tool];
      const n = t.new.toolCallRate[tool];
      if (!o || !n) continue;
      const isReg = regs.some((r) => r.tool === tool);
      const text = `    ${tool}: ${o.called}/${o.of} → ${n.called}/${n.of}`;
      console.log(isReg ? chalk.red(text + "  REGRESSION") : text);
    }
    if (reply)
      console.log(
        chalk.red(
          `    replied: ${reply.old} → ${reply.new}  ${reply.started ? "STARTED REPLYING" : "STOPPED REPLYING"}`,
        ),
      );
    for (const tool of t.mustNotCallTools ?? []) {
      const o = t.old.toolCallRate[tool];
      const n = t.new.toolCallRate[tool];
      if (!o || !n) continue;
      const text = `    never ${tool}: ${o.called}/${o.of} → ${n.called}/${n.of}`;
      console.log(never.some((f) => f.tool === tool) ? chalk.red(text + "  REGRESSION") : chalk.dim(text));
    }
    const seq = sequenceShift(t);
    if (seq) console.log(chalk.dim(`    path ${seq.old} → ${seq.new}`));
    console.log(chalk.dim(`    cost ${fmtMoney(t.old.avgCost)} → ${fmtMoney(t.new.avgCost)}`));
    const g = gradeChange(t);
    if (g) {
      const gtext = `    grade ${fmtNum(g.old)} → ${fmtNum(g.new)}` + (g.meaningful ? "" : "  (noise)");
      console.log(g.meaningful && g.delta < 0 ? chalk.red(gtext) : chalk.dim(gtext));
    }
    for (const r of shownCheckRows(t)) {
      const text = `    check ${r.id}: ${r.old} → ${r.new}`;
      console.log(r.shifted ? chalk.yellow(text + "  CHANGED") : chalk.dim(text));
    }
    for (const r of decisionRows(t).filter(
      (row) => !t.oneSidedChecks?.includes(row.id) && (row.shifted || row.reworded),
    )) {
      const text = `    decision ${r.id}: ${r.answer.old} → ${r.answer.new} (asked ${r.asked.old} → ${r.asked.new})${r.reworded ? " · reworded" : ""}`;
      console.log(r.shifted ? chalk.yellow(text + "  CHANGED") : chalk.dim(text));
    }
  }
  console.log("");
  console.log(chalk.bold("Likely cause"));
  console.log("  " + explanation.split("\n").join("\n  "));
  console.log("");
  console.log(chalk.dim(`Full report: ${reportPath}`));
  if (c.discovery) {
    console.log(
      chalk.bold(
        `Discovery: ${c.discovery.findings.length} reproduced finding(s), ${c.discovery.agentRuns} runs (${c.discovery.status})`,
      ),
    );
    if (c.discovery.reason) console.log(c.discovery.reason);
  }
  console.log(chalk.dim(`View:        ${AGENTDIFF} view`));
}
