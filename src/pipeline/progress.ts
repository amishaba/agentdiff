import type { StageName } from "../types.ts";

/** Structured progress the pipeline emits; the dashboard streams it to the page. */
export interface JobProgress {
  phase: "preparing" | "runs" | "discovery" | "grading" | "explaining" | "writing" | "saving";
  /** The compare stage this progress belongs to. */
  stage?: StageName;
  message: string;
  completed?: number;
  total?: number;
  limit?: number;
  dir?: string;
}
export type ProgressListener = (progress: JobProgress) => void;
