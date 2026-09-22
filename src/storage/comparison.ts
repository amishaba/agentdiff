// Read/write the artifacts inside one compare-* directory. `dir` is the
// directory's path, as returned by Workspace.newCompareDir() / compareDir().
import path from "node:path";
import { promises as fs } from "node:fs";
import type { Comparison, RunRecord } from "../types.ts";
import { exists, readJson, readJsonDir, writeTextAtomic } from "./fs.ts";
import { COMPARE_FILES } from "./workspace.ts";

const DETAILED_HEADING = "# AgentDiff — Detailed Analysis";

export function comparisonFile(dir: string, file: keyof typeof COMPARE_FILES): string {
  return path.join(dir, COMPARE_FILES[file]);
}

export async function readComparison(dir: string): Promise<Comparison> {
  return readJson<Comparison>(comparisonFile(dir, "comparison"));
}

/** Both sides' saved run records. */
export async function readComparisonRuns(dir: string): Promise<{ old: RunRecord[]; new: RunRecord[] }> {
  const [oldRuns, newRuns] = await Promise.all([
    readJsonDir<RunRecord>(comparisonFile(dir, "oldRuns")),
    readJsonDir<RunRecord>(comparisonFile(dir, "newRuns")),
  ]);
  return { old: oldRuns, new: newRuns };
}

/** A saved JSON list (grades.json, checks.json), or [] when the comparison has none. */
export async function readOptionalList<T>(dir: string, file: "grades" | "checks"): Promise<T[]> {
  const p = comparisonFile(dir, file);
  return (await exists(p)) ? readJson<T[]>(p) : [];
}

export async function writeDetailedExplanation(dir: string, text: string): Promise<string> {
  const file = comparisonFile(dir, "explanation");
  await writeTextAtomic(file, `${DETAILED_HEADING}\n\n${text}\n`);
  return file;
}

/**
 * The saved explanation for a comparison. "short" is the one-paragraph cause
 * from compare (falling back to report.md for older runs); "detailed" is what
 * `agentdiff explain` wrote.
 */
export async function readExplanation(
  dir: string,
  comparison: Comparison | null,
  kind: "short" | "detailed" = "short",
): Promise<{ text: string; generatedAt?: string }> {
  if (kind === "detailed") {
    const file = comparisonFile(dir, "explanation");
    if (!(await exists(file))) return { text: "" };
    const [raw, stat] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)]);
    return { text: raw.replace(/^#.*\n+/, "").trim(), generatedAt: stat.mtime.toISOString() };
  }
  if (comparison?.explanation?.trim()) return { text: comparison.explanation.trim() };

  const report = comparisonFile(dir, "report");
  if (await exists(report)) {
    const raw = await fs.readFile(report, "utf8");
    const idx = raw.indexOf("## Likely cause");
    if (idx >= 0) {
      return {
        text: raw
          .slice(idx)
          .replace(/^## Likely cause[^\n]*\n+/, "")
          .trim(),
      };
    }
  }
  return { text: "" };
}
