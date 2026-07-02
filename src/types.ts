import { z } from "zod";

/** agentdiff.config.ts */
export const ConfigSchema = z
  .object({
    agent: z.string().min(1),
    // Single agent file, diffed across git refs by `agentdiff compare <ref>`.
    agentPath: z.string().min(1).optional(),
    // Two-file mode: an explicit old/new pair (used by `baseline` + `compare`).
    versions: z
      .object({
        old: z.string().min(1),
        new: z.string().min(1),
      })
      .optional(),
    tests: z.string().min(1),
    runsPerTest: z.number().int().positive().default(5),
  })
  .refine((c) => c.agentPath != null || c.versions != null, {
    message: "set either `agentPath` (for git compare) or `versions: { old, new }`",
  });
export type Config = z.infer<typeof ConfigSchema>;

/** tests/*.json */
export const TestFileSchema = z.object({
  name: z.string().min(1),
  input: z.string(),
  must_call_tools: z.array(z.string()).optional(),
  grading_criteria: z.string().optional(),
});
export type TestFile = z.infer<typeof TestFileSchema>;

/** .agentdiff/<...>/snapshot.json */
export const SnapshotSchema = z.object({
  name: z.string(),
  instructions: z.string(),
  model: z.string(),
  tools: z.array(z.string()),
  settings: z.record(z.unknown()),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export type Version = "old" | "new";

/** One recorded tool call within a run. */
export const ToolCallSchema = z.object({
  tool: z.string(),
  input: z.unknown().nullable(),
  output: z.unknown().nullable(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

/** The core data structure — one saved agent run. */
export const RunRecordSchema = z.object({
  test: z.string(),
  version: z.enum(["old", "new"]),
  run: z.number().int().positive(),
  input: z.string(),
  tool_calls: z.array(ToolCallSchema),
  final_response: z.string().nullable(),
  steps: z.number().nullable(),
  tokens: z
    .object({ input: z.number().nullable(), output: z.number().nullable() })
    .nullable(),
  latency_ms: z.number().nullable(),
  error: z.string().nullable(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

/** Grader output for a single run. */
export const GradeSchema = z.object({
  score: z.number().min(1).max(5),
  reason: z.string(),
});
export type Grade = z.infer<typeof GradeSchema>;

/** Per-version aggregate stats for a single test. */
export interface VersionStats {
  runs: number;
  errors: number;
  toolCallRate: Record<string, { called: number; of: number }>;
  avgTokensInput: number | null;
  avgTokensOutput: number | null;
  avgCost: number | null;
  avgLatencyMs: number | null;
  avgSteps: number | null;
  avgGrade: number | null;
  gradedRuns: number;
  sampleResponse: string | null;
}

export interface TestComparison {
  test: string;
  gradingCriteria?: string;
  mustCallTools: string[];
  old: VersionStats;
  new: VersionStats;
}

export interface SnapshotDiff {
  instructionsDiff: string; // unified-ish diff text
  toolsAdded: string[];
  toolsRemoved: string[];
  settingsChanged: { key: string; old: unknown; new: unknown }[];
}

/** .agentdiff/compare-<ts>/comparison.json */
export interface Comparison {
  agentName: string;
  oldFile: string;
  newFile: string;
  runsPerTest: number;
  oldSnapshot: Snapshot;
  newSnapshot: Snapshot;
  snapshotDiff: SnapshotDiff;
  tests: TestComparison[];
}
