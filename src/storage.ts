import { promises as fs } from "node:fs";
import path from "node:path";

export const AGENTDIFF_DIR = ".agentdiff";
export const BASELINE_DIR = path.join(AGENTDIFF_DIR, "baseline");

export function baselineRunsDir(): string {
  return path.join(BASELINE_DIR, "runs");
}

export function compareDir(timestamp: string): string {
  return path.join(AGENTDIFF_DIR, `compare-${timestamp}`);
}

export function compareRunsDir(dir: string): string {
  return path.join(dir, "runs");
}

/** Filesystem-safe slug for a test name. */
export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "test";
}

export function timestamp(): string {
  // e.g. 2026-07-29T16-04-33
  return new Date().toISOString().replace(/:/g, "-").replace(/\..+/, "");
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function writeJson(file: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export async function readJson<T = unknown>(file: string): Promise<T> {
  const raw = await fs.readFile(file, "utf8");
  return JSON.parse(raw) as T;
}

export async function rm(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true });
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function writeText(file: string, text: string): Promise<void> {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, text, "utf8");
}

/** Read every *.json file in a directory, parsed. Empty array if dir missing. */
export async function readJsonDir<T = unknown>(dir: string): Promise<T[]> {
  if (!(await exists(dir))) return [];
  const entries = await fs.readdir(dir);
  const out: T[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) continue;
    out.push(await readJson<T>(path.join(dir, entry)));
  }
  return out;
}

/** Most recent compare-* directory, or null if none. */
export async function latestCompareDir(): Promise<string | null> {
  if (!(await exists(AGENTDIFF_DIR))) return null;
  const entries = await fs.readdir(AGENTDIFF_DIR);
  const compares = entries.filter((e) => e.startsWith("compare-")).sort();
  if (compares.length === 0) return null;
  return path.join(AGENTDIFF_DIR, compares[compares.length - 1]);
}
