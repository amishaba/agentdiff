import path from "node:path";
import { draftScenarios } from "../pipeline/scenarios.ts";
import { scenariosHeadline } from "../scenarios/report.ts";
import { TerminalReporter } from "./terminal-reporter.ts";

export async function scenariosCommand(
  opts: { config?: string; perItem?: string; max?: string; avoid?: string } = {},
): Promise<void> {
  const { dir, result } = await draftScenarios({
    config: opts.config,
    perItem: opts.perItem ? Number(opts.perItem) : undefined,
    maxItems: opts.max ? Number(opts.max) : undefined,
    avoid: opts.avoid,
    reporter: new TerminalReporter(),
  });
  console.log(`\n${scenariosHeadline(result)}`);
  for (const f of result.failed) console.log(`  not written: ${result.plan.find((i) => i.id === f.coverageId)?.title}`);
  console.log(`\nReview them in ${path.join(dir, "tests")}`);
  console.log(path.join(dir, "report.md"));
}
