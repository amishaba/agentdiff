import { readFileSync } from "node:fs";
import { fail } from "../lib/errors.ts";

export const COMMENT_MARKER = "<!-- agentdiff-report -->";

export interface PullRequestContext {
  owner: string;
  repo: string;
  number: number;
  baseSha: string;
  baseRef: string;
}

interface GhComment {
  id: number;
  body?: string;
}

/** Read the PR this Actions job is running on. Fails outside a pull_request event. */
export function readPullRequestContext(): PullRequestContext {
  if (process.env.GITHUB_ACTIONS !== "true") {
    fail(`"agentdiff ci" runs inside GitHub Actions. Locally use "agentdiff compare <ref>".`);
  }
  if (!process.env.GITHUB_TOKEN?.trim()) {
    fail(`GITHUB_TOKEN is missing. Pass github-token to the Action (defaults to the job token).`);
  }

  const repoFull = process.env.GITHUB_REPOSITORY;
  if (!repoFull || !repoFull.includes("/")) {
    fail(`GITHUB_REPOSITORY is missing or invalid.`);
  }
  const [owner, repo] = repoFull.split("/");

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    fail(`GITHUB_EVENT_PATH is missing.`);
  }

  let event: { pull_request?: { number?: number; base?: { sha?: string; ref?: string } } };
  try {
    event = JSON.parse(readFileSync(eventPath, "utf8")) as typeof event;
  } catch (err) {
    fail(`Could not read GitHub event payload: ${err instanceof Error ? err.message : String(err)}`);
  }

  const pr = event.pull_request;
  if (!pr?.number || !pr.base?.sha) {
    fail(`"agentdiff ci" needs a pull_request event (no pull_request.base.sha in the payload).`);
  }

  return {
    owner,
    repo,
    number: pr.number,
    baseSha: pr.base.sha,
    baseRef: pr.base.ref ?? pr.base.sha,
  };
}

/** The "old → new" line for a PR comment; the report prints it in its header. */
export function comparedLabel(baseLabel: string): string {
  return `\`${baseLabel}\` → this PR`;
}

export function formatPrComment(report: string): string {
  return [
    COMMENT_MARKER,
    report.trim(),
    "",
    "<sub>[agentdiff](https://github.com/amishaba/agentdiff) re-runs this on every push and updates this comment.</sub>",
    "",
  ].join("\n");
}

async function github<T>(path: string, method: string, body?: unknown): Promise<T> {
  const token = process.env.GITHUB_TOKEN!;
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "agentdiff",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    fail(`GitHub API ${method} ${path} failed (${res.status}): ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function listIssueComments(ctx: PullRequestContext): Promise<GhComment[]> {
  const out: GhComment[] = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await github<GhComment[]>(
      `/repos/${ctx.owner}/${ctx.repo}/issues/${ctx.number}/comments?per_page=100&page=${page}`,
      "GET",
    );
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

async function findReportComment(ctx: PullRequestContext): Promise<GhComment | undefined> {
  const comments = await listIssueComments(ctx);
  return comments.find((c) => (c.body ?? "").includes(COMMENT_MARKER));
}

/** Create or replace the single AgentDiff comment on the PR. */
export async function upsertReportComment(ctx: PullRequestContext, body: string): Promise<void> {
  const existing = await findReportComment(ctx);
  if (existing) {
    await github(`/repos/${ctx.owner}/${ctx.repo}/issues/comments/${existing.id}`, "PATCH", { body });
    return;
  }
  await github(`/repos/${ctx.owner}/${ctx.repo}/issues/${ctx.number}/comments`, "POST", { body });
}

/** Remove the AgentDiff comment if one exists (snapshot now matches the base). */
export async function removeReportComment(ctx: PullRequestContext): Promise<boolean> {
  const existing = await findReportComment(ctx);
  if (!existing) return false;
  await github(`/repos/${ctx.owner}/${ctx.repo}/issues/comments/${existing.id}`, "DELETE");
  return true;
}
