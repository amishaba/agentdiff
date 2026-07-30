import { Command } from "commander";
import { baselineCommand } from "./commands/baseline.ts";
import { compareCommand } from "./commands/compare.ts";
import { explainCommand } from "./commands/explain.ts";
import { generateTestsCommand } from "./commands/generate-tests.ts";
import { viewCommand } from "./commands/view.ts";
import { errMessage } from "./config.ts";

const program = new Command();

program
  .name("agentdiff")
  .description("Compare two versions of a Mastra agent and report how its behaviour changed.")
  .version("0.1.0");

program
  .command("baseline")
  .description("Snapshot and run the OLD agent, saving results as the baseline.")
  .option("-c, --config <path>", "path to agentdiff.config.ts")
  .action(async (opts) => {
    await baselineCommand(opts);
  });

program
  .command("compare")
  .description("Run the NEW agent and compare it against a git ref (or the saved baseline), then write a report.")
  .argument("[ref]", "git ref to compare the working tree against (e.g. HEAD~1, main). Omit to compare against the saved baseline.")
  .option("-c, --config <path>", "path to agentdiff.config.ts")
  .action(async (ref, opts) => {
    await compareCommand(ref, opts);
  });

program
  .command("generate-tests")
  .description("Draft test scenarios from the agent's prompt + tools using an LLM. Review before trusting.")
  .option("-c, --config <path>", "path to agentdiff.config.ts")
  .option("-n, --count <number>", "how many scenarios to generate (default 12, max 30)")
  .action(async (opts) => {
    await generateTestsCommand(opts);
  });

program
  .command("explain")
  .description("Re-run the AI explainer on the most recent compare with more detail.")
  .action(async () => {
    await explainCommand();
  });

program
  .command("view")
  .description("Open a local web view of the comparison reports.")
  .option("-p, --port <number>", "port to serve on (default 4321)")
  .option("--no-open", "don't auto-open the browser")
  .action(async (opts) => {
    await viewCommand(opts);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(errMessage(err));
  process.exit(1);
});
