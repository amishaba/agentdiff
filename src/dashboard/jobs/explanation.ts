import { explainComparison } from "../../explain/explain.ts";
import { failedSides } from "../../compare/signals.ts";
import { readComparison, writeDetailedExplanation } from "../../storage/comparison.ts";
import type { Workspace } from "../../storage/workspace.ts";
import { ExplainRequestSchema } from "./types.ts";

/** Persist only a successful detailed explanation, scoped to the selected run. */
export async function saveDetailedExplanation(
  workspace: Workspace,
  dir: string,
  explain = explainComparison,
): Promise<void> {
  ExplainRequestSchema.parse({ dir });
  const root = workspace.compareDir(dir);
  const comparison = await readComparison(root);
  if (failedSides(comparison).length)
    throw new Error("This comparison could not complete. Fix the failing agent before requesting an explanation.");
  const text = await explain(comparison, { detail: "detailed", throwOnError: true });
  await writeDetailedExplanation(root, text);
}
