import path from "node:path";
import { runCheck } from "../pipeline/check.ts";
import { brokenRules, byStatus, describeBrokenRule, healthDetail, healthHeadline } from "../health/describe.ts";
import { HEALTH_LABEL } from "../health/types.ts";
import { TerminalReporter } from "./terminal-reporter.ts";

export async function checkCommand(
  file: string | undefined,
  opts: { config?: string; runs?: string; resume?: string; trial?: boolean } = {},
): Promise<void> {
  const { dir, result } = await runCheck({
    config: opts.config,
    file,
    runs: opts.runs ? Number(opts.runs) : undefined,
    resume: opts.resume,
    trial: opts.trial,
    reporter: new TerminalReporter(),
  });
  console.log(`\n${healthHeadline(result)}`);
  if (result.trial) {
    const broken = brokenRules(result.tests);
    if (broken.length)
      console.log(`\nRules broken most (one rule broken in many tests is worth reading those tests first):`);
    for (const b of broken.slice(0, 10)) console.log(`  ${describeBrokenRule(b)}`);
    console.log(`\n${path.join(dir, "report.md")}`);
    console.log(`To keep these runs, run the rest and grade: npx agentdiff check --resume ${path.basename(dir)}`);
    return;
  }
  for (const t of byStatus(result.tests).filter((t) => t.status !== "steady"))
    console.log(
      `  ${HEALTH_LABEL[t.status].toLowerCase()}: ${t.test}${healthDetail(t) ? ` (${healthDetail(t)})` : ""}`,
    );
  console.log(`\n${path.join(dir, "report.md")}`);
}
