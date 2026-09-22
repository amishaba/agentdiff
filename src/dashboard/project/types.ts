import { z } from "zod";
import { ConfigSchema, TestFileSchema, type Config, type Turn, CompareDirNameSchema } from "../../types.ts";

export const RevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const ConfigWriteSchema = z.object({ revision: RevisionSchema, config: ConfigSchema }).strict();
export const DraftLocationSchema = z
  .object({
    dir: CompareDirNameSchema,
    file: z.string().regex(/^[\w-]+\.json$/),
  })
  .strict();
export const PromoteDraftSchema = DraftLocationSchema.extend({
  requestId: z.string().uuid(),
  revision: RevisionSchema,
  draftRevision: RevisionSchema,
  must_call_tools: z.array(z.string().min(1).max(200)).max(100),
  grading_criteria: z.string().trim().min(1).max(12_000),
}).strict();
export const DiscoveryDraftSchema = TestFileSchema.omit({ replay: true }).extend({
  _discovery: z.object({
    findingId: z.string().min(1),
    hypothesis: z.string(),
    evidence: z.string(),
    review: z.string().optional(),
  }),
});
export interface ProjectState {
  config: Config;
  configFile: string;
  revision: string;
  editable: boolean;
  editReason?: string;
  testCount: number;
  testIssue?: string;
}
export interface DiscoveryDraft {
  dir: string;
  file: string;
  revision: string;
  name: string;
  input: string;
  /** The case's earlier turns and context, kept when the draft becomes a test. */
  conversation?: Turn[];
  context?: Record<string, unknown>;
  /** What the planner said the agent should do, to prefill the reviewed grading criteria. */
  expected?: string;
  findingId: string;
  experimentId: string;
  hypothesis: string;
  tools: string[];
  savedFile?: string;
}
export interface DraftList {
  drafts: DiscoveryDraft[];
  issues: string[];
}
export interface SavedTests {
  files: string[];
  testsDir: string;
}
export type ProjectRequest =
  | { kind: "project-read" }
  | { kind: "project-drafts" }
  | { kind: "project-config"; options: z.infer<typeof ConfigWriteSchema> }
  | { kind: "project-promote"; options: z.infer<typeof PromoteDraftSchema> };
