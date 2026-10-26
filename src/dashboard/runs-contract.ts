// What the saved-comparison API sends (runs-api.ts) and the dashboard checks
// on arrival (web/src/data/load.ts). The checks cover the fields the page
// reads rather than every field, so a comparison saved by an older agentdiff
// still opens, and one that can't render fails with a message instead of a
// blank page.
import { z } from "zod";

/** One row of /api/runs. */
const RunSummarySchema = z.object({
  dir: z.string(),
  label: z.string(),
  agentName: z.string().optional(),
  oldFile: z.string().optional(),
  newFile: z.string().optional(),
  tests: z.number().optional(),
  changed: z.number().optional(),
  createdAt: z.string().optional(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const RunListSchema = z.array(RunSummarySchema);

const VersionStatsShape = z.object({
  runs: z.number(),
  errors: z.number(),
  toolCallRate: z.record(z.string(), z.object({ called: z.number(), of: z.number() })),
  sequences: z.array(z.object({ seq: z.array(z.string()), runs: z.number() })),
});

const SnapshotShape = z.object({ instructions: z.string(), tools: z.array(z.string()) });

/** /api/comparison: comparison.json as saved. */
export const ComparisonShape = z.object({
  agentName: z.string(),
  oldFile: z.string(),
  newFile: z.string(),
  runsPerTest: z.number(),
  oldSnapshot: SnapshotShape,
  newSnapshot: SnapshotShape,
  snapshotDiff: z.object({ instructionsDiff: z.string() }),
  tests: z.array(z.object({ test: z.string(), old: VersionStatsShape, new: VersionStatsShape })),
});

const RunShape = z.object({
  test: z.string(),
  version: z.enum(["old", "new"]),
  run: z.number(),
  tool_calls: z.array(z.object({ tool: z.string() })),
});

/** /api/traces: both sides' runs, long fields clipped. */
export const TracesShape = z.object({ old: z.array(RunShape), new: z.array(RunShape) });

/** /api/grades: grades.json, one entry per graded run. */
export const GradesShape = z.array(
  z.object({ test: z.string(), version: z.enum(["old", "new"]), run: z.number(), score: z.number() }),
);

/** /api/explanation */
export const ExplanationSchema = z.object({ text: z.string(), generatedAt: z.string().optional() });
