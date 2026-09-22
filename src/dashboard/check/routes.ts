// Read-only API over saved checks: /api/checks (the list) and /api/checks/run
// (one check with every run). Running a check is a job: /api/jobs/check.
import type http from "node:http";
import path from "node:path";
import { exists, readJson, readJsonDir } from "../../storage/fs.ts";
import type { Workspace } from "../../storage/workspace.ts";
import type { GradeResult } from "../../grade/grader.ts";
import type { HealthResult } from "../../health/types.ts";
import { CheckDirNameSchema, type RunRecord } from "../../types.ts";
import { sendJson, trustedRequest, UNTRUSTED_MESSAGE } from "../http.ts";
import type { CheckRun, CheckRunSummary, CheckRunView } from "./types.ts";

const PREFIX = "/api/checks";
/** Longest tool input, output or reply the page gets, as text. */
const FIELD_LIMIT = 4000;

const clipped = (value: unknown): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return text.length > FIELD_LIMIT ? `${text.slice(0, FIELD_LIMIT)}… (${text.length - FIELD_LIMIT} more chars)` : text;
};

/** A saved check's folder, or null for anything that isn't one (no traversal). */
async function checkDir(workspace: Workspace, name: string | null): Promise<string | null> {
  if (!CheckDirNameSchema.safeParse(name).success) return null;
  const dir = path.join(workspace.dir, name!);
  return (await exists(path.join(dir, "check.json"))) ? dir : null;
}

/** One run as the page shows it, with its grade. */
export function runView(r: RunRecord, grades: GradeResult[]): CheckRunView {
  return {
    run: r.run,
    error: r.error,
    reply: r.final_response == null ? null : clipped(r.final_response),
    score: grades.find((g) => g.test === r.test && g.run === r.run)?.score ?? null,
    latencyMs: r.latency_ms,
    toolCalls: r.tool_calls.map((c) => ({ tool: c.tool, input: clipped(c.input), output: clipped(c.output) })),
  };
}

export async function listChecks(workspace: Workspace): Promise<CheckRunSummary[]> {
  const out: CheckRunSummary[] = [];
  for (const name of await workspace.listCheckDirs()) {
    const dir = await checkDir(workspace, name);
    if (!dir) continue;
    try {
      const r = await readJson<HealthResult>(path.join(dir, "check.json"));
      out.push({
        dir: name,
        agentName: r.agentName,
        createdAt: r.createdAt,
        tests: r.tests.length,
        steady: r.tests.filter((t) => t.status === "steady").length,
        runsPerTest: r.runsPerTest,
      });
    } catch {
      /* A check that stopped before saving its result. */
    }
  }
  return out;
}

export async function readCheck(workspace: Workspace, name: string | null): Promise<CheckRun | null> {
  const dir = await checkDir(workspace, name);
  if (!dir) return null;
  const result = await readJson<HealthResult>(path.join(dir, "check.json"));
  const grades = (await exists(path.join(dir, "grades.json")))
    ? await readJson<GradeResult[]>(path.join(dir, "grades.json"))
    : [];
  const records = await readJsonDir<RunRecord>(path.join(dir, "runs"));
  const runs: CheckRun["runs"] = {};
  for (const r of records.sort((a, b) => a.run - b.run)) (runs[r.test] ??= []).push(runView(r, grades));
  return { ...result, dir: name!, runs };
}

export function createCheckRoute(workspace: Workspace) {
  return async (req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
    if (!trustedRequest(req)) {
      sendJson(res, 403, { error: UNTRUSTED_MESSAGE });
      return true;
    }
    if (req.method === "GET" && url.pathname === PREFIX) {
      sendJson(res, 200, await listChecks(workspace));
    } else if (req.method === "GET" && url.pathname === `${PREFIX}/run`) {
      const run = await readCheck(workspace, url.searchParams.get("dir"));
      sendJson(res, run ? 200 : 404, run ?? { error: "No saved check by that name." });
    } else {
      sendJson(res, 404, { error: "Unknown check action." });
    }
    return true;
  };
}
