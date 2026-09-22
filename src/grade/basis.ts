// What a grade or a check answer was judged against, as a short fingerprint
// saved with it. A saved verdict is reused (check --resume, --baseline) only
// while the test still says the same thing; edit a test's grading criteria or
// checks and its runs are judged again.
import type { Verdicts } from "../compare/confirm.ts";
import type { RunRecord, TestFile } from "../types.ts";

/** FNV-1a, 32 bits, hex: enough to tell one wording from another. */
function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

export const gradeBasis = (t: TestFile) => fingerprint(t.grading_criteria ?? "");

/** Check answers also depend on the tools' descriptions and which tools change things, which the checks are told. */
export const checkBasis = (t: TestFile, tools: Record<string, string>, writeTools: string[] = []) =>
  fingerprint(JSON.stringify([t.checks ?? {}, t.grading_criteria ?? "", tools, writeTools]));

/**
 * The saved grades and check answers still valid for these tests. One saved
 * before fingerprints were recorded has nothing to compare, and is kept.
 */
export function stillValid(
  saved: Verdicts,
  tests: TestFile[],
  tools: Record<string, string>,
  writeTools?: string[],
): Verdicts {
  const byName = new Map(tests.map((t) => [t.name, t]));
  return {
    grades: saved.grades.filter((g) => {
      const t = byName.get(g.test);
      return t && (g.basis == null || g.basis === gradeBasis(t));
    }),
    checks: saved.checks.filter((c) => {
      const t = byName.get(c.test);
      return t && (c.basis == null || c.basis === checkBasis(t, tools, writeTools));
    }),
  };
}

/** The runs that still need a grade, and those that still need check answers, given the verdicts kept for them. */
export function stillToJudge(kept: Verdicts, records: RunRecord[]): { ungraded: RunRecord[]; unchecked: RunRecord[] } {
  const key = (r: { version: string; test: string; run: number }) => `${r.version}#${r.test}#${r.run}`;
  const graded = new Set(kept.grades.map(key));
  const checked = new Set(kept.checks.map(key));
  return {
    ungraded: records.filter((r) => !graded.has(key(r))),
    unchecked: records.filter((r) => !checked.has(key(r))),
  };
}
