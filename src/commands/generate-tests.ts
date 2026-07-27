import path from "node:path";
import chalk from "chalk";
import { loadConfig, fail, errMessage } from "../config.ts";
import { importAgent, extractSnapshot } from "../agent.ts";
import { hasApiKey, NO_KEY_HINT } from "../ai.ts";
import { generateTestScenarios, writeScenarios, type ScenarioCategory } from "../testgen.ts";

const DEFAULT_COUNT = 12;

function parseCount(raw?: string): number {
  if (raw == null) return DEFAULT_COUNT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    fail(`--count must be a positive integer, got "${raw}".`);
  }
  return Math.min(n, 30);
}

const CATEGORY_LABELS: Record<ScenarioCategory, string> = {
  happy_path: "happy-path",
  edge_case: "edge case",
  hostile: "hostile",
};

export async function generateTestsCommand(opts: { config?: string; count?: string } = {}): Promise<void> {
  const { config, rootDir } = await loadConfig(opts.config);

  const agentPath = config.versions?.new ?? config.agentPath;
  if (!agentPath) {
    fail(`Config needs "versions.new" or "agentPath" to know which agent to inspect.`);
  }
  if (!hasApiKey()) {
    fail(`generate-tests needs a Gemini API key — ${NO_KEY_HINT}.`);
  }

  const count = parseCount(opts.count);

  console.log(chalk.bold(`AgentDiff generate-tests — ${config.agent}`));
  console.log(chalk.dim(`  agent: ${agentPath}`));

  const agent = await importAgent(rootDir, agentPath, config.agent);
  const snapshot = await extractSnapshot(agent);
  console.log(chalk.dim(`  tools: [${snapshot.tools.join(", ") || "none"}]`));
  console.log(chalk.dim(`  asking the model for ${count} scenario(s)...`));

  let scenarios;
  try {
    scenarios = await generateTestScenarios(snapshot, count);
  } catch (err) {
    fail(`Could not generate tests: ${errMessage(err)}`);
  }
  if (scenarios.length === 0) {
    fail("The model returned no scenarios. Try running the command again.");
  }

  const counts = { happy_path: 0, edge_case: 0, hostile: 0 } as Record<ScenarioCategory, number>;
  for (const s of scenarios) counts[s.category]++;

  const testsDir = path.resolve(rootDir, config.tests);
  const written = await writeScenarios(testsDir, scenarios);

  console.log("");
  console.log(chalk.green(`Wrote ${written.length} draft test(s) to ${config.tests}/`));
  const breakdown = (Object.keys(counts) as ScenarioCategory[])
    .filter((c) => counts[c] > 0)
    .map((c) => `${counts[c]} ${CATEGORY_LABELS[c]}`)
    .join(", ");
  if (breakdown) console.log(chalk.dim(`  ${breakdown}`));
  for (const f of written) console.log(chalk.dim(`  + ${path.join(config.tests, f)}`));

  console.log("");
  console.log(
    chalk.yellow("These are AI-generated drafts — review and edit them before trusting a comparison."),
  );
}
