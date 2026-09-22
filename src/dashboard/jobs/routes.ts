import type http from "node:http";
import { z } from "zod";
import { readJsonBody, requestErrorMessage, sendJson, trustedRequest, UNTRUSTED_MESSAGE } from "../http.ts";
import { executionBusy } from "../execution-lock.ts";
import { JobManager } from "./manager.ts";
import {
  CheckRequestSchema,
  CompareRequestSchema,
  ExplainRequestSchema,
  ScenariosRequestSchema,
  type JobRequest,
} from "./types.ts";

const PREFIX = "/api/jobs/";
const JobIdSchema = z.string().uuid();

/** /api/jobs — start, poll and cancel the dashboard's comparison, explanation, check and scenario jobs. */
export function createJobsRoute(manager: JobManager) {
  return async (req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> => {
    if (!url.pathname.startsWith(PREFIX)) return false;
    const send = (status: number, data: unknown) => sendJson(res, status, data);
    const body = () => readJsonBody(req, 32_000);
    if (!trustedRequest(req)) {
      send(403, { error: UNTRUSTED_MESSAGE });
      return true;
    }
    const action = url.pathname.slice(PREFIX.length);
    const [jobId, verb] = action.split("/");
    try {
      if (req.method === "GET" && action === "status") {
        send(200, { job: manager.latest(), busy: executionBusy() });
      } else if (req.method === "GET" && action === "setup") {
        send(200, await manager.setup());
      } else if (req.method === "GET" && JobIdSchema.safeParse(action).success) {
        const job = manager.get(action);
        send(job ? 200 : 404, job ?? { error: "Unknown job. The local server may have restarted." });
      } else if (
        req.method === "POST" &&
        verb === "cancel" &&
        action.split("/").length === 2 &&
        JobIdSchema.safeParse(jobId).success
      ) {
        z.object({})
          .strict()
          .parse(await body());
        if (!manager.get(jobId)) send(404, { error: "Unknown job." });
        else send(200, manager.cancel(jobId));
      } else if (req.method === "POST" && ["compare", "explain", "check", "scenarios"].includes(action)) {
        if (executionBusy()) {
          send(409, { error: "Another job is running. Wait for it to finish or cancel it first." });
          return true;
        }
        const raw = await body();
        const request: JobRequest =
          action === "explain"
            ? { kind: "explain", options: ExplainRequestSchema.parse(raw) }
            : action === "check"
              ? { kind: "check", options: CheckRequestSchema.parse(raw) }
              : action === "scenarios"
                ? { kind: "scenarios", options: ScenariosRequestSchema.parse(raw) }
                : { kind: "compare", options: CompareRequestSchema.parse(raw) };
        send(202, manager.start(request));
      } else {
        send(404, { error: "Unknown job action." });
      }
    } catch (error) {
      send(400, { error: requestErrorMessage(error, "Job request failed.") });
    }
    return true;
  };
}
