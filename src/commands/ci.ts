import chalk from "chalk";
import { runComparison } from "../pipeline/compare.ts";
import { printSummary } from "../report/terminal.ts";
import { TerminalReporter } from "./terminal-reporter.ts";
import { fail } from "../lib/errors.ts";
import { buildReport } from "../report/markdown.ts";
import { failedSides } from "../compare/signals.ts";
import {
  comparedLabel,
  formatPrComment,
  readPullRequestContext,
  removeReportComment,
  upsertReportComment,
} from "../github/pull-request.ts";

export async function ciCommand(opts: { config?: string } = {}): Promise<void> {
  const ctx = readPullRequestContext();

  console.log(chalk.bold("AgentDiff ci"));
  console.log(chalk.dim(`  PR #${ctx.number}  ${ctx.baseRef} (${ctx.baseSha.slice(0, 7)}) → this PR`));

  const result = await runComparison(ctx.baseSha, {
    config: opts.config,
    ifChanged: true,
    reporter: new TerminalReporter(),
  });

  if (result.skipped) {
    const removed = await removeReportComment(ctx);
    if (removed) console.log(chalk.dim("  removed the previous AgentDiff comment (snapshot matches base)."));
    return;
  }

  // A side that never ran is an infrastructure failure, not a result: fail the
  // check and leave whatever comment is already on the PR alone.
  const { comparison } = result;
  printSummary(comparison, comparison.explanation ?? "", result.reportPath);
  const failed = failedSides(comparison);
  if (failed.length) {
    fail(
      failed.map((f) => `  all ${f.runs} ${f.side} runs errored: ${f.error ?? "(no message)"}`).join("\n") +
        "\n  Not updating the PR comment. Fix the cause (key, credits, agent import) and push again.",
    );
  }

  // Same report as report.md, but the header says "`main` → this PR" instead
  // of the worktree paths, which mean nothing on GitHub.
  const report = buildReport(comparison, comparison.explanation ?? "", { compared: comparedLabel(ctx.baseRef) });
  await upsertReportComment(ctx, formatPrComment(report));
  console.log(chalk.green(`  commented on PR #${ctx.number}`));
}
