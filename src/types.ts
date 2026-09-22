import { z } from "zod";
import { DiscoveryConfigSchema, type DiscoveryResult } from "./discovery/types.ts";

/** agentdiff.config.ts */
export const ConfigSchema = z
  .object({
    agent: z.string().min(1),
    // Single agent file, diffed across git refs by `agentdiff compare <ref>`.
    agentPath: z.string().min(1).optional(),
    // Two-file mode: an explicit old/new pair, both run by `compare` with no ref.
    versions: z
      .object({
        old: z.string().min(1),
        new: z.string().min(1),
      })
      .optional(),
    tests: z.string().min(1),
    runsPerTest: z.number().int().positive().default(10),
    // Agent runs at once, old and new interleaved; discovery uses the same limit. Lower it if your provider rate-limits.
    concurrency: z.number().int().positive().default(8),
    // OpenAI Agents SDK: model turns allowed per run (the SDK's own default is 10).
    maxTurns: z.number().int().positive().optional(),
    // Tools that change something outside the agent (send, charge, cancel, refund).
    writeTools: z.array(z.string().min(1)).optional(),
    // Who grades runs and answers checks. AGENTDIFF_GRADER overrides it; Jev when neither is set.
    grader: z.enum(["jev", "openai"]).optional(),
    discovery: DiscoveryConfigSchema.optional(),
  })
  .refine((c) => c.agentPath != null || c.versions != null, {
    message: "set either `agentPath` (for git compare) or `versions: { old, new }`",
  });
export type Config = z.infer<typeof ConfigSchema>;

/** tests/*.json */
export const ReplayResponseSchema = z
  .object({
    tool: z.string().min(1),
    input: z.unknown(),
    output: z.unknown(),
    occurrence: z.number().int().positive(),
    source: z.enum(["recording", "user"]),
  })
  .refine(
    (r) => Object.hasOwn(r, "input") && Object.hasOwn(r, "output"),
    "input and output are required (null is allowed)",
  );
export type ReplayResponse = z.infer<typeof ReplayResponseSchema>;

export const ReplaySchema = z.object({
  incidentId: z.string(),
  projectId: z.string(),
  rootSpanId: z.string(),
  responses: z.array(ReplayResponseSchema),
  reviewed: z.literal(true),
});

/**
 * An outcome check, answered by Jev for every run: a string is a yes/no
 * question; `{ question, options }` picks one option.
 */
export const CheckSchema = z.union([
  z.string().min(1),
  z.object({ question: z.string().min(1), options: z.array(z.string().min(1)).min(2).max(255) }),
]);
export type CheckDefinition = z.infer<typeof CheckSchema>;

/** Checks agentdiff asks of every run; see BUILT_IN_CHECKS in checks.ts. */
export const BUILT_IN_CHECK_IDS = ["failure_type", "acted_before_check"] as const;
export type BuiltInCheckId = (typeof BUILT_IN_CHECK_IDS)[number];

export function isBuiltInCheck(id: string): id is BuiltInCheckId {
  return (BUILT_IN_CHECK_IDS as readonly string[]).includes(id);
}

/** One earlier turn of a conversation test. */
export const TurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});
export type Turn = z.infer<typeof TurnSchema>;

/** A test's messages as text for a grader: earlier turns, then the new one. */
export function transcriptOf(test: { input: string; conversation?: Turn[] }): string {
  if (!test.conversation?.length) return test.input;
  return [...test.conversation.map((t) => `${t.role}: ${t.content}`), `user (new message): ${test.input}`].join("\n");
}

/** How a run that said nothing and called no tools reads to a grader. */
export const NO_REPLY_TEXT = "(no reply: the agent sent nothing)";
/** How a run with tool calls but no final text reads to a grader: what it sent went through its tools. */
export const NO_FINAL_TEXT = "(no final text: anything the agent sent or changed is in its tool calls)";

export const TestFileSchema = z.object({
  name: z.string().min(1),
  /** The new message the agent answers. */
  input: z.string(),
  /** Earlier turns, oldest first, before `input`. */
  conversation: z.array(TurnSchema).optional(),
  /** State the agent's tools read for this test (e.g. the time, a do-not-contact list); passed as the run context. */
  context: z.record(z.string(), z.unknown()).optional(),
  must_call_tools: z.array(z.string()).optional(),
  /** Tools this test must never call, e.g. send_sms after STOP. */
  must_not_call_tools: z.array(z.string()).optional(),
  grading_criteria: z.string().optional(),
  checks: z
    .record(
      z
        .string()
        .regex(/^[A-Za-z0-9_-]+$/, "check ids use letters, digits, _ and -")
        .refine(
          (id) => !isBuiltInCheck(id),
          `${BUILT_IN_CHECK_IDS.join(" and ")} are built-in checks; pick another id`,
        ),
      CheckSchema,
    )
    .optional(),
  replay: ReplaySchema.optional(),
  /**
   * Scripted tool answers for this test, by tool name: the outputs it returns in
   * call order, the last one again once they run out. The agent's own tools
   * never run, and a call to a tool not listed here stops the run.
   */
  tool_responses: z.record(z.string(), z.array(z.unknown()).min(1)).optional(),
});
export type TestFile = z.infer<typeof TestFileSchema>;

