import { z } from "zod";
import { DiscoveryConfigSchema } from "../../discovery/types.ts";
import { CompareDirNameSchema, type Config } from "../../types.ts";
import type { JobProgress } from "../../pipeline/progress.ts";

export type { JobProgress, ProgressListener } from "../../pipeline/progress.ts";

/** A ref is passed to git as an argument: refuse control characters (and, below, option-like values). */
const hasControlCharacter = (s: string) => [...s].some((ch) => ch.charCodeAt(0) < 0x20);

export const CompareRequestSchema = z
  .object({
    mode: z.enum(["git", "files"]),
    ref: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((s) => !s.startsWith("-") && !hasControlCharacter(s), "Enter a Git branch, tag, or commit.")
      .optional(),
    ifChanged: z.boolean().default(true),
    discovery: DiscoveryConfigSchema.optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.mode === "git" && !r.ref) ctx.addIssue({ code: "custom", path: ["ref"], message: "A Git ref is required." });
    if (r.mode !== "git" && r.ref)
      ctx.addIssue({ code: "custom", path: ["ref"], message: "Only Git mode accepts a ref." });
  });
export const ExplainRequestSchema = z.object({ dir: CompareDirNameSchema }).strict();
export const CheckRequestSchema = z.object({ runs: z.number().int().min(2).max(50).optional() }).strict();
export const ScenariosRequestSchema = z.object({ perItem: z.number().int().min(1).max(5).default(2) }).strict();
export type CompareRequest = z.infer<typeof CompareRequestSchema>;
export type JobKind = "compare" | "explain" | "check" | "scenarios";
export type JobRequest =
  | { kind: "compare"; options: CompareRequest }
  | { kind: "explain"; options: z.infer<typeof ExplainRequestSchema> }
  | { kind: "check"; options: z.input<typeof CheckRequestSchema> }
  | { kind: "scenarios"; options: z.input<typeof ScenariosRequestSchema> };
export interface DashboardJob {
  id: string;
  kind: JobKind;
  status: "running" | "cancelling" | "complete" | "skipped" | "blocked" | "error" | "cancelled";
  createdAt: string;
  finishedAt?: string;
  progress: JobProgress;
  dir?: string;
  resultDir?: string;
  explanationDir?: string;
  message?: string;
}
export const isActiveJob = (j: DashboardJob | null | undefined) =>
  j?.status === "running" || j?.status === "cancelling";
export interface RunSetup {
  config: Config;
  testCount: number;
  /** Every test is a saved incident, so discovery has nothing to build cases from. */
  onlyIncidentTests: boolean;
  refs: string[];
  defaultRef: string;
}
