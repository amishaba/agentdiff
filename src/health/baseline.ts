// A finished check standing in for one side of a comparison or a mutation
// run: the same agent file, already run and graded, so it isn't paid for twice.
import path from "node:path";
import type { Verdicts } from "../compare/confirm.ts";
import type { GradeResult } from "../grade/grader.ts";
import { fail } from "../lib/errors.ts";
import { readJson, readJsonDir } from "../storage/fs.ts";
import { CheckDirNameSchema, type CheckResult, type RunRecord, type TestFile } from "../types.ts";
import type { HealthResult } from "./types.ts";

/**
 * A check folder's saved grades and check answers for the runs `keep`
 * accepts. Grades and answers that errored are left out, so they're asked again.
 */
export async function savedVerdicts(
  dir: string,
  keep: (v: { test: string; run: number }) => boolean,
): Promise<Verdicts> {
  const read = async <T extends { test: string; run: number }>(file: string): Promise<T[]> =>
    (await readJson<T[]>(path.join(dir, file)).catch(() => [] as T[])).filter(keep);
  return {
    // A grader error is saved as a score of 1 with the error as its reason: a placeholder, not a grade.
    grades: (await read<GradeResult>("grades.json")).filter((g) => !g.reason.startsWith("grader error:")),
    checks: (await read<CheckResult>("checks.json")).filter((c) => !c.error),
  };
}

/**
 * A saved check's runs and grades as the agent's side: relabelled "old", and
 * only the first `runs` runs of each test. Refused when the check is of
 * another file or is missing runs, since then it isn't the agent's baseline.
 */
export async function savedBaseline(
  workspaceDir: string,
  name: string,
  file: string,
  tests: TestFile[],
  runs: number,
): Promise<{ records: RunRecord[]; verdicts: Verdicts }> {
  const dir = path.join(workspaceDir, CheckDirNameSchema.parse(name));
  const check = await readJson<HealthResult>(path.join(dir, "check.json")).catch(() =>
    fail(`${name} has no check.json: finish it first (agentdiff check --resume ${name}).`),
  );
  if (path.normalize(check.agentFile) !== path.normalize(file))
    fail(`${name} checked ${check.agentFile}, not ${file}: it can't stand in for this agent.`);
  const wanted = (r: { test: string; run: number }) => r.run <= runs && tests.some((t) => t.name === r.test);
  const old = <T extends { version: string }>(list: T[]) => list.map((v) => ({ ...v, version: "old" as const }));
  const records = old((await readJsonDir<RunRecord>(path.join(dir, "runs"))).filter((r) => wanted(r) && !r.error));
  const short = tests.filter((t) => records.filter((r) => r.test === t.name).length < runs).map((t) => t.name);
  if (short.length)
    fail(
      `${name} has fewer than ${runs} finished runs for ${short.length} test(s) (${short.slice(0, 3).join(", ")}): ` +
        `finish it with agentdiff check --resume ${name}, or leave out --baseline.`,
    );
  const saved = await savedVerdicts(dir, wanted);
  return { records, verdicts: { grades: old(saved.grades), checks: old(saved.checks) } };
}