/** .agentdiff/<...>/snapshot.json */
export const SnapshotSchema = z.object({
  name: z.string(),
  instructions: z.string(),
  model: z.string(),
  tools: z.array(z.string()),
  // Some Mastra agents orchestrate via workflows instead of (or alongside) tools.
  workflows: z.array(z.string()).default([]),
  settings: z.record(z.string(), z.unknown()),
  toolDefinitions: z
    .record(
      z.string(),
      z.object({
        description: z.string(),
        inputSchema: z.unknown().optional(),
        outputSchema: z.unknown().optional(),
      }),
    )
    .optional(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export type Version = "old" | "new";

/** One recorded tool call within a run. */
export const ToolCallSchema = z.object({
  tool: z.string(),
  input: z.unknown().nullable(),
  output: z.unknown().nullable(),
  /** The framework's call id, when it has one. */
  id: z.string().optional(),
  /** The agent that made the call, in a team of agents. */
  agent: z.string().optional(),
  /** When the call started, in ms since the run began; absent when the framework doesn't say. */
  at_ms: z.number().nonnegative().optional(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

/** The core data structure — one saved agent run. */
/** Jev's answer to one question an agent asked during a run. */
export const DecisionAnswerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("boolean"), probability: z.number() }),
  z.object({ type: z.literal("choice"), choice: z.string() }),
  z.object({ type: z.literal("score"), score: z.number() }),
]);

/**
 * A check the agent under test ran during a run: a Jev question as sent and
 * answered, a framework guardrail (yes = it tripped), or a check a function
 * agent reports itself.
 */
export const DecisionSchema = z.object({
  id: z.string(),
  type: z.enum(["boolean", "choice", "score"]),
  instructions: z.string(),
  options: z.array(z.string()).optional(),
  answer: DecisionAnswerSchema,
  /** Where it came from; absent means Jev. */
  source: z.enum(["jev", "guardrail", "agent"]).optional(),
  /** When it was asked, in ms since the run began. */
  at_ms: z.number().nonnegative().optional(),
  /** How many of the run's tool calls came before it; absent when unknown. */
  after: z.number().int().nonnegative().optional(),
});
export type Decision = z.infer<typeof DecisionSchema>;

export const RunRecordSchema = z.object({
  test: z.string(),
  version: z.enum(["old", "new"]),
  run: z.number().int().positive(),
  input: z.string(),
  tool_calls: z.array(ToolCallSchema),
  final_response: z.string().nullable(),
  steps: z.number().nullable(),
  tokens: z.object({ input: z.number().nullable(), output: z.number().nullable() }).nullable(),
  latency_ms: z.number().nullable(),
  error: z.string().nullable(),
  replay: z
    .object({
      incidentId: z.string(),
      status: z.enum(["complete", "blocked", "error"]),
      missing: z.array(z.object({ tool: z.string(), input: z.unknown(), occurrence: z.number() })),
    })
    .optional(),
  /** Jev decisions the agent made during the run, in order; absent when it made none. */
  decisions: z.array(DecisionSchema).optional(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

/** Grader output for a single run. */
export const GradeSchema = z.object({
  score: z.number().min(1).max(5),
  reason: z.string(),
});
export type Grade = z.infer<typeof GradeSchema>;

/**
 * One distinct tool-call sequence and how many runs followed it, e.g.
 * `{ seq: ["lookup_customer", "refund_customer"], runs: 4 }`. An empty `seq`
 * is a run that answered without calling any tool.
 */
export interface SequenceCount {
  seq: string[];
  runs: number;
}

/** Jev's answer to one outcome check for one run. */
export type CheckAnswer =
  { type: "yes_no"; probability: number } | { type: "choice"; choice: string; probabilities: Record<string, number> };

/** .agentdiff/compare-<ts>/checks.json, one entry per run. */
export interface CheckResult {
  test: string;
  version: Version;
  run: number;
  answers: Record<string, CheckAnswer>;
  error?: string;
  /** The checks, criteria and tool descriptions it was judged against, fingerprinted (grade/basis.ts). */
  basis?: string;
}

/** One check across a version's runs: how many said yes, or how many picked each option. */
export type CheckStats =
  | { question: string; kind: "yes_no"; yes: number; of: number }
  | { question: string; kind: "choice"; options: string[]; counts: Record<string, number>; of: number };

/**
 * One Jev question across a version's runs. `runsAsking` of `runs` asked it at
 * least once; answers are tallied over all `asks`.
 */
export interface DecisionStats {
  type: Decision["type"];
  /** Where the check came from; absent means Jev. */
  source?: Decision["source"];
  /** The wording seen most often, to spot rewording between versions. */
  instructions: string;
  runs: number;
  runsAsking: number;
  asks: number;
  /** boolean: asks answered yes (probability ≥ 0.5). */
  yes?: number;
  /** choice: asks per option picked. */
  counts?: Record<string, number>;
  /** score: mean of the scores. */
  meanScore?: number;
}

/** Per-version aggregate stats for a single test. */
export interface VersionStats {
  runs: number;
  errors: number;
  toolCallRate: Record<string, { called: number; of: number }>;
  /**
   * Distinct tool-call sequences across the runs, most common first. Per-tool
   * rates say *whether* a tool fired; this says in what *order*, which is where
   * "verify before refund" regressions actually show up.
   */
  sequences: SequenceCount[];
  avgTokensInput: number | null;
  avgTokensOutput: number | null;
  avgCost: number | null;
  avgLatencyMs: number | null;
  avgSteps: number | null;
  avgGrade: number | null;
  gradedRuns: number;
  sampleResponse: string | null;
  /** The first error message, so an all-errored side can say why. */
  sampleError: string | null;
  /** Outcome checks by id, when the test defines any and Jev answered them. */
  checks?: Record<string, CheckStats>;
  /** Jev questions the agent itself asked, by question id. */
  decisions?: Record<string, DecisionStats>;
  /** Finished runs that ended with a reply; absent in comparisons saved before it was counted. */
  replied?: { runs: number; of: number };
}

export interface TestComparison {
  test: string;
  input?: string;
  gradingCriteria?: string;
  mustCallTools: string[];
  mustNotCallTools?: string[];
  /**
   * Checks the agent runs in only one version, across every test (added or
   * removed). Asking one on one side isn't a behaviour change by itself.
   */
  oneSidedChecks?: string[];
  old: VersionStats;
  new: VersionStats;
  /**
   * The runs split into two halves, with the change signals (see
   * changeSignals) that moved in each half, those that moved between the old
   * agent's own two halves (noise), and those that moved in both halves but
   * not in the noise. Absent with fewer than 2 runs per test.
   */
  confirmation?: Confirmation;
}

export interface Confirmation {
  first: string[];
  second: string[];
  noise: string[];
  confirmed: string[];
}

export interface SnapshotDiff {
  instructionsDiff: string; // unified-ish diff text
  toolsAdded: string[];
  toolsRemoved: string[];
  workflowsAdded: string[];
  workflowsRemoved: string[];
  settingsChanged: { key: string; old: unknown; new: unknown }[];
  toolDefinitionsChanged?: string[];
}

/** The fixed stages every `compare` runs, in order. */
export const STAGES = ["collect", "snapshot", "run", "discover", "judge", "explain", "save"] as const;
export type StageName = (typeof STAGES)[number];

/**
 * How one stage went. `blocked` means it couldn't run (a missing key, an
 * agent type it doesn't support yet) and `detail` says why; `skipped` means
 * there was nothing for it to do.
 */
export interface StageResult {
  stage: StageName;
  status: "done" | "skipped" | "blocked" | "error";
  detail: string;
  ms: number;
}

/** A saved comparison's directory name under .agentdiff/, e.g. `compare-2026-07-29T16-04-33-120-1a2b3c4d`. */
export const CompareDirNameSchema = z.string().regex(/^compare-[\w:.-]+$/);
/** .agentdiff/check-<time>: one run of `agentdiff check`. */
export const CheckDirNameSchema = z.string().regex(/^check-[\w:.-]+$/);
/** .agentdiff/scenarios-<time>: one run of `agentdiff scenarios`. */
export const ScenarioDirNameSchema = z.string().regex(/^scenarios-[\w:.-]+$/);

/** .agentdiff/compare-<ts>/comparison.json */
export interface Comparison {
  /** The check-* folder whose runs and grades are the old side (compare --baseline). Its run times were measured earlier, so they aren't compared. */
  baseline?: string;
  /** Each stage's outcome, in order; absent in comparisons saved before stages were recorded. */
  stages?: StageResult[];
  discovery?: DiscoveryResult;
  agentName: string;
  oldFile: string;
  newFile: string;
  runsPerTest: number;
  createdAt?: string;
  explanation?: string;
  oldSnapshot: Snapshot;
  newSnapshot: Snapshot;
  snapshotDiff: SnapshotDiff;
  /** Who graded the runs and answered the checks. */
  grader?: "jev" | "openai";
  /** The config's writeTools, kept so reports can mark them. */
  writeTools?: string[];
  tests: TestComparison[];
}
