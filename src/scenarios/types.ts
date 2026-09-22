// Scenario drafting's shapes: what to cover, and what came back for each item.
import type { TestFile } from "../types.ts";

/** The kinds of thing a test suite has to cover, in the order the report lists them. */
export const COVERAGE_AREAS = ["job", "rule", "tool-flow", "adversarial", "conversation"] as const;
export type CoverageArea = (typeof COVERAGE_AREAS)[number];

export const AREA_LABEL: Record<CoverageArea, string> = {
  job: "Main job",
  rule: "Rules",
  "tool-flow": "Tool sequences and failures",
  adversarial: "Adversarial",
  conversation: "Conversation shapes",
};

/** One thing the tests have to cover, from the agent's prompt and tools. */
export interface CoverageItem {
  /** c01, c02, … in report order. */
  id: string;
  area: CoverageArea;
  title: string;
  /** What a test of this item looks for, in one sentence. */
  focus: string;
  /** For a rule: the prompt's sentence, word for word. */
  rule?: string;
  /** Tools this item is about. */
  tools: string[];
}

/** A drafted scenario: a test file to review, and the coverage item it was written for. */
export interface ScenarioDraft {
  /** Its file name in the draft folder's tests/. */
  file: string;
  coverageId: string;
  test: TestFile;
}

export interface ScenarioResult {
  agentName: string;
  agentFile: string;
  createdAt: string;
  plan: CoverageItem[];
  drafts: ScenarioDraft[];
  /** Scenarios the writer returned that weren't valid tests, and why. */
  dropped: { coverageId: string; name: string; reason: string }[];
  /** Coverage items the writer failed on. */
  failed: { coverageId: string; reason: string }[];
  /** Why planning failed, when it did: then only the prompt's rule sentences were covered. */
  planError?: string;
}
