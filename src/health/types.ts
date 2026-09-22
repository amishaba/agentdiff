// `agentdiff check`'s shapes: how one version of the agent behaves on each test.

/** A test's verdict, worst first: what the report and the page sort by. */
export const HEALTH_STATUSES = ["error", "rule", "low", "unsteady", "steady"] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export const HEALTH_LABEL: Record<HealthStatus, string> = {
  error: "Errors",
  rule: "Breaks a test rule",
  low: "Scores low",
  unsteady: "Unpredictable",
  steady: "Steady",
};

/** Below this average grade a test scores low, as a run below it counts as low in a comparison. */
export const LOW_SCORE = 3;

/** One of the test's tool rules: how many finished runs kept it. */
export interface RuleResult {
  tool: string;
  kind: "required" | "forbidden";
  /** Runs that called a required tool, or didn't call a forbidden one. */
  kept: number;
  of: number;
}

export interface TestHealth {
  test: string;
  input: string;
  status: HealthStatus;
  runs: number;
  errors: number;
  rules: RuleResult[];
  /** Average grade out of 5, when the test has grading criteria and runs were graded. */
  score: number | null;
  /** The path most finished runs took, and how many took it. */
  usualPath: { steps: string[]; runs: number; of: number } | null;
  /** Different paths across the finished runs. */
  paths: number;
  /** Where the runs disagree: a tool some call and others don't, replying or not, a check answer, scores from good to bad. Empty when they agree. */
  unsteady: string[];
}

export interface HealthResult {
  agentName: string;
  agentFile: string;
  createdAt: string;
  runsPerTest: number;
  /** False with AGENTDIFF_OFFLINE=1 or in a trial: no grades or checks, only the tool rules and paths. */
  graded: boolean;
  /** A trial: every test run once and not graded, to find tests that expect the wrong thing before paying for a full check. */
  trial?: boolean;
  tests: TestHealth[];
}
