// Read-only API over saved comparisons: /api/runs, /api/comparison,
// /api/report, /api/traces, /api/grades, /api/explanation.
import type http from "node:http";
import { promises as fs } from "node:fs";
import { confirmedChange } from "../compare/signals.ts";
import { exists } from "../storage/fs.ts";
import { comparisonFile, readComparison, readComparisonRuns, readExplanation } from "../storage/comparison.ts";
import { isCompareDirName, type Workspace } from "../storage/workspace.ts";
import type { Comparison, RunRecord } from "../types.ts";
import { send, sendJson } from "./http.ts";
import type { RunSummary } from "./runs-contract.ts";

const TRACE_FIELD_LIMIT = 8000;
const COMPARISON_ROUTES = ["/api/comparison", "/api/report", "/api/traces", "/api/grades", "/api/explanation"];

/** Compare directories in the workspace that actually hold a comparison, newest first. */
export async function listRuns(workspace: Workspace): Promise<RunSummary[]> {
  const runs: RunSummary[] = [];
  for (const dir of await workspace.listCompareDirs()) {
    if (!(await exists(comparisonFile(workspace.compareDir(dir), "comparison")))) continue;
    const summary: RunSummary = { dir, label: dir.replace(/^compare-/, "") };
    try {
      const c = await readComparison(workspace.compareDir(dir));
      summary.agentName = c.agentName;
      summary.oldFile = c.oldFile;
      summary.newFile = c.newFile;
      summary.tests = c.tests.length;
      summary.changed = c.tests.filter(confirmedChange).length;
      summary.createdAt = c.createdAt;
    } catch {
      // Still list the run even if comparison.json is malformed.
    }
    runs.push(summary);
  }
  return runs;
}

/** The compare dir's path, or null for anything that isn't a real compare-* directory (no traversal). */
async function safeDir(workspace: Workspace, name: string | null): Promise<string | null> {
  if (!name || !isCompareDirName(name)) return null;
  const dir = workspace.compareDir(name);
  return (await exists(comparisonFile(dir, "comparison"))) ? dir : null;
}

function clip(value: unknown): unknown {
  if (value == null) return value;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= TRACE_FIELD_LIMIT) return value;
  return text.slice(0, TRACE_FIELD_LIMIT) + `… (${text.length - TRACE_FIELD_LIMIT} more chars)`;
}

function slimRecord(r: RunRecord): RunRecord {
  return {
    ...r,
    final_response: typeof r.final_response === "string" ? (clip(r.final_response) as string) : r.final_response,
    tool_calls: (r.tool_calls ?? []).map((tc) => ({
      tool: tc.tool,
      input: clip(tc.input),
      output: clip(tc.output),
    })),
  };
}

export function createRunsRoute(workspace: Workspace) {
  return async (_req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> => {
    const p = url.pathname.replace(/\/+$/, "");
    if (p === "/api/runs") {
      sendJson(res, 200, await listRuns(workspace));
      return true;
    }
    if (!COMPARISON_ROUTES.includes(p)) return false;

    const dir = await safeDir(workspace, url.searchParams.get("dir"));
    if (p === "/api/report") {
      const file = dir && comparisonFile(dir, "report");
      if (!file || !(await exists(file))) send(res, 404, "text/plain", "no report");
      else send(res, 200, "text/markdown; charset=utf-8", await fs.readFile(file));
      return true;
    }
    if (!dir) {
      sendJson(res, 404, {
        error: "No saved comparison by that name here. Pick one from the list, or run a new comparison.",
      });
      return true;
    }

    if (p === "/api/comparison") {
      send(res, 200, "application/json", await fs.readFile(comparisonFile(dir, "comparison")));
    } else if (p === "/api/traces") {
      const runs = await readComparisonRuns(dir);
      sendJson(res, 200, { old: runs.old.map(slimRecord), new: runs.new.map(slimRecord) });
    } else if (p === "/api/grades") {
      const file = comparisonFile(dir, "grades");
      if (!(await exists(file))) send(res, 200, "application/json", "[]");
      else send(res, 200, "application/json", await fs.readFile(file));
    } else {
      let comparison: Comparison | null = null;
      try {
        comparison = await readComparison(dir);
      } catch {
        comparison = null;
      }
      const kind = url.searchParams.get("kind") ?? "short";
      if (kind !== "short" && kind !== "detailed") sendJson(res, 400, { error: "kind must be short or detailed" });
      else sendJson(res, 200, await readExplanation(dir, comparison, kind));
    }
    return true;
  };
}
