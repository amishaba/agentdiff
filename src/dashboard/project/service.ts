import path from "node:path";
import { promises as fs } from "node:fs";
import { z } from "zod";
import { loadTests } from "../../suite/load.ts";
import { listDir, readJson, writeJson } from "../../storage/fs.ts";
import { AGENTDIFF_DIR, COMPARE_FILES, isCompareDirName } from "../../storage/workspace.ts";
import { writeScenarios } from "../../suite/write.ts";
import type { Comparison } from "../../types.ts";
import { configDocument, revisionOf, saveProjectConfig } from "./config-editor.ts";
import { addedTests, projectPath, receipt } from "./files.ts";
import {
  ConfigWriteSchema,
  DiscoveryDraftSchema,
  DraftLocationSchema,
  PromoteDraftSchema,
  type ProjectState,
  type DiscoveryDraft,
  type DraftList,
  type SavedTests,
  type ProjectRequest,
} from "./types.ts";

export async function readProject(): Promise<ProjectState> {
  const doc = await configDocument();
  let testCount = 0;
  let testIssue: string | undefined;
  try {
    testCount = (await loadTests(doc.rootDir, doc.config.tests)).length;
  } catch (error) {
    testIssue = (error as Error).message;
  }
  return {
    config: doc.config,
    configFile: path.basename(doc.file),
    revision: doc.revision,
    editable: doc.editable,
    editReason: doc.editReason,
    testCount,
    testIssue,
  };
}

function checkTools(selected: string[], known: string[]) {
  const invalid = selected.filter((tool) => !known.includes(tool));
  if (invalid.length)
    throw new Error(`Unknown required tools: ${invalid.join(", ")}. Choose tools recorded for this agent.`);
}

export async function readDiscoveryDraft(root: string, dir: string, file: string) {
  DraftLocationSchema.parse({ dir, file });
  const source = await projectPath(root, path.join(AGENTDIFF_DIR, dir, "discovery", "drafts", file));
  const raw = await fs.readFile(source, "utf8");
  const data = DiscoveryDraftSchema.parse(JSON.parse(raw));
  const comparisonPath = await projectPath(root, path.join(AGENTDIFF_DIR, dir, COMPARE_FILES.comparison));
  const comparison = await readJson<Comparison>(comparisonPath);
  const finding = comparison.discovery?.findings.find((f) => f.id === data._discovery.findingId);
  if (!finding) throw new Error("The draft’s finding is missing from its saved comparison.");
  // Evidence is displayed as provenance, never used as a client-controlled path.
  const draft: DiscoveryDraft = {
    dir,
    file,
    revision: revisionOf(raw),
    name: data.name,
    input: data.input,
    ...(data.conversation?.length ? { conversation: data.conversation } : {}),
    ...(data.context ? { context: data.context } : {}),
    ...(data.grading_criteria ? { expected: data.grading_criteria } : {}),
    findingId: finding.id,
    experimentId: finding.experimentId,
    hypothesis: data._discovery.hypothesis,
    tools: [
      ...new Set([
        ...comparison.oldSnapshot.tools,
        ...comparison.newSnapshot.tools,
        ...(comparison.oldSnapshot.workflows ?? []),
        ...(comparison.newSnapshot.workflows ?? []),
      ]),
    ],
  };
  return { draft, raw, data };
}
export async function listDiscoveryDrafts(): Promise<DraftList> {
  const doc = await configDocument();
  const entries = await listDir(await projectPath(doc.rootDir, AGENTDIFF_DIR));
  const drafts: DiscoveryDraft[] = [];
  const issues: string[] = [];
  let promoted = new Map<string, string>();
  try {
    promoted = await addedTests(doc.rootDir, doc.config.tests, "discovery");
  } catch (error) {
    issues.push((error as Error).message);
  }
  for (const dir of entries.filter(isCompareDirName).sort().reverse()) {
    try {
      const files = await listDir(await projectPath(doc.rootDir, path.join(AGENTDIFF_DIR, dir, "discovery", "drafts")));
      for (const file of files.filter((f) => /^[\w-]+\.json$/.test(f)).sort()) {
        try {
          const { draft } = await readDiscoveryDraft(doc.rootDir, dir, file);
          draft.savedFile = promoted.get(`${dir}/${file}/${draft.revision}`);
          drafts.push(draft);
        } catch (error) {
          issues.push(`${dir}/${file}: ${(error as Error).message}`);
        }
      }
    } catch (error) {
      issues.push(`${dir}: ${(error as Error).message}`);
    }
  }
  return { drafts, issues };
}
export async function promoteDiscoveryDraft(options: z.infer<typeof PromoteDraftSchema>): Promise<SavedTests> {
  const request = PromoteDraftSchema.parse(options);
  const doc = await configDocument();
  const saved = await receipt(doc.rootDir, request.requestId, request);
  if (saved.saved) return saved.saved;
  if (request.revision !== doc.revision)
    throw new Error("The config changed. Reload the project before adding this draft.");
  const { draft, data } = await readDiscoveryDraft(doc.rootDir, request.dir, request.file);
  if (draft.revision !== request.draftRevision)
    throw new Error("The discovery draft changed. Reload it before saving your review.");
  checkTools(request.must_call_tools, draft.tools);
  const already = (await addedTests(doc.rootDir, doc.config.tests, "discovery")).get(
    `${draft.dir}/${draft.file}/${draft.revision}`,
  );
  if (already) return { files: [already], testsDir: doc.config.tests };
  const target = await projectPath(doc.rootDir, doc.config.tests);
  const files = await writeScenarios(
    target,
    [
      {
        name: draft.name,
        input: draft.input,
        must_call_tools: [...new Set(request.must_call_tools)],
        grading_criteria: request.grading_criteria,
      },
    ],
    [
      {
        ...(data.conversation?.length ? { conversation: data.conversation } : {}),
        ...(data.context ? { context: data.context } : {}),
        _discovery: { ...data._discovery, comparisonDir: draft.dir, experimentId: draft.experimentId },
        _agentdiff: {
          requestId: request.requestId,
          source: { kind: "discovery", dir: draft.dir, file: draft.file, revision: draft.revision },
        },
      },
    ],
  );
  const result = { files, testsDir: doc.config.tests };
  try {
    await writeJson(saved.file, { fingerprint: saved.fingerprint, result });
  } catch (error) {
    await Promise.all(files.map((file) => fs.rm(path.join(target, file), { force: true })));
    throw error;
  }
  return result;
}
export async function projectOperation(request: ProjectRequest) {
  if (request.kind === "project-read") return readProject();
  if (request.kind === "project-config") {
    const options = ConfigWriteSchema.parse(request.options);
    return saveProjectConfig(options.revision, options.config);
  }
  if (request.kind === "project-promote") return promoteDiscoveryDraft(request.options);
  if (request.kind === "project-drafts") return listDiscoveryDrafts();
  throw new Error("Unknown project operation.");
}
