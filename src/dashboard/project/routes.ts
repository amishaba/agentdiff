import type http from "node:http";
import { randomUUID } from "node:crypto";
import { readJsonBody, requestErrorMessage, sendJson, trustedRequest, UNTRUSTED_MESSAGE } from "../http.ts";
import { claimExecution, executionBusy } from "../execution-lock.ts";
import type { JobManager } from "../jobs/manager.ts";
import { readDiscoveryDraft } from "./service.ts";
import { ConfigWriteSchema, DraftLocationSchema, PromoteDraftSchema, type ProjectRequest } from "./types.ts";

const PREFIX = "/api/project";
const WRITE_ACTIONS = ["/config", "/drafts/promote"];

/**
 * /api/project — read the project, edit its config, and promote discovery
 * drafts to tests. File reads and writes run in a worker process.
 */
export function createProjectRoute(manager: JobManager) {
  return async (req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
    const send = (status: number, data: unknown) => sendJson(res, status, data);
    if (!trustedRequest(req)) {
      send(403, { error: UNTRUSTED_MESSAGE });
      return true;
    }

    const action = url.pathname.slice(PREFIX.length);
    let release: (() => void) | undefined;
    try {
      if (req.method === "GET" && action === "") {
        send(200, await manager.project({ kind: "project-read" }));
      } else if (req.method === "GET" && action === "/drafts") {
        send(200, await manager.project({ kind: "project-drafts" }));
      } else if (req.method === "GET" && action === "/draft") {
        const { dir, file } = DraftLocationSchema.parse({
          dir: url.searchParams.get("dir"),
          file: url.searchParams.get("file"),
        });
        const { raw } = await readDiscoveryDraft(manager.cwd, dir, file);
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
          "content-disposition": `attachment; filename="${file}"`,
        });
        res.end(raw);
      } else if (req.method === "POST" && WRITE_ACTIONS.includes(action)) {
        if (executionBusy()) {
          send(409, { error: "Wait for the current job or project save to finish before changing project files." });
          return true;
        }
        const raw = await readJsonBody(req, 1_000_000);
        const request: ProjectRequest =
          action === "/config"
            ? { kind: "project-config", options: ConfigWriteSchema.parse(raw) }
            : { kind: "project-promote", options: PromoteDraftSchema.parse(raw) };
        release = claimExecution(`project-${randomUUID()}`);
        send(200, await manager.project(request));
      } else {
        send(404, { error: "Unknown project action." });
      }
    } catch (error) {
      send(400, { error: requestErrorMessage(error, "The project request failed.") });
    } finally {
      release?.();
    }
    return true;
  };
}
