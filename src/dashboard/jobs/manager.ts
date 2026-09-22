import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ProjectRequest } from "../project/types.ts";
import type { ScenarioRequest } from "../scenarios/types.ts";
import { claimExecution } from "../execution-lock.ts";
import { isActiveJob, type DashboardJob, type JobProgress, type JobRequest, type RunSetup } from "./types.ts";

/** Jobs kept for polling and reloads; active jobs are never evicted. */
const MAX_HISTORY = 50;
/** Grace period between SIGTERM and SIGKILL when stopping a job. */
const KILL_GRACE_MS = 3000;

/** Messages a worker (worker.ts) sends back over IPC. */
type WorkerMessage =
  | { type: "progress"; progress: JobProgress }
  | { type: "result"; result: Partial<DashboardJob> }
  | { type: "setup"; setup: RunSetup }
  | { type: "project"; result: unknown }
  | { type: "error"; error: string };

function spawnWorker(cwd: string): ChildProcess {
  return fork(fileURLToPath(new URL("./worker.ts", import.meta.url)), [], {
    cwd,
    execArgv: ["--import", import.meta.resolve("tsx")],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
}

/**
 * Runs dashboard work in child processes (worker.ts), so a broken agent or
 * config can never take down the server and code changes are re-imported on
 * every run. Long jobs are tracked here for polling; setup and project
 * operations are one-shot request/response calls.
 */
export class JobManager {
  readonly jobs = new Map<string, DashboardJob>();
  /** A narrow per-job cancellation function, rather than letting clients send signals. */
  private stops = new Map<string, () => void>();

  constructor(
    readonly cwd = process.cwd(),
    private timeoutMs = 30 * 60_000,
  ) {}

  latest(): DashboardJob | null {
    return [...this.jobs.values()].at(-1) ?? null;
  }

  get(id: string): DashboardJob | undefined {
    return this.jobs.get(id);
  }

  setup(): Promise<RunSetup> {
    return this.ask<RunSetup>(
      { kind: "setup" },
      {
        reply: (m) => (m.type === "setup" ? m.setup : undefined),
        timeoutMs: 15_000,
        timeoutError: "Loading project settings timed out. Check agentdiff.config.ts.",
        defaultError: "Could not load project settings. Check agentdiff.config.ts and the test directory.",
        startError: "Could not start the project-settings process.",
      },
    );
  }

  /** A project or scenarios file operation, run in a fresh worker. */
  project<T>(request: ProjectRequest | ScenarioRequest): Promise<T> {
    return this.ask<T>(request, {
      reply: (m) => (m.type === "project" ? (m.result as T) : undefined),
      timeoutMs: 30_000,
      timeoutError: "The project operation timed out. Reload the project to check what was saved.",
      defaultError: "The project operation could not complete.",
      startError: "Could not start the project worker.",
    });
  }

  start(request: JobRequest): DashboardJob {
    const id = randomUUID();
    const release = claimExecution(id);
    let child: ChildProcess;
    try {
      child = spawnWorker(this.cwd);
    } catch (error) {
      release();
      throw error;
    }

    const job: DashboardJob = {
      id,
      kind: request.kind,
      status: "running",
      createdAt: new Date().toISOString(),
      progress: { phase: "preparing", message: "Preparing job" },
      ...(request.kind === "explain" ? { explanationDir: request.options.dir } : {}),
    };
    this.jobs.set(id, job);
    while (this.jobs.size > MAX_HISTORY) this.jobs.delete(this.jobs.keys().next().value!);

    let result: Partial<DashboardJob> | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      child.kill("SIGTERM");
      forceKill ??= setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    };
    const timeout = setTimeout(() => {
      job.message = "Job timed out. Check the agent and model provider before retrying.";
      stop();
    }, this.timeoutMs);

    let runCounts: Pick<JobProgress, "completed" | "total"> = {};
    child.on("message", (m: WorkerMessage) => {
      if (!isActiveJob(job)) return;
      if (m?.type === "progress" && job.status === "running") {
        if (m.progress.phase === "runs" && m.progress.completed != null)
          runCounts = { completed: m.progress.completed, total: m.progress.total };
        // A stage that reports no counts of its own shows the test-run counts, not discovery's.
        job.progress = { ...(m.progress.completed == null ? runCounts : {}), ...m.progress };
        if (m.progress.dir) job.dir = m.progress.dir;
      }
      if (m?.type === "result") result = m.result;
      if (m?.type === "error") job.message = m.error;
    });

    const finish = (startFailed = false) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      this.stops.delete(id);
      release();
      if (job.finishedAt) return;
      // A completion acknowledgement means the output was already committed,
      // even if a cancellation crossed it in transit.
      if (result) {
        Object.assign(job, result);
      } else if (job.status === "cancelling") {
        job.status = "cancelled";
        job.message = "Job cancelled. Completed external tool actions cannot be undone.";
      } else {
        job.status = "error";
        job.message ??= startFailed
          ? "Could not start the job process."
          : "The job process stopped before it completed. Check the project configuration and model credentials.";
      }
      job.finishedAt = new Date().toISOString();
    };
    child.once("error", () => finish(true));
    child.once("exit", () => finish());

    child.send(request);
    this.stops.set(id, stop);
    return job;
  }

  cancel(id: string): DashboardJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error("Unknown job.");
    if (job.status === "running") {
      job.status = "cancelling";
      job.message = "Stopping the worker…";
      this.stops.get(id)?.();
    }
    return job;
  }

  close(): void {
    for (const job of this.jobs.values()) if (isActiveJob(job)) this.cancel(job.id);
  }

  /** Send one request to a fresh worker and resolve with its single reply. */
  private ask<T>(
    message: { kind: "setup" } | ProjectRequest | ScenarioRequest,
    opts: {
      reply: (m: WorkerMessage) => T | undefined;
      timeoutMs: number;
      timeoutError: string;
      defaultError: string;
      startError: string;
    },
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const child = spawnWorker(this.cwd);
      let response: T | undefined;
      let error = opts.defaultError;
      const timeout = setTimeout(() => {
        error = opts.timeoutError;
        child.kill("SIGKILL");
      }, opts.timeoutMs);
      child.on("message", (m: WorkerMessage) => {
        const value = opts.reply(m);
        if (value !== undefined) response = value;
        if (m?.type === "error") error = m.error;
      });
      child.on("error", () => {
        clearTimeout(timeout);
        reject(new Error(opts.startError));
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        if (code === 0 && response !== undefined) resolve(response);
        else reject(new Error(error));
      });
      child.send(message);
    });
  }
}
