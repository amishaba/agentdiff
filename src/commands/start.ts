// `agentdiff` with no command: set the project up the first time, then
// compare the agent in the working folder against main and open the results.
import { AGENTDIFF } from "../lib/invocation.ts";
import path from "node:path";
import chalk from "chalk";
import { findAgents, type FoundAgent } from "../agent/find.ts";
import { importAgent } from "../agent/load.ts";
import { extractSnapshot } from "../agent/snapshot.ts";
import { findConfigFile, loadConfig } from "../config/load.ts";
import { ignoreInGit, saveEnv, starterTestsDir, writeConfig } from "../config/setup.ts";
import { draftStarterTests, PLACEHOLDER_TEST } from "../suite/starter.ts";
import { writeScenarios, type NewTest } from "../suite/write.ts";
import { baseRef, isGitRepo } from "../lib/git.ts";
import { graderKind, hasApiKey, hasGatewayKey, offline } from "../lib/llm.ts";
import { errMessage, fail } from "../lib/errors.ts";
import { exists } from "../storage/fs.ts";
import { runComparison } from "../pipeline/compare.ts";
import type { Snapshot } from "../types.ts";
import { printSummary } from "../report/terminal.ts";
import { TerminalReporter } from "./terminal-reporter.ts";
import { viewCommand } from "./view.ts";
import { ask, askSecret, choose, interactive } from "./prompt.ts";

const SETUP_DOC = "https://github.com/amishaba/agentdiff/blob/main/docs/setup.md";

export async function startCommand(): Promise<void> {
  const cwd = process.cwd();
  if (!(await findConfigFile())) await setUp(cwd);

  const { config, rootDir } = await loadConfig();
  await getKeys(rootDir);
  const ref = config.agentPath ? await baseRef(rootDir) : undefined;
  console.log(
    ref
      ? `\nComparing ${chalk.bold(config.agentPath)} as it is in your folder (new) with ${chalk.bold(ref)} (old).`
      : `\nComparing ${chalk.bold(config.versions!.old)} (old) with ${chalk.bold(config.versions!.new)} (new).`,
  );

  const result = await runComparison(ref, { reporter: new TerminalReporter(), ifChanged: !!ref });
  if (result.skipped) {
    console.log("");
    console.log(
      result.reason.includes("does not exist")
        ? `Your agent isn't on ${ref} yet, so there's no old version to compare with. See how it behaves as it is with ${chalk.bold(`${AGENTDIFF} check`)}, or write more tests with ${chalk.bold(`${AGENTDIFF} scenarios`)}. Commit it, and every prompt edit after that is compared against it.`
        : `Your agent's prompt, tools and model match ${ref}. Change one of them and run ${chalk.bold(AGENTDIFF)} again to see what the change does.`,
    );
    return;
  }
  printSummary(result.comparison, result.comparison.explanation ?? "", result.reportPath);
  if (interactive()) {
    console.log("");
    await viewCommand({});
  }
}

