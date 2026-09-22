// Reviewing drafted scenarios: list the saved runs, read one with each draft's
// state, and add chosen drafts to the suite. Runs in a worker, like project/.
import path from "node:path";
import { promises as fs } from "node:fs";
import { readJson, writeJson } from "../../storage/fs.ts";
import { AGENTDIFF_DIR, Workspace } from "../../storage/workspace.ts";
import { writeTestFiles, type TestBody } from "../../suite/write.ts";
import { ScenarioDirNameSchema, TestFileSchema } from "../../types.ts";
import type { ScenarioResult } from "../../scenarios/types.ts";
import { configDocument, revisionOf } from "../project/config-editor.ts";
import { addedTests, projectPath, receipt } from "../project/files.ts";
import type { SavedTests } from "../project/types.ts";
import {
  AddScenariosSchema,
  type AddScenariosRequest,
  type ReviewScenario,
  type ScenarioRequest,
  type ScenarioRun,
  type ScenarioRunSummary,
} from "./types.ts";

const runFile = (dir: string, ...parts: string[]) =>
  path.join(AGENTDIFF_DIR, ScenarioDirNameSchema.parse(dir), ...parts);

async function readResult(root: string, dir: string): Promise<ScenarioResult> {
  return readJson<ScenarioResult>(await projectPath(root, runFile(dir, "scenarios.json")));
}

/** A draft file as it reads now, and its revision. */
async function readDraft(root: string, dir: string, file: string): Promise<{ raw: string; revision: string }> {
  const raw = await fs.readFile(await projectPath(root, runFile(dir, "tests", file)), "utf8");
  return { raw, revision: revisionOf(raw) };
}

export async function listScenarioRuns(): Promise<ScenarioRunSummary[]> {
  const doc = await configDocument();
  const runs: ScenarioRunSummary[] = [];
  for (const dir of await new Workspace(doc.rootDir).listScenarioDirs()) {
    try {
      const r = await readResult(doc.rootDir, dir);
      runs.push({
        dir,
        agentName: r.agentName,
        createdAt: r.createdAt,
        scenarios: r.drafts.length,
        items: r.plan.length,
      });
    } catch {
      /* A run that stopped before saving its result. */
    }
  }
  return runs;
}

export async function readScenarioRun(dir: string): Promise<ScenarioRun> {
  const doc = await configDocument();
  const result = await readResult(doc.rootDir, dir);
  const added = await addedTests(doc.rootDir, doc.config.tests, "scenario");
  const drafts = await Promise.all(
    result.drafts.map(async (draft): Promise<ReviewScenario> => {
      const { raw, revision } = await readDraft(doc.rootDir, dir, draft.file);
      const parsed = TestFileSchema.safeParse(JSON.parse(raw));
      const savedFile = added.get(`${dir}/${draft.file}/${revision}`);
      return {
        ...draft,
        ...(parsed.success ? { test: parsed.data } : { issue: parsed.error.issues[0]?.message ?? "Not a valid test." }),
        revision,
        ...(savedFile ? { savedFile } : {}),
      };
    }),
  );
  return { ...result, dir, testsDir: doc.config.tests, drafts };
}

/**
 * Copy drafts into the suite as they read now, each with where it came from.
 * A draft already added unchanged returns its existing file; a retried request
 * returns what it saved the first time.
 */
export async function addScenarios(options: AddScenariosRequest): Promise<SavedTests> {
  const request = AddScenariosSchema.parse(options);
  const doc = await configDocument();
  const saved = await receipt(doc.rootDir, request.requestId, request);
  if (saved.saved) return saved.saved;
  const added = await addedTests(doc.rootDir, doc.config.tests, "scenario");
  const existing: string[] = [];
  const bodies: TestBody[] = [];
  for (const file of new Set(request.files)) {
    const { raw, revision } = await readDraft(doc.rootDir, request.dir, file);
    const already = added.get(`${request.dir}/${file}/${revision}`);
    if (already) {
      existing.push(already);
      continue;
    }
    const { _coverage, ...draft } = JSON.parse(raw);
    const test = TestFileSchema.safeParse(draft);
    if (!test.success) throw new Error(`${file} isn't a valid test: ${test.error.issues[0]?.message}`);
    bodies.push({
      _coverage,
      _agentdiff: { requestId: request.requestId, source: { kind: "scenario", dir: request.dir, file, revision } },
      ...test.data,
    });
  }
  const target = await projectPath(doc.rootDir, doc.config.tests);
  const written = await writeTestFiles(target, bodies);
  const result = { files: [...existing, ...written], testsDir: doc.config.tests };
  try {
    await writeJson(saved.file, { fingerprint: saved.fingerprint, result });
  } catch (error) {
    await Promise.all(written.map((file) => fs.rm(path.join(target, file), { force: true })));
    throw error;
  }
  return result;
}

export function scenarioOperation(request: ScenarioRequest) {
  if (request.kind === "scenarios-list") return listScenarioRuns();
  if (request.kind === "scenarios-read") return readScenarioRun(request.dir);
  if (request.kind === "scenarios-add") return addScenarios(request.options);
  throw new Error("Unknown scenarios operation.");
}
