// The .agentdiff/ workspace every command reads and writes, rooted at the
// project directory (the folder that holds agentdiff.config.ts):
//
//   .agentdiff/compare-<ts>-<id>/   see COMPARE_FILES
//   .agentdiff/braintrust/          dashboard Braintrust store
//   .agentdiff/project-saves/       dashboard save receipts
//
// Throwaway git worktrees go under the *repository* root instead (lib/git.ts).
import { randomUUID } from "node:crypto";
import path from "node:path";
import { CheckDirNameSchema, CompareDirNameSchema, ScenarioDirNameSchema } from "../types.ts";
import { listDir } from "./fs.ts";

export const AGENTDIFF_DIR = ".agentdiff";

/** Files and folders inside one compare-* directory. */
export const COMPARE_FILES = {
  comparison: "comparison.json",
  report: "report.md",
  grades: "grades.json",
  checks: "checks.json",
  explanation: "explanation.md",
  newSnapshot: "snapshot.json",
  oldSnapshot: "old-snapshot.json",
  newRuns: "runs",
  oldRuns: "old-runs",
} as const;

export class Workspace {
  /** `<root>/.agentdiff` */
  readonly dir: string;

  /** `root` is the project directory; paths stay relative when it is relative. */
  constructor(readonly root: string) {
    this.dir = path.join(root, AGENTDIFF_DIR);
  }

  get braintrustDir(): string {
    return path.join(this.dir, "braintrust");
  }

  /** A fresh, unique compare-<timestamp>-<id> path (not yet created). */
  newCompareDir(): string {
    return this.compareDir(`compare-${timestamp()}-${randomUUID().slice(0, 8)}`);
  }

  /** The path of a compare-* directory, by name. */
  compareDir(name: string): string {
    return path.join(this.dir, name);
  }

  /** compare-* directory names, newest first. */
  async listCompareDirs(): Promise<string[]> {
    return (await listDir(this.dir))
      .filter((e) => e.startsWith("compare-"))
      .sort()
      .reverse();
  }

  /** A fresh check-<timestamp> path (not yet created): one run of `agentdiff check`. */
  newCheckDir(): string {
    return path.join(this.dir, `check-${timestamp()}`);
  }

  /** check-* directory names, newest first. */
  async listCheckDirs(): Promise<string[]> {
    return (await listDir(this.dir))
      .filter((e) => CheckDirNameSchema.safeParse(e).success)
      .sort()
      .reverse();
  }

  /** A fresh scenarios-<timestamp> path (not yet created). */
  newScenarioDir(): string {
    return path.join(this.dir, `scenarios-${timestamp()}`);
  }

  /** scenarios-* directory names, newest first. */
  async listScenarioDirs(): Promise<string[]> {
    return (await listDir(this.dir))
      .filter((e) => ScenarioDirNameSchema.safeParse(e).success)
      .sort()
      .reverse();
  }

  /** Path of the most recent compare-* directory, or null if none. */
  async latestCompareDir(): Promise<string | null> {
    const [latest] = await this.listCompareDirs();
    return latest ? this.compareDir(latest) : null;
  }
}

export function isCompareDirName(name: string): boolean {
  return CompareDirNameSchema.safeParse(name).success;
}

/** Filesystem-safe slug for a test name. */
export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "test"
  );
}

export function timestamp(): string {
  // e.g. 2026-07-29T16-04-33-120: milliseconds included, so folder names sort in the order they were made
  return new Date()
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\.(\d{3})Z$/, "-$1");
}

/** `<runsDir>/<test-slug>-<run>.json` — where one run record is saved. */
export function runRecordPath(runsDir: string, test: string, run: number): string {
  return path.join(runsDir, `${slug(test)}-${run}.json`);
}
