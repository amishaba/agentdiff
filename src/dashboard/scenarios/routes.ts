import type http from "node:http";
import { randomUUID } from "node:crypto";
import { readJsonBody, requestErrorMessage, sendJson, trustedRequest, UNTRUSTED_MESSAGE } from "../http.ts";
import { claimExecution, executionBusy } from "../execution-lock.ts";
import type { JobManager } from "../jobs/manager.ts";
import { ScenarioDirNameSchema } from "../../types.ts";
import { AddScenariosSchema } from "./types.ts";

const PREFIX = "/api/scenarios";

/**
 * /api/scenarios — the saved scenario runs, one run's drafts, and adding drafts
 * to the suite. Writing scenarios is a job (/api/jobs/scenarios); reads and
 * writes here run in a worker process, like /api/project.
 */
export function createScenariosRoute(manager: JobManager) {
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
        send(200, await manager.project({ kind: "scenarios-list" }));
      } else if (req.method === "GET" && action === "/run") {
        const dir = ScenarioDirNameSchema.parse(url.searchParams.get("dir"));
        send(200, await manager.project({ kind: "scenarios-read", dir }));
      } else if (req.method === "POST" && action === "/add") {
        if (executionBusy()) {
          send(409, { error: "Wait for the current job or project save to finish before adding tests." });
          return true;
        }
        const options = AddScenariosSchema.parse(await readJsonBody(req, 64_000));
        release = claimExecution(`scenarios-${randomUUID()}`);
        send(200, await manager.project({ kind: "scenarios-add", options }));
      } else {
        send(404, { error: "Unknown scenarios action." });
      }
    } catch (error) {
      send(400, { error: requestErrorMessage(error, "The scenarios request failed.") });
    } finally {
      release?.();
    }
    return true;
  };
}
