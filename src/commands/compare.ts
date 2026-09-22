import { runComparison } from "../pipeline/compare.ts";
import { printSummary } from "../report/terminal.ts";
import { TerminalReporter } from "./terminal-reporter.ts";

export async function compareCommand(
  ref: string | undefined,
  opts: { config?: string; ifChanged?: boolean; baseline?: string } = {},
): Promise<void> {
  const result = await runComparison(ref, { ...opts, reporter: new TerminalReporter() });
  if (!result.skipped) printSummary(result.comparison, result.comparison.explanation ?? "", result.reportPath);
}
