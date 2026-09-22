import { createRequire } from "node:module";
import { Command } from "commander";
import { checkCommand } from "./commands/check.ts";
import { ciCommand } from "./commands/ci.ts";
import { compareCommand } from "./commands/compare.ts";
import { explainCommand } from "./commands/explain.ts";
import { mutateCommand } from "./commands/mutate.ts";
import { reportCommand } from "./commands/report.ts";
import { scenariosCommand } from "./commands/scenarios.ts";
import { startCommand } from "./commands/start.ts";
import { viewCommand } from "./commands/view.ts";
import { errMessage } from "./lib/errors.ts";
import { AGENTDIFF } from "./lib/invocation.ts";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const program = new Command();
/** Lines up the help descriptions after each example command. */
const pad = (cmd: string) => " ".repeat(Math.max(2, 28 - cmd.length));

program
  .name("agentdiff")
  .description("Compare two versions of an AI agent and report how its behaviour changed.")
  .version(version)
  .showHelpAfterError()
  .addHelpText(
    "after",
    `
Examples:
  $ ${AGENTDIFF}${pad("")}set up (first run), compare against main, open the results
  $ ${AGENTDIFF} compare main${pad(" compare main")}git mode (needs agentPath in config)
  $ ${AGENTDIFF} compare main --if-changed
  $ ${AGENTDIFF} check${pad(" check")}how the agent as it is behaves on every test, no old version needed
  $ ${AGENTDIFF} compare${pad(" compare")}two-file mode (versions.old vs versions.new)
  $ ${AGENTDIFF} view${pad(" view")}local dashboard at http://localhost:4321
  $ ${AGENTDIFF} explain
  $ ${AGENTDIFF} report${pad(" report")}rebuild the latest report, no model calls
  $ ${AGENTDIFF} ci${pad(" ci")}GitHub Action: compare PR vs base, one comment
  $ ${AGENTDIFF} mutate${pad(" mutate")}seed regressions into the agent, count the ones the tests catch
  $ ${AGENTDIFF} scenarios${pad(" scenarios")}write test scenarios from the prompt and tools, for review

The commands need agentdiff.config.ts in the current directory (or -c path); the first run writes one.
Set AI_GATEWAY_API_KEY (Jev) and OPENAI_API_KEY in .env: every comparison judges, discovers and explains.
`,
  );

program
  .command("compare")
  .description("Run the old and new agent on every test, compare what they did, then write a report.")
  .argument(
    "[ref]",
    "git ref to compare the working tree against (e.g. HEAD~1, main). Omit to compare versions.old with versions.new.",
  )
  .option("-c, --config <path>", "path to agentdiff.config.ts")
  .option("--if-changed", "skip the runs when the agent snapshot matches the other side")
  .option(
    "--baseline <dir>",
    "a finished check-* folder of versions.old (agentdiff check <old file>): its runs and grades are the old side",
  )
  .action(async (ref, opts) => {
    await compareCommand(ref, opts);
  });

program
  .command("check")
  .description(
    "Run the agent as it is on every test, several times, and say how each test went: steady, unpredictable, scores low, breaks a test rule, or errors. Nothing to compare against needed.",
  )
  .argument("[file]", "agent file to check (default: agentPath, else versions.new)")
  .option("-c, --config <path>", "path to agentdiff.config.ts")
  .option("--runs <n>", "runs per test (default: runsPerTest from the config, at least 2)")
  .option("--trial", "run every test once, ungraded, to find tests that expect the wrong thing before a full check")
  .option(
    "--resume <dir>",
    "finish a check-* folder that stopped partway, or a trial: keep its saved runs, run the rest",
  )
  .action(async (file, opts) => {
    await checkCommand(file, opts);
  });

program
  .command("ci")
  .description("GitHub Action entry: compare this PR against its base and upsert one report comment.")
  .option("-c, --config <path>", "path to agentdiff.config.ts")
  .action(async (opts) => {
    await ciCommand(opts);
  });

program
  .command("explain")
  .description("Re-run the AI explainer on the most recent compare with more detail.")
  .option("-c, --config <path>", "path to agentdiff.config.ts (its folder holds .agentdiff/)")
  .action(async (opts) => {
    await explainCommand(opts);
  });

program
  .command("report")
  .description("Rebuild a saved comparison's report with the current code, from its saved runs. No model calls.")
  .argument("[dir]", "a .agentdiff/compare-* folder (default: the latest)")
  .option("-c, --config <path>", "path to agentdiff.config.ts (its folder holds .agentdiff/)")
  .option("--comment", "also print the PR comment")
  .action(async (dir, opts) => {
    await reportCommand(dir, opts);
  });

program
  .command("mutate")
  .description(
    "Seed regressions into the agent (one rule sentence or guardrail removed per copy) and count the ones your tests catch.",
  )
  .argument("[file]", "agent file to seed (default: agentPath, else versions.old)")
  .option("-c, --config <path>", "path to agentdiff.config.ts")
  .option("--runs <n>", "runs per test on the agent and on each copy (default 4, at least 2)")
  .option("--max <n>", "most copies to run (default 12)")
  .option(
    "--baseline <dir>",
    "a finished check-* folder of the same agent file: its runs and grades stand in for the agent's",
  )
  .action(async (file, opts) => {
    await mutateCommand(file, opts);
  });

program
  .command("scenarios")
  .description(
    "Write test scenarios from the agent's prompt and tools alone: the conversation so far, the situation, and what each tool answers. Saved for review; the agent doesn't run.",
  )
  .option("-c, --config <path>", "path to agentdiff.config.ts")
  .option("--per-item <n>", "scenarios for each thing to cover (default 2)")
  .option("--avoid <topics>", 'topics to leave out, in plain words (e.g. "medical emergencies, self-harm")')
  .option("--max <n>", "most things to cover the planner may list, before the prompt's rules are added (default 24)")
  .action(async (opts) => {
    await scenariosCommand(opts);
  });

program
  .command("view")
  .description("Open a local page of past comparisons — filter, traces, and the report.")
  .option("-p, --port <number>", "port to serve on (default 4321)")
  .option("--no-open", "don't auto-open the browser")
  .action(async (opts) => {
    await viewCommand(opts);
  });

// `agentdiff` on its own: set up on the first run, then compare against main and open the results.
program.action(async () => {
  await startCommand();
});

program.parseAsync(process.argv).catch((err) => {
  console.error(errMessage(err));
  process.exit(1);
});
