// The scenarios page's API: saved runs, one run's drafts, adding drafts to the suite.
import type { ScenarioRun, ScenarioRunSummary } from "../../../src/dashboard/scenarios/types.ts";
import type { SavedTests } from "../../../src/dashboard/project/types.ts";
import { localJson } from "./jobs.ts";

export const listScenarioRuns = () => localJson<ScenarioRunSummary[]>("/api/scenarios");

export const readScenarioRun = (dir: string) =>
  localJson<ScenarioRun>(`/api/scenarios/run?dir=${encodeURIComponent(dir)}`);

/** One request id per click, so a retried request can't add the drafts twice. */
export const addScenarios = (dir: string, files: string[]) =>
  localJson<SavedTests>("/api/scenarios/add", { requestId: crypto.randomUUID(), dir, files });
