// How one version of the agent behaves on one test, from its runs and their
// grades and check answers. Pure.
import { compareSides, type Verdicts } from "../compare/confirm.ts";
import { answersToCount } from "../compare/check-rows.ts";
import { dominantSequence } from "../compare/signals.ts";
import type { RunRecord, TestFile } from "../types.ts";
import { LOW_SCORE, type RuleResult, type TestHealth } from "./types.ts";

export function testHealth(t: TestFile, runs: RunRecord[], verdicts: Verdicts, model: string): TestHealth {
  const side = { runs, model };
  const stats = compareSides(t, side, side, verdicts).old;
  const done = runs.filter((r) => !r.error);
  const called = (tool: string) => done.filter((r) => r.tool_calls.some((c) => c.tool === tool)).length;
  const rules: RuleResult[] = [
    ...(t.must_call_tools ?? []).map((tool) => ({
      tool,
      kind: "required" as const,
      kept: called(tool),
      of: done.length,
    })),
    ...(t.must_not_call_tools ?? []).map((tool) => ({
      tool,
      kind: "forbidden" as const,
      kept: done.length - called(tool),
      of: done.length,
    })),
  ];
  const usual = dominantSequence(stats);
  const unsteady = inconsistencies(t, runs, verdicts);
  const health: Omit<TestHealth, "status"> = {
    test: t.name,
    input: t.input,
    runs: runs.length,
    errors: runs.length - done.length,
    rules,
    score: stats.avgGrade,
    usualPath: usual ? { steps: usual.seq, runs: usual.runs, of: usual.of } : null,
    paths: stats.sequences.length,
    unsteady,
  };
  return { ...health, status: statusOf(health) };
}

/** A score spread this wide means some runs did well and others badly, not grader jitter. */
const SCORE_SPREAD = 3;

/**
 * Where the runs disagree with each other. What the agent did is read from the
 * runs themselves: a tool some runs call and others don't, a reply in some and
 * not others. What the judges said needs more: scores from good to bad, or a
 * check answered differently by at least two runs (one with 2 or 3 runs), so
 * one judge's flip on one run isn't called unpredictable.
 */
function inconsistencies(t: TestFile, runs: RunRecord[], verdicts: Verdicts): string[] {
  const done = runs.filter((r) => !r.error);
  if (done.length < 2) return [];
  const out: string[] = [];
  const mixed = (n: number) => n > 0 && n < done.length;
  for (const tool of new Set(done.flatMap((r) => r.tool_calls.map((c) => c.tool))))
    if (mixed(done.filter((r) => r.tool_calls.some((c) => c.tool === tool)).length)) out.push(`tool:${tool}`);
  if (mixed(done.filter((r) => r.final_response?.trim()).length)) out.push("reply");

  const ran = new Set(done.map((r) => r.run));
  const scores = verdicts.grades.filter((g) => g.test === t.name && ran.has(g.run)).map((g) => g.score);
  if (scores.length > 1 && Math.max(...scores) - Math.min(...scores) >= SCORE_SPREAD) out.push("grade");
  const answers = new Map<string, string[]>();
  for (const c of verdicts.checks.filter((c) => c.test === t.name && ran.has(c.run) && !c.error))
    for (const [id, a] of Object.entries(c.answers))
      answers.set(id, [...(answers.get(id) ?? []), a.type === "yes_no" ? String(a.probability >= 0.5) : a.choice]);
  for (const [id, said] of answers) {
    const top = Math.max(...[...new Set(said)].map((v) => said.filter((x) => x === v).length));
    if (said.length - top >= answersToCount(said.length)) out.push(`check:${id}`);
  }
  return out;
}

function statusOf(h: Omit<TestHealth, "status">): TestHealth["status"] {
  if (h.runs && h.errors === h.runs) return "error";
  if (h.rules.some((r) => r.kept < r.of)) return "rule";
  if (h.score != null && h.score < LOW_SCORE) return "low";
  if (h.unsteady.length) return "unsteady";
  if (h.errors) return "error";
  return "steady";
}
