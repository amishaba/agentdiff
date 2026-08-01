import path from "node:path";
import chalk from "chalk";
import { loadConfig, fail } from "../config.ts";
import { loadTests } from "../tests.ts";
import { importAgent, extractSnapshot } from "../agent.ts";
import { runVersion } from "../runner.ts";
import { BASELINE_DIR, baselineRunsDir, rm, writeJson } from "../storage.ts";

export async function baselineCommand(opts: { config?: string } = {}): Promise<void> {
  const { config, rootDir } = await loadConfig(opts.config);
  const tests = await loadTests(rootDir, config.tests);

  const oldPath = config.versions?.old ?? config.agentPath;
  if (!oldPath) {
    fail(`Config needs "versions.old" or "agentPath" to snapshot a baseline.`);
  }

  console.log(chalk.bold(`AgentDiff baseline — ${config.agent}`));
  console.log(chalk.dim(`  old agent: ${oldPath}`));

  const agent = await importAgent(rootDir, oldPath, config.agent);

  // Fresh baseline each time.
  await rm(BASELINE_DIR);

  const snapshot = await extractSnapshot(agent);
  await writeJson(path.join(BASELINE_DIR, "snapshot.json"), snapshot);
  const wf = snapshot.workflows.length ? `, workflows=[${snapshot.workflows.join(", ")}]` : "";
  console.log(
    chalk.dim(`  snapshot: model=${snapshot.model}, tools=[${snapshot.tools.join(", ")}]${wf}`),
  );

  const total = tests.length * config.runsPerTest;
  let done = 0;
  console.log(chalk.dim(`  running ${tests.length} test(s) × ${config.runsPerTest} = ${total} runs...`));

  await runVersion({
    agent,
    tests,
    version: "old",
    runsPerTest: config.runsPerTest,
    runsDir: baselineRunsDir(),
    onRun: (r) => {
      done++;
      const mark = r.error ? chalk.red("x") : chalk.green("✓");
      process.stdout.write(`\r  ${mark} ${done}/${total} runs saved`);
    },
  });
  process.stdout.write("\n");
  console.log(chalk.green(`Baseline saved to ${BASELINE_DIR}/`));
}
