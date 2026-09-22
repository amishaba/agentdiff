import path from "node:path";
import { runMutation } from "../mutate/run.ts";
import { mutationHeadline } from "../mutate/report.ts";
import { TerminalReporter } from "./terminal-reporter.ts";

export async function mutateCommand(
  file: string | undefined,
  opts: { config?: string; runs?: string; max?: string; baseline?: string } = {},
): Promise<void> {
  const { dir, result } = await runMutation({
    config: opts.config,
    file,
    runs: opts.runs ? Number(opts.runs) : undefined,
    max: opts.max ? Number(opts.max) : undefined,
    baseline: opts.baseline,
    reporter: new TerminalReporter(),
  });
  console.log(`\n${mutationHeadline(result)}`);
  for (const m of result.mutants.filter((x) => !x.caught)) console.log(`  not caught: ${m.removed}`);
  console.log(`\n${path.join(dir, "report.md")}`);
}
