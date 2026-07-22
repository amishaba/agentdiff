import path from "node:path";
import chalk from "chalk";
import { fail } from "../config.ts";
import { explainComparison } from "../explainer.ts";
import { latestCompareDir, readJson, writeText } from "../storage.ts";
import type { Comparison } from "../types.ts";

export async function explainCommand(): Promise<void> {
  const dir = await latestCompareDir();
  if (!dir) {
    fail(`No compare found. Run "agentdiff compare" first.`);
  }

  const comparisonPath = path.join(dir, "comparison.json");
  let comparison: Comparison;
  try {
    comparison = await readJson<Comparison>(comparisonPath);
  } catch {
    fail(`Could not read ${comparisonPath}. Run "agentdiff compare" again.`);
  }

  console.log(chalk.bold(`AgentDiff explain — ${comparison.agentName}`));
  console.log(chalk.dim(`  ${comparison.oldFile} → ${comparison.newFile}`));
  console.log(chalk.dim("  generating detailed analysis..."));
  console.log("");

  const explanation = await explainComparison(comparison, true);
  console.log(explanation);
  console.log("");

  const outPath = path.join(dir, "explanation.md");
  await writeText(outPath, `# AgentDiff — Detailed Analysis\n\n${explanation}\n`);
  console.log(chalk.dim(`Saved to ${outPath}`));
}
