import chalk from "chalk";
import { locateWorkspace } from "../config/load.ts";
import { explainComparison } from "../explain/explain.ts";
import { fail } from "../lib/errors.ts";
import { readComparison, writeDetailedExplanation } from "../storage/comparison.ts";
import type { Comparison } from "../types.ts";

export async function explainCommand(opts: { config?: string } = {}): Promise<void> {
  const dir = await (await locateWorkspace(opts.config)).latestCompareDir();
  if (!dir) {
    fail(`No compare found. Run "agentdiff compare" first.`);
  }

  let comparison: Comparison;
  try {
    comparison = await readComparison(dir);
  } catch {
    fail(`Could not read the comparison in ${dir}. Run "agentdiff compare" again.`);
  }

  console.log(chalk.bold(`AgentDiff explain — ${comparison.agentName}`));
  console.log(chalk.dim(`  ${comparison.oldFile} → ${comparison.newFile}`));
  console.log(chalk.dim("  generating detailed analysis..."));
  console.log("");

  const explanation = await explainComparison(comparison, { detail: "detailed" });
  console.log(explanation);
  console.log("");

  const outPath = await writeDetailedExplanation(dir, explanation);
  console.log(chalk.dim(`Saved to ${outPath}`));
}
