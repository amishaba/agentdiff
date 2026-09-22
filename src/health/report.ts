// check-<time>/report.md: each test's verdict, worst first.
import { brokenRules, byStatus, describeBrokenRule, healthDetail, healthHeadline } from "./describe.ts";
import { HEALTH_LABEL, type HealthResult } from "./types.ts";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function healthReport(result: HealthResult): string {
  const lines = [
    `# ${healthHeadline(result)}`,
    "",
    `\`${result.agentFile}\` (${result.agentName}), every test run ${plural(result.runsPerTest, "time")}. A test is unpredictable when its runs disagree: a tool some call and others don't, replying or not, a check answer, or scores from good to bad.${notGraded(result)}`,
    "",
    ...trialSection(result),
    "| Test | Verdict | Score | Usual path | What happened |",
    "|---|---|---|---|---|",
  ];
  for (const t of byStatus(result.tests)) {
    const path = t.usualPath ? `${t.usualPath.runs}/${t.usualPath.of} runs · ${t.paths} paths` : "–";
    lines.push(
      `| ${cell(t.test)} | ${HEALTH_LABEL[t.status]} | ${t.score == null ? "–" : t.score.toFixed(1)} | ${path} | ${cell(healthDetail(t) || "–")} |`,
    );
  }
  return lines.join("\n") + "\n";
}

function notGraded(result: HealthResult): string {
  if (result.graded) return "";
  return result.trial
    ? " A trial: not graded, only the tool rules. `npx agentdiff check --resume <this folder>` keeps these runs, runs the rest and grades them all."
    : " Not graded: AGENTDIFF_OFFLINE=1 checks only the tool rules and paths.";
}

/** In a trial, the rules broken most: where to look for tests that expect the wrong thing. */
function trialSection(result: HealthResult): string[] {
  const broken = result.trial ? brokenRules(result.tests) : [];
  if (!broken.length) return [];
  return ["## Rules broken most", "", ...broken.map((b) => `- ${describeBrokenRule(b)}`), ""];
}
