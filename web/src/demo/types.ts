import type { Dataset, RunSummary } from "../data/types.ts";
import type { Incident, Scenario } from "../../../src/dashboard/braintrust/scenario.ts";
import type { DashboardJob, RunSetup } from "../../../src/dashboard/jobs/types.ts";
import type { DraftList, ProjectState } from "../../../src/dashboard/project/types.ts";
import type { ScenarioRun } from "../../../src/dashboard/scenarios/types.ts";
import type { CheckRun } from "../../../src/dashboard/check/types.ts";

export interface SampleDataset extends Dataset {
  report: string;
  detailed: string;
}
export interface DemoFixture {
  datasets: Record<string, SampleDataset>;
  runs: RunSummary[];
  project: ProjectState;
  setup: RunSetup;
  drafts: DraftList;
  incidents: Incident[];
  reviews: Record<string, Scenario>;
  replayDirs: Record<string, string>;
}
export interface DemoState extends DemoFixture {
  /** web/fixtures/scenarios.json: the scenarios page's sample run. */
  scenarioRuns: ScenarioRun[];
  /** web/fixtures/check.json: the check page's sample run. */
  checkRuns: CheckRun[];
  job: DashboardJob | null;
  projectId: string;
  threshold: number;
  receipts: Record<string, { files: string[]; testsDir: string }>;
}
