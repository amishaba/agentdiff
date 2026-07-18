import { generateObject } from "ai";
import { z } from "zod";
import type { RunRecord, TestFile, Version } from "./types.ts";
import { graderModel, hasApiKey, mapLimit, NO_KEY_HINT } from "./ai.ts";

const GEN_SCHEMA = z.object({
  score: z.number().describe("Quality score from 1 (fails the criteria) to 5 (fully meets it)."),
  reason: z.string().describe("One or two sentences explaining the score."),
});

export interface GradeResult {
  test: string;
  version: Version;
  run: number;
  score: number;
  reason: string;
}

function clampScore(n: number): number {
  if (Number.isNaN(n)) return 1;
  return Math.max(1, Math.min(5, n));
}

async function gradeOne(criteria: string, input: string, response: string): Promise<{ score: number; reason: string }> {
  const { object } = await generateObject({
    model: graderModel(),
    schema: GEN_SCHEMA,
    temperature: 0,
    prompt:
      `You are grading a single AI agent response against a criteria.\n\n` +
      `Criteria: ${criteria}\n\n` +
      `User input: ${input}\n\n` +
      `Agent response: ${response}\n\n` +
      `Score 1-5 for how well the response meets the criteria (5 = fully meets, 1 = fails).`,
  });
  return { score: clampScore(object.score), reason: object.reason };
}

/**
 * Grade every run that (a) belongs to a test with grading_criteria and
 * (b) produced a non-empty response. Returns per-run results.
 * Returns an empty array (with a warning) if no API key is set.
 */
export async function gradeRecords(records: RunRecord[], tests: TestFile[]): Promise<GradeResult[]> {
  const criteriaByTest = new Map<string, string>();
  for (const t of tests) {
    if (t.grading_criteria) criteriaByTest.set(t.name, t.grading_criteria);
  }
  if (criteriaByTest.size === 0) return [];

  if (!hasApiKey()) {
    console.warn(`  (skipping AI grading — ${NO_KEY_HINT})`);
    return [];
  }

  const gradable = records.filter(
    (r) => criteriaByTest.has(r.test) && !r.error && r.final_response && r.final_response.trim().length > 0,
  );

  return mapLimit(gradable, 3, async (r) => {
    try {
      const { score, reason } = await gradeOne(criteriaByTest.get(r.test)!, r.input, r.final_response!);
      return { test: r.test, version: r.version, run: r.run, score, reason };
    } catch (err) {
      return {
        test: r.test,
        version: r.version,
        run: r.run,
        score: 1,
        reason: `grader error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });
}

/** Group grade scores by "test::version" for stat aggregation. */
export function scoresByTestVersion(grades: GradeResult[]): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const g of grades) {
    const key = `${g.test}::${g.version}`;
    const arr = map.get(key) ?? [];
    arr.push(g.score);
    map.set(key, arr);
  }
  return map;
}
