// What the scenarios page shows, derived from a saved run. Pure.
import { COVERAGE_AREAS, type CoverageArea, type CoverageItem } from "../../../src/scenarios/types.ts";
import type { ReviewScenario, ScenarioRun } from "../../../src/dashboard/scenarios/types.ts";

/** A draft as the table lists it, with the coverage item it was written for. */
export interface ScenarioRow extends ReviewScenario {
  item: CoverageItem;
}

export function scenarioRows(run: ScenarioRun): ScenarioRow[] {
  const items = new Map(run.plan.map((i) => [i.id, i]));
  return run.drafts.flatMap((d) => {
    const item = items.get(d.coverageId);
    return item ? [{ ...d, item }] : [];
  });
}

/** Each coverage item with how many scenarios were kept for it; zero is a gap. */
export function coverage(run: ScenarioRun): { item: CoverageItem; scenarios: number }[] {
  return run.plan.map((item) => ({ item, scenarios: run.drafts.filter((d) => d.coverageId === item.id).length }));
}

/** How many rows fall in each area, in area order, leaving out empty ones. */
export function areaCounts(rows: { item: CoverageItem }[]): [CoverageArea, number][] {
  return COVERAGE_AREAS.map((a): [CoverageArea, number] => [a, rows.filter((r) => r.item.area === a).length]).filter(
    ([, n]) => n,
  );
}

/** Drafts that can still be added: not in the suite yet, and valid as they read. */
export const addable = (row: ReviewScenario) => !row.savedFile && !row.issue;
