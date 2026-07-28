import http from "node:http";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import chalk from "chalk";
import { fail } from "../config.ts";
import { AGENTDIFF_DIR, exists } from "../storage.ts";

const INDEX_HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), "../frontend/index.html");

/** Compare directories under .agentdiff/ that actually hold a comparison, newest first. */
async function listRuns(): Promise<{ dir: string; label: string }[]> {
  if (!(await exists(AGENTDIFF_DIR))) return [];
  const entries = (await fs.readdir(AGENTDIFF_DIR)).filter((e) => e.startsWith("compare-")).sort().reverse();
  const runs: { dir: string; label: string }[] = [];
  for (const dir of entries) {
    if (await exists(path.join(AGENTDIFF_DIR, dir, "comparison.json"))) {
      runs.push({ dir, label: dir.replace(/^compare-/, "") });
    }
  }
  return runs;
}

/** Reject anything that isn't a real compare-* directory name (no traversal). */
async function safeDir(dir: string | null): Promise<string | null> {
  if (!dir || !/^compare-[\w:.-]+$/.test(dir)) return null;
  const known = await listRuns();
  return known.some((r) => r.dir === dir) ? dir : null;
}

function send(res: http.ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/") {
    return send(res, 200, "text/html; charset=utf-8", await fs.readFile(INDEX_HTML));
  }

  if (url.pathname === "/api/runs") {
    return send(res, 200, "application/json", JSON.stringify(await listRuns()));
  }

  if (url.pathname === "/api/comparison") {
    const dir = await safeDir(url.searchParams.get("dir"));
    if (!dir) return send(res, 400, "application/json", JSON.stringify({ error: "unknown run" }));
    return send(res, 200, "application/json", await fs.readFile(path.join(AGENTDIFF_DIR, dir, "comparison.json")));
  }

  if (url.pathname === "/api/report") {
    const dir = await safeDir(url.searchParams.get("dir"));
    const file = dir && path.join(AGENTDIFF_DIR, dir, "report.md");
    if (!file || !(await exists(file))) return send(res, 404, "text/plain", "no report");
    return send(res, 200, "text/markdown; charset=utf-8", await fs.readFile(file));
  }

  send(res, 404, "text/plain", "not found");
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
  } catch {
    // Best effort — the URL is printed regardless.
  }
}

/** Listen on `port`, bumping upward a few times if it's taken. */
function listen(server: http.Server, port: number, attempts = 10): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (p: number, left: number) => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && left > 0) tryPort(p + 1, left - 1);
        else reject(err);
      });
      server.listen(p, "127.0.0.1", () => resolve(p));
    };
    tryPort(port, attempts);
  });
}

export async function viewCommand(opts: { port?: string; open?: boolean } = {}): Promise<void> {
  if (!(await exists(AGENTDIFF_DIR))) {
    fail(`No ${AGENTDIFF_DIR}/ here yet. Run "agentdiff compare" first, then "agentdiff view".`);
  }

  const wanted = opts.port ? Number.parseInt(opts.port, 10) : 4321;
  if (!Number.isFinite(wanted) || wanted < 1 || wanted > 65535) {
    fail(`--port must be a number between 1 and 65535.`);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => send(res, 500, "text/plain", String(err?.message ?? err)));
  });

  const port = await listen(server, wanted);
  const url = `http://localhost:${port}`;
  const runs = await listRuns();

  console.log(chalk.bold(`AgentDiff view`));
  console.log(`  ${chalk.green(url)}  ${chalk.dim(`(${runs.length} comparison${runs.length === 1 ? "" : "s"})`)}`);
  console.log(chalk.dim("  press Ctrl+C to stop"));

  if (opts.open !== false) openBrowser(url);
}
