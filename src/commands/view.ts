import { AGENTDIFF } from "../lib/invocation.ts";
import { spawn } from "node:child_process";
import chalk from "chalk";
import { fail } from "../lib/errors.ts";
import { createViewServer, listen } from "../dashboard/server.ts";
import { listRuns } from "../dashboard/runs-api.ts";
import { Workspace } from "../storage/workspace.ts";

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
  } catch {
    // Best effort — the URL is printed regardless.
  }
}

export async function viewCommand(opts: { port?: string; open?: boolean } = {}): Promise<void> {
  const wanted = opts.port ? Number.parseInt(opts.port, 10) : 4321;
  if (!Number.isFinite(wanted) || wanted < 1 || wanted > 65535) {
    fail(`--port must be a number between 1 and 65535.`);
  }

  const port = await listen(createViewServer(), wanted);
  const url = `http://localhost:${port}/?view=dashboard`;
  const runs = await listRuns(new Workspace(process.cwd()));

  console.log(chalk.bold(`AgentDiff view`));
  console.log(`  ${chalk.green(url)}  ${chalk.dim(`(${runs.length} comparison${runs.length === 1 ? "" : "s"})`)}`);
  if (runs.length === 0) {
    console.log("");
    console.log(chalk.dim("  No comparisons yet. From this directory:"));
    console.log(`  ${chalk.dim("$")} ${AGENTDIFF}`);
  }
  console.log(chalk.dim("  press Ctrl+C to stop"));

  if (opts.open !== false) openBrowser(url);
}
