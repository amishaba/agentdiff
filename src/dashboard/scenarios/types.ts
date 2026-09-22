import { z } from "zod";
import { ScenarioDirNameSchema } from "../../types.ts";
import type { ScenarioDraft, ScenarioResult } from "../../scenarios/types.ts";

export const AddScenariosSchema = z
  .object({
    requestId: z.string().uuid(),
    dir: ScenarioDirNameSchema,
    files: z
      .array(z.string().regex(/^[\w-]+\.json$/))
      .min(1)
      .max(500),
  })
  .strict();
export type AddScenariosRequest = z.infer<typeof AddScenariosSchema>;

/** A saved run of `agentdiff scenarios`, as the run picker lists it. */
export interface ScenarioRunSummary {
  dir: string;
  agentName: string;
  createdAt: string;
  scenarios: number;
  items: number;
}

/** A drafted scenario on the page, as its file reads now, and the test it became once added. */
export interface ReviewScenario extends ScenarioDraft {
  /** Of the draft file, so an edited draft is added as edited, and counts as new. */
  revision: string;
  savedFile?: string;
  /** Why the draft file can't be added as it stands, when it was edited into an invalid test. */
  issue?: string;
}

/** One run with every draft, as the scenarios page shows it. */
export interface ScenarioRun extends Omit<ScenarioResult, "drafts"> {
  dir: string;
  testsDir: string;
  drafts: ReviewScenario[];
}

export type ScenarioRequest =
  | { kind: "scenarios-list" }
  | { kind: "scenarios-read"; dir: string }
  | { kind: "scenarios-add"; options: AddScenariosRequest };
