import { fail } from "../lib/errors.ts";
import { compareTests } from "../compare/confirm.ts";
import type { GradeResult } from "../grade/grader.ts";
import { buildReport } from "../report/markdown.ts";
import { exists, writeJson, writeText } from "../storage/fs.ts";
import { comparisonFile, readComparison, readComparisonRuns, readOptionalList } from "../storage/comparison.ts";
import {
  isBuiltInCheck,
  type CheckDefinition,
  type CheckResult,
  type Comparison,
  type TestComparison,
  type TestFile,
} from "../types.ts";

/** What a saved test comparison says about its test: enough to recompute its stats. */
function testOf(t: TestComparison): TestFile {
  const checks: Record<string, CheckDefinition> = {};
  for (const [id, s] of Object.entries({ ...t.old.checks, ...t.new.checks })) {
    if (!isBuiltInCheck(id))
      checks[id] = s.kind === "yes_no" ? s.question : { question: s.question, options: s.options };
  }
  return {
    name: t.test,
    input: t.input ?? "",
    must_call_tools: t.mustCallTools,
    ...(t.mustNotCallTools?.length ? { must_not_call_tools: t.mustNotCallTools } : {}),
    ...(t.gradingCriteria ? { grading_criteria: t.gradingCriteria } : {}),
    ...(Object.keys(checks).length ? { checks } : {}),
  };
}

/**
 * Rebuild a saved comparison with the current code: every test's stats, the
 * two-half confirmation and the labels from its saved runs, grades and check
 * answers, then report.md. No model calls; the explanation, discovery and
 * stages are kept as saved.
 */
export async function rebuildReport(
  dir: string,
): Promise<{ comparison: Comparison; report: string; reportPath: string; comparisonPath: string; runs: number }> {
  const comparisonPath = comparisonFile(dir, "comparison");
  if (!(await exists(comparisonPath)))
    fail(`${comparisonPath} not found. Pass a folder that "agentdiff compare" wrote.`);
  const c = await readComparison(dir);
  const { old: oldRuns, new: newRuns } = await readComparisonRuns(dir);
  if (!oldRuns.length || !newRuns.length)
    fail(`${dir} has no saved runs for ${!oldRuns.length ? "the old agent (old-runs/)" : "the new agent (runs/)"}.`);

  const rebuilt = compareTests(
    c.tests.map(testOf),
    { records: oldRuns, model: c.oldSnapshot.model },
    { records: newRuns, model: c.newSnapshot.model },
    {
      grades: await readOptionalList<GradeResult>(dir, "grades"),
      checks: await readOptionalList<CheckResult>(dir, "checks"),
    },
    c.runsPerTest,
  );
  // Keep what the runs don't say: the input as the test had it.
  c.tests = rebuilt.map((t, i) => ({ ...t, input: c.tests[i].input }));
  await writeJson(comparisonPath, c);

  const report = buildReport(c, c.explanation ?? "");
  const reportPath = comparisonFile(dir, "report");
  await writeText(reportPath, report);
  return { comparison: c, report, reportPath, comparisonPath, runs: oldRuns.length + newRuns.length };
}
