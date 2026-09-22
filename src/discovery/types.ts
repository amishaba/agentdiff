import { z } from "zod";
import type { RunRecord, Snapshot, TestFile, Turn, Version, VersionStats } from "../types.ts";

export const DiscoveryConfigSchema = z
  .object({
    /**
     * What answers the agents' tools during discovery. "fixtures" (the default):
     * the handlers in `fixtures`, the same for both agents. "own": each agent's
     * own tools, for projects whose tools are already a simulated world, so a
     * change inside a tool shows up. Never "own" with tools that reach the real world.
     */
    tools: z.enum(["fixtures", "own"]).default("fixtures"),
    fixtures: z.string().min(1).optional(),
    context: z.string().max(12_000).default(""),
    maxCandidates: z.number().int().min(1).max(30).default(12),
    maxRounds: z.number().int().min(1).max(5).default(3),
    maxAgentRuns: z.number().int().min(20).max(1000).default(400),
    confirmationRuns: z.number().int().min(3).max(10).default(3),
    maxFindings: z.number().int().min(1).max(10).default(6),
    timeoutMs: z.number().int().min(100).max(300_000).default(120_000),
    maxSteps: z.number().int().min(1).max(100).default(40),
  })
  .refine((c) => c.maxAgentRuns >= 8 + c.confirmationRuns * 4, {
    message: "maxAgentRuns must cover screening and fresh confirmation of at least one experiment",
  });
export type DiscoveryConfig = z.infer<typeof DiscoveryConfigSchema>;

const Context = z.record(z.string(), z.unknown());
// ../types.ts imports this module's config schema, so the turn shape is repeated here rather than imported.
const TurnSchema = z.object({ role: z.enum(["user", "assistant"]), content: z.string() });

/**
 * One experiment: two cases that differ in one detail, the message, an
 * earlier turn or a context value, each with what the agent should do.
 * Cases usually start from an existing test's conversation and context.
 */
export const ProbeSchema = z.object({
  name: z.string().min(1).max(120),
  strategy: z.enum(["wording", "paraphrase", "boundary", "interaction", "injection"]),
  changeId: z.string().min(1).max(200),
  hypothesis: z.string().min(1).max(600),
  /** The existing test the cases start from, if any. */
  baseTest: z.string().max(200).optional(),
  /** Earlier turns both cases share. */
  conversation: z.array(TurnSchema).max(20).optional(),
  control: z.string().min(1).max(4_000),
  variant: z.string().min(1).max(4_000),
  controlContext: Context.optional(),
  variantContext: Context.optional(),
  /** What the agent should do in each case; each is judged against its own. */
  controlExpected: z.string().min(1).max(600).optional(),
  variantExpected: z.string().min(1).max(600).optional(),
  targetTools: z.array(z.string().min(1)).max(20),
});
export type Probe = z.infer<typeof ProbeSchema>;

/**
 * The planner's shape for a probe: every field present (OpenAI's structured
 * outputs need that), nulls for "none", and contexts as JSON text.
 */
export const PlannedProbeSchema = z.object({
  name: z.string(),
  strategy: z.enum(["wording", "paraphrase", "boundary", "interaction", "injection"]),
  changeId: z.string(),
  hypothesis: z.string(),
  baseTest: z.string().nullable(),
  conversation: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })).nullable(),
  control: z.string(),
  variant: z.string(),
  controlContextJson: z
    .string()
    .nullable()
    .describe("The control case's full context as a JSON object, or null for none"),
  variantContextJson: z
    .string()
    .nullable()
    .describe("The variant case's full context as a JSON object, or null for none"),
  controlExpected: z.string().describe("What the agent should do in the control case"),
  variantExpected: z
    .string()
    .describe(
      "What the agent should do in the variant case. It can differ from the control's: flipping do_not_contact changes the right answer.",
    ),
  targetTools: z.array(z.string()),
});

/** What one side of an experiment sends the agent. */
export interface ProbeCase {
  input: string;
  conversation?: Turn[];
  context?: Record<string, unknown>;
  /** The existing test the probe starts from, if any. */
  baseTest?: string;
}
export interface Change {
  id: string;
  before: unknown;
  after: unknown;
}
export interface PlannerContext {
  oldSnapshot: Snapshot;
  newSnapshot: Snapshot;
  changes: Change[];
  existingTests: TestFile[];
  testContext: string;
}
export interface Pattern {
  calls: Array<{ tool: string; input?: unknown }>;
  count: number;
  total: number;
}
export interface BehaviorDifference {
  kind: "sequence" | "arguments";
  old: Pattern;
  new: Pattern;
  /** Canonical identity used to check that fresh trials reproduce the same difference. */
  key: string;
}
export interface CaseResult {
  input: string;
  conversation?: Turn[];
  context?: Record<string, unknown>;
  /** What the agent should do here, from the planner. */
  expected?: string;
  old: RunRecord[];
  new: RunRecord[];
  difference: BehaviorDifference | null;
}
export interface Experiment {
  id: string;
  probe: Probe;
  phase: "screen" | "shrink" | "confirm";
  parentId?: string;
  cases: [CaseResult, CaseResult];
  status: "observed" | "same" | "inconclusive" | "blocked";
}
export interface Finding {
  id: string;
  experimentId: string;
  originalExperimentId: string;
  probe: Probe;
  cases: [CaseResult, CaseResult];
  reproducedCases: number[];
  shortened: boolean;
  /** Each case's confirmation runs, judged like suite runs against the case's expected behaviour. */
  judged?: { old: VersionStats; new: VersionStats }[];
  /** Each case's label from those verdicts: "rule", "worse", "better", "different", "same". */
  kinds?: string[];
}
export interface DiscoveryResult {
  status: "running" | "complete" | "limited" | "blocked" | "error";
  reason?: string;
  config: DiscoveryConfig;
  changes: Change[];
  agentRuns: number;
  plannerCalls: number;
  experiments: Experiment[];
  findings: Finding[];
  notices: string[];
}
export interface Planner {
  /** Proposed experiments, in the planner's shape or a stored Probe's; validateProbe checks each. */
  generate(context: PlannerContext, feedback: Experiment[], count: number): Promise<unknown[]>;
  shorten(context: PlannerContext, experiment: Experiment): Promise<unknown | null>;
}
export type ProbeRunner = (probe: ProbeCase, version: Version, run: number, testName: string) => Promise<RunRecord>;

/** Called once per agent attempt with that case's context (and the case). Return fresh fixture state each time. */
export type FixtureFactory = (
  context?: Record<string, unknown>,
  probe?: ProbeCase,
) => Record<string, (input: unknown) => unknown | Promise<unknown>>;
