import path from "node:path";
import { promises as fs } from "node:fs";
import { canonical } from "../../lib/canonical.ts";
import { exists, listDir, readJson } from "../../storage/fs.ts";
import { AGENTDIFF_DIR } from "../../storage/workspace.ts";
import { revisionOf } from "./config-editor.ts";
import type { SavedTests } from "./types.ts";

/** Resolve a dashboard write target without escaping the project through a symlink. */
export async function projectPath(root: string, relative: string): Promise<string> {
  const actualRoot = await fs.realpath(root);
  const target = path.resolve(actualRoot, relative);
  const within = (file: string) => file === actualRoot || file.startsWith(actualRoot + path.sep);
  if (!within(target))
    throw new Error("Dashboard files must be inside this project. Choose a project-relative directory.");
  let parent = target;
  while (true) {
    try {
      if (!within(await fs.realpath(parent)))
        throw new Error("This path links outside the project. Choose a directory inside the project.");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const next = path.dirname(parent);
      if (next === parent) throw error;
      parent = next;
    }
  }
  return target;
}

// Durable receipts make a retried save idempotent after a dropped response.
export async function receipt(
  root: string,
  id: string,
  payload: unknown,
): Promise<{ file: string; fingerprint: string; saved?: SavedTests }> {
  const file = await projectPath(root, path.join(AGENTDIFF_DIR, "project-saves", `${id}.json`));
  const fingerprint = revisionOf(canonical(payload));
  if (await exists(file)) {
    const saved = await readJson<{ fingerprint: string; result: SavedTests }>(file);
    if (saved.fingerprint !== fingerprint)
      throw new Error("This save request has already been used for different edits. Reload before saving again.");
    return { file, fingerprint, saved: saved.result };
  }
  return { file, fingerprint };
}

/**
 * Tests the dashboard already added from drafts of one kind, keyed by where
 * the draft came from: `<dir>/<file>/<revision>` → the test's file name.
 */
export async function addedTests(root: string, tests: string, kind: "discovery" | "scenario") {
  const directory = await projectPath(root, tests);
  const files = await listDir(directory);
  const added = new Map<string, string>();
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    try {
      const data = await readJson<{ _agentdiff?: { source?: Record<string, string> } }>(
        await projectPath(root, path.join(tests, file)),
      );
      const source = data._agentdiff?.source;
      if (source?.kind === kind) added.set(`${source.dir}/${source.file}/${source.revision}`, file);
    } catch {
      /* The project summary reports malformed tests separately. */
    }
  }
  return added;
}
