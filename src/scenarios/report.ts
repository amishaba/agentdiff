// scenarios-<time>/report.md: what the drafts cover, and what they don't.
import { AREA_LABEL, COVERAGE_AREAS, type ScenarioResult } from "./types.ts";

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Coverage items no scenario was kept for. */
const gapsOf = (result: ScenarioResult) =>
  result.plan.filter((item) => !result.drafts.some((d) => d.coverageId === item.id));

/** "38 scenarios for 21 things to cover · 2 gaps" */
export function scenariosHeadline(result: ScenarioResult): string {
  const gaps = gapsOf(result).length;
  return `${plural(result.drafts.length, "scenario")} for ${plural(result.plan.length, "thing")} to cover · ${gaps ? plural(gaps, "gap") : "no gaps"}`;
}

export function coverageReport(result: ScenarioResult, testsDir: string): string {
  const gaps = gapsOf(result);
  const lines = [
    `# Scenarios: ${result.agentName}`,
    "",
    `${plural(result.drafts.length, "scenario")} for ${plural(result.plan.length, "thing")} to cover, written from the prompt and tools in \`${result.agentFile}\`. ${gaps.length ? `${plural(gaps.length, "gap")}.` : "No gaps."}`,
    "",
    `Each scenario is a test file in \`tests/\` next to this report: the conversation so far, the situation, the next message, and what every tool answers. Read them, keep the ones that describe what the agent should do, and copy those into \`${testsDir}\`.`,
  ];
  for (const area of COVERAGE_AREAS) {
    const items = result.plan.filter((item) => item.area === area);
    if (!items.length) continue;
    lines.push("", `## ${AREA_LABEL[area]}`, "", "| | Covers | Scenarios |", "|---|---|---|");
    for (const item of items) {
      const files = result.drafts.filter((d) => d.coverageId === item.id).map((d) => `\`${d.file}\``);
      lines.push(`| ${item.id} | ${cell(item.title)} | ${files.length ? files.join(", ") : "**none**"} |`);
    }
  }
  if (gaps.length || result.dropped.length || result.planError) lines.push("", "## Not written");
  if (result.planError)
    lines.push(`- Planning failed (${result.planError}), so only the prompt's rule sentences were covered.`);
  for (const f of result.failed) lines.push(`- ${f.coverageId}: the writer failed (${f.reason})`);
  for (const d of result.dropped) lines.push(`- ${d.coverageId} "${d.name}": dropped, ${d.reason}`);
  return lines.join("\n") + "\n";
}