/** First run: find the agent, get keys, write starter tests and the config. */
async function setUp(cwd: string): Promise<void> {
  if (!(await isGitRepo(cwd)))
    fail(
      `Run ${AGENTDIFF} inside your agent's git repo. It compares your edits with the version committed on main.\n` +
        `No git? See ${SETUP_DOC} to compare two files instead.`,
    );
  console.log(chalk.bold("Setting up agentdiff in this folder.\n"));

  const agent = await pickAgent(cwd);
  console.log(`Agent: ${chalk.bold(agent.exportName)} in ${agent.file}`);

  // Keys come before loading the agent: some agents build their model client when the file is imported.
  await getKeys(cwd);

  let snapshot: Snapshot;
  try {
    snapshot = await extractSnapshot(await importAgent(cwd, agent.file, agent.exportName));
  } catch (err) {
    fail(`Couldn't load ${agent.exportName} from ${agent.file}: ${errMessage(err)}`);
  }

  const { dir, existing } = await starterTestsDir(cwd);
  let testsNote = `${existing} test${existing === 1 ? "" : "s"} already there`;
  if (!existing) {
    let tests: NewTest[] = [PLACEHOLDER_TEST];
    let drafted = false;
    if (!offline() && snapshot.instructions.trim()) {
      console.log("Writing starter tests from your agent's prompt…");
      try {
        tests = await draftStarterTests(snapshot);
        drafted = true;
      } catch (err) {
        console.log(chalk.dim(`  Couldn't draft tests (${errMessage(err)}); writing one to start with.`));
      }
    }
    const written = await writeScenarios(path.join(cwd, dir), tests);
    testsNote = `${written.length} starter test${written.length === 1 ? "" : "s"}${drafted ? ", drafted from your agent's prompt" : ""}. Edit or add to them.`;
  }

  await writeConfig(cwd, { agent: agent.exportName, agentPath: `./${agent.file}`, tests: dir });
  const ignored = await ignoreInGit(cwd, [".env", ".agentdiff/"]);

  console.log("");
  console.log("Created:");
  console.log(`  ${"agentdiff.config.ts".padEnd(22)}points at ${agent.exportName} in ${agent.file}`);
  console.log(`  ${`${dir.replace(/^\.\//, "")}/`.padEnd(22)}${testsNote}`);
  if (ignored.length) console.log(`  ${".gitignore".padEnd(22)}now ignores ${ignored.join(" and ")}`);
}

async function pickAgent(cwd: string): Promise<FoundAgent> {
  const found = await findAgents(cwd);
  if (found.length === 1) return found[0];
  if (!interactive())
    fail(
      found.length
        ? `Found ${found.length} agents (${found.map((a) => `${a.exportName} in ${a.file}`).join(", ")}). Run ${AGENTDIFF} in a terminal to pick one, or write agentdiff.config.ts: ${SETUP_DOC}`
        : `Couldn't find an agent to test. Write agentdiff.config.ts to point at it: ${SETUP_DOC}`,
    );
  if (found.length) {
    const i = await choose(
      "Which agent should agentdiff test?",
      found.map((a) => `${a.exportName}  ${chalk.dim(a.file)}`),
    );
    return found[i];
  }
  console.log("Couldn't find a Mastra or OpenAI Agents SDK agent here, so tell agentdiff where yours is.");
  for (;;) {
    const file = (await ask("Which file is your agent in? ")).replace(/^\.\//, "");
    if (!file) continue;
    if (!(await exists(path.join(cwd, file)))) {
      console.log(chalk.dim(`  There's no ${file} in this folder.`));
      continue;
    }
    const exportName = (await ask("What does that file export it as? ")) || "default";
    return { file, exportName, framework: "other" };
  }
}

/** Ask for any key a comparison needs and isn't set, and save the answers to .env. */
async function getKeys(cwd: string): Promise<void> {
  if (offline()) return;
  const needOpenAI = !hasApiKey();
  const needGateway = graderKind() === "jev" && !hasGatewayKey();
  if (!needOpenAI && !needGateway) return;
  if (!interactive())
    fail(
      `Add ${[needOpenAI && "OPENAI_API_KEY", needGateway && "AI_GATEWAY_API_KEY"].filter(Boolean).join(" and ")} to .env, ` +
        `or run ${AGENTDIFF} in a terminal and paste them when asked.`,
    );
  const save: Record<string, string> = {};
  console.log("");
  if (needOpenAI) {
    const key = await askSecret(
      `OpenAI API key ${chalk.dim("(platform.openai.com/api-keys; writes test cases and explanations)")}: `,
    );
    if (!key) fail(`agentdiff needs an OpenAI key. To compare without one, run AGENTDIFF_OFFLINE=1 ${AGENTDIFF}.`);
    save.OPENAI_API_KEY = process.env.OPENAI_API_KEY = key;
  }
  if (needGateway) {
    const key = await askSecret(
      `Vercel AI Gateway key ${chalk.dim("(vercel.com/ai-gateway; grades every run with Jev)")}.\nPress Enter to grade with OpenAI instead: `,
    );
    if (key) save.AI_GATEWAY_API_KEY = process.env.AI_GATEWAY_API_KEY = key;
    else save.AGENTDIFF_GRADER = process.env.AGENTDIFF_GRADER = "openai";
  }
  const added = await saveEnv(cwd, save);
  if (added.length) console.log(chalk.dim(`Saved to .env: ${added.join(", ")}`));
}
