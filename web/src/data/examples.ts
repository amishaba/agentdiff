// The website's recorded examples: real comparisons baked by scripts/bake-example.ts.
import index from "../../fixtures/examples/index.json" with { type: "json" };
import type { Dataset } from "./types.ts";

export interface ExampleSummary {
  name: string;
  title: string;
  change: string;
  verdict: string;
  tests: number;
  runsPerTest: number;
  changed: number;
  rule: number;
  worse: number;
  better: number;
  cost: string | null;
  recorded: string | null;
  /** The one finding the homepage card leads with, written from the runs. */
  headline?: string;
  /** How long each stage of the loop took. Absent for recordings made before stages were timed. */
  stages?: { stage: string; status: string; ms: number }[];
  discovery?: { experiments: number; findings: number; runs: number };
  /** The most serious change's trip through the loop, for the homepage's moving pipeline. */
  story?: ExampleStory;
}

export interface ExampleStory {
  test: string;
  input: string;
  /** The prompt lines the explanation points at. */
  prompt: { sign: "-" | "+"; text: string }[];
  other: string[];
  /** Each agent's usual path (tool calls and reply), and every run's status as the strip colours it. */
  old: { path: string; runs: string[] };
  new: { path: string; runs: string[] };
  /** Whether the change showed up in each half of the runs, and in the old agent against itself. */
  halves?: { signal: string; first: boolean; second: boolean; noise: boolean };
  label: string;
  fact: string;
  discovery?: { message: string; old: string; new: string; label?: string };
  cause: string;
  fix: string;
}

export const EXAMPLES = index as ExampleSummary[];

/** The example named in ?example=, or the first one. */
export function currentExample(search = typeof window === "undefined" ? "" : window.location.search): ExampleSummary {
  const name = new URLSearchParams(search).get("example");
  return EXAMPLES.find((e) => e.name === name) ?? EXAMPLES[0];
}

/** One example's comparison, runs and grades; code-split, so the landing page never downloads them. */
export async function loadExample(name: string): Promise<Dataset> {
  const fixtures: Record<string, () => Promise<{ default: unknown }>> = {
    sms: () => import("../../fixtures/examples/sms.json"),
    booking: () => import("../../fixtures/examples/booking.json"),
    support: () => import("../../fixtures/examples/support.json"),
    clinic: () => import("../../fixtures/examples/clinic.json"),
  };
  const load = fixtures[name];
  if (!load) throw new Error(`No recorded example named ${name}.`);
  const f = (await load()).default as Omit<Dataset, "mode" | "dir"> & { source: Dataset["source"] };
  return { mode: "demo", dir: f.source?.dir ?? name, ...f };
}

/** "11 of 16 tests behave differently", as the report page says it. */
export const changedLine = (e: ExampleSummary) => `${e.changed} of ${e.tests} tests behave differently`;

// Recordings baked before the labels were reworded carry the old ones.
const RENAMED: Record<string, string> = {
  "Broke a rule": "Breaks a test rule",
  Worse: "Scores lower",
  Better: "Scores higher",
  Different: "Different path",
};

/** A baked change label in the report page's wording. */
export const kindLabel = (label: string) => RENAMED[label] ?? label;
