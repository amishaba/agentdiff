// The local server behind `agentdiff view`: the built web app plus the
// dashboard APIs. Every route returns true when it handled the request.
import http from "node:http";
import { Workspace } from "../storage/workspace.ts";
import { createBraintrustRoute } from "./braintrust/routes.ts";
import { createCheckRoute } from "./check/routes.ts";
import { JobManager } from "./jobs/manager.ts";
import { createJobsRoute } from "./jobs/routes.ts";
import { createProjectRoute } from "./project/routes.ts";
import { createScenariosRoute } from "./scenarios/routes.ts";
import { redirect, send } from "./http.ts";
import { createRunsRoute } from "./runs-api.ts";
import { ROOT_FILES, sendApp, sendAsset, sendRootFile } from "./static.ts";

type Route = (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => Promise<boolean>;

/** The dashboard server for the project in `manager.cwd`. */
export function createViewServer(manager = new JobManager()) {
  const workspace = new Workspace(manager.cwd);
  const routes: Route[] = [
    createJobsRoute(manager),
    createProjectRoute(manager),
    createScenariosRoute(manager),
    createBraintrustRoute(workspace),
    createRunsRoute(workspace),
    createCheckRoute(workspace),
  ];
  const server = http.createServer((req, res) => {
    handle(req, res, routes).catch((err) => send(res, 500, "text/plain", String(err?.message ?? err)));
  });
  server.once("close", () => manager.close());
  return server;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, routes: Route[]): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  for (const route of routes) if (await route(req, res, url)) return;
  const p = url.pathname.replace(/\/+$/, "") || "/";

  // Older links: everything is one page now.
  if (p === "/web" || p === "/demo" || p === "/site" || p === "/index.html") {
    return redirect(res, "/" + url.search);
  }

  if (p === "/") return sendApp(res);
  if (p.startsWith("/assets/")) return sendAsset(res, p);
  if (ROOT_FILES.has(p)) return sendRootFile(res, p);

  send(res, 404, "text/plain", "not found");
}

/** Listen on `port`, bumping upward a few times if it's taken. */
export function listen(server: http.Server, port: number, attempts = 10): Promise<number> {
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
