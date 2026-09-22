import path from "node:path";
import chalk from "chalk";
import { locateWorkspace } from "../config/load.ts";
import { fail } from "../lib/errors.ts";
import { exists } from "../storage/fs.ts";
import { formatPrComment } from "../github/pull-request.ts";
import { rebuildReport } from "../pipeline/rebuild-report.ts";

/** `agentdiff report [dir]`: rebuild a saved comparison's report; `--comment` prints the PR comment too. */
export async function reportCommand(dirArg?: string, opts: { config?: string; comment?: boolean } = {}): Promise<void> {
  const workspace = await locateWorkspace(opts.config);
  // A compare folder's name works too, like check --resume and --baseline take: it's looked for under .agentdiff/.
  const named = dirArg && !(await exists(dirArg)) ? path.join(workspace.dir, path.basename(dirArg)) : dirArg;
  const dir = named ?? (await workspace.latestCompareDir());
  if (!dir) fail(`No compare found. Run "agentdiff compare" first, or pass a compare folder.`);
  const { comparison, report, reportPath, comparisonPath, runs } = await rebuildReport(dir);
  console.log(chalk.bold(`AgentDiff report — ${comparison.agentName}`));
  console.log(chalk.dim(`  rebuilt ${reportPath} and ${comparisonPath} from ${runs} saved runs; no model calls`));
  if (opts.comment) console.log("\n" + formatPrComment(report));
}
