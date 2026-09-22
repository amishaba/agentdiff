import type { MutantResult, MutationResult } from "./run.ts";

const LABEL: Record<string, string> = {
  rule: "broke a rule",
  worse: "worse",
  better: "better",
  different: "different",
  inconclusive: "didn't repeat",
};

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** "9 of 12 seeded regressions caught" */
export function mutationHeadline(r: MutationResult): string {
  const caught = r.mutants.filter((m) => m.caught).length;
  return `${caught} of ${r.mutants.length} seeded regressions caught`;
}

function flags(m: MutantResult, testCount: number): string {
  if (m.caught)
    return `${m.caughtBy.map((f) => `${f.test} (${LABEL[f.kind]})`).join(", ")} · after ${m.testsRun} of ${testCount} tests`;
  if (m.moved.length) return `not caught; moved in ${m.moved.map((f) => `${f.test} (${LABEL[f.kind]})`).join(", ")}`;
  return "not caught";
}

/** The markdown report: headline, one table with the misses first, and how to read it. */
export function mutationReport(r: MutationResult): string {
  const rows = [...r.mutants].sort((a, b) => Number(a.caught) - Number(b.caught));
  const lines = [
    `# ${mutationHeadline(r)}`,
    "",
    `\`${r.file}\` · ${r.tests} tests × ${r.runsPerTest} runs${r.baseline ? ` · the agent's runs from ${r.baseline}` : ""}`,
    "",
    "| removed | | caught by |",
    "|---|---|---|",
    ...rows.map(
      (m) => `| ${cell(m.removed)}${m.file ? ` (${m.file})` : ""} | ${m.kind} | ${cell(flags(m, r.tests))} |`,
    ),
    "",
    "Each copy is the agent with one rule sentence or one guardrail removed. Caught means a test broke a rule or got worse, in both halves of its runs; a test whose own runs already disagree counts only when it breaks a rule. Each copy runs the tests most related to what it lost first and stops once one catches it, so only a copy nothing caught runs every test. A copy nothing caught is a rule no test exercises, or one the agent follows without being told.",
  ];
  if (r.found > r.mutants.length + r.skipped.length)
    lines.push("", `${r.found} rules and guardrails were found; ${r.mutants.length + r.skipped.length} were seeded.`);
  if (r.skipped.length) lines.push("", "Not run:", ...r.skipped.map((s) => `- ${s.removed}: ${s.reason}`));
  return lines.join("\n") + "\n";
}
