import path from "node:path";
import { z } from "zod";
import { loadConfig, locateWorkspace } from "../../config/load.ts";
import { loadTests } from "../../suite/load.ts";
import { listRefs } from "../../lib/git.ts";
import { runComparison } from "../../pipeline/compare.ts";
import { draftScenarios } from "../../pipeline/scenarios.ts";
import { runCheck } from "../../pipeline/check.ts";
import { healthHeadline } from "../../health/describe.ts";
import { scenariosHeadline } from "../../scenarios/report.ts";
import type { Reporter } from "../../pipeline/reporter.ts";
import { projectOperation } from "../project/service.ts";
import type { ProjectRequest } from "../project/types.ts";
import { scenarioOperation } from "../scenarios/service.ts";
import type { ScenarioRequest } from "../scenarios/types.ts";
import { saveDetailedExplanation } from "./explanation.ts";
import { failedSides, incompleteStages } from "../../compare/signals.ts";
import type { Comparison } from "../../types.ts";
import { exists } from "../../storage/fs.ts";
import {
  CompareRequestSchema,
  CheckRequestSchema,
  ExplainRequestSchema,
  ScenariosRequestSchema,
  type DashboardJob,
  type JobRequest,
  type RunSetup,
} from "./types.ts";

/** Forwards structured progress to the dashboard; log lines have no reader here. */
const ipcReporter: Reporter = {
  progress: (event) => {
    if (process.connected) process.send?.({ type: "progress", progress: event });
  },
  log() {},
  runSaved() {},
};

const send = (value: unknown) =>
  new Promise<void>((resolve) => {
    if (!process.connected) return resolve();
    process.send!(value, () => resolve());
  });
// A killed worker must run synchronous exit cleanup for git worktrees.
process.once("SIGTERM", () => process.exit(130));
process.once("SIGINT", () => process.exit(130));
process.once("disconnect", () => process.exit(130));

export function publicError(error: unknown): string {
  let message =
    error instanceof z.ZodError
      ? error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
      : error instanceof Error
        ? error.message
        : "The job failed.";
  for (const [key, value] of Object.entries(process.env))
    if (/key|token|secret|password/i.test(key) && value && value.length >= 6)
      message = message.split(value).join("[redacted]");
  return message
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/sk-[\w-]+/g, "[redacted]")
    .slice(0, 1600);
}

async function setup(): Promise<RunSetup> {
  const { config, rootDir } = await loadConfig();
  const tests = await loadTests(rootDir, config.tests);
  const { refs, defaultRef } = await listRefs(rootDir);
  return {
    config,
    testCount: tests.length,
    onlyIncidentTests: tests.length > 0 && tests.every((t) => !!t.replay),
    refs,
    defaultRef,
  };
}

async function execute(request: JobRequest): Promise<Partial<DashboardJob>> {
  if (request.kind === "explain") {
    const { dir } = ExplainRequestSchema.parse(request.options);
    ipcReporter.progress({
      phase: "explaining",
      message: "Writing detailed analysis from the prompt diff and per-test numbers",
      dir,
    });
    await saveDetailedExplanation(await locateWorkspace(), dir);
    return { status: "complete", resultDir: dir, message: "Detailed explanation saved." };
  }
  if (request.kind === "check") {
    const { runs } = CheckRequestSchema.parse(request.options);
    const { dir, result } = await runCheck({ runs, reporter: ipcReporter });
    return { status: "complete", resultDir: path.basename(dir), message: healthHeadline(result) };
  }
  if (request.kind === "scenarios") {
    const { perItem } = ScenariosRequestSchema.parse(request.options);
    const { dir, result } = await draftScenarios({ perItem, reporter: ipcReporter });
    if (!result.drafts.length)
      return { status: "error", message: `No scenarios were written. ${result.failed[0]?.reason ?? ""}`.trim() };
    return { status: "complete", resultDir: path.basename(dir), message: scenariosHeadline(result) };
  }
  const options = CompareRequestSchema.parse(request.options);
  const result = await runComparison(options.mode === "git" ? options.ref : undefined, {
    ifChanged: options.ifChanged,
    discovery: options.discovery,
    reporter: ipcReporter,
  });
  if (result.skipped) return { status: "skipped", message: result.reason };
  return { resultDir: path.basename(result.dir), ...comparisonStatus(result.comparison) };
}

/** Job status + message for a finished comparison. */
function comparisonStatus(comparison: Comparison): Pick<DashboardJob, "status" | "message"> {
  if (failedSides(comparison).length) {
    return { status: "error", message: "Comparison could not complete. Open the result to inspect the failed runs." };
  }
  // A blocked stage (discovery on an unsupported agent, a missing key) doesn't fail the comparison; the result says what's missing.
  const incomplete = incompleteStages(comparison);
  return {
    status: "complete",
    message: incomplete ? `Comparison saved · incomplete · ${incomplete}` : "Comparison saved.",
  };
}

process.once("message", async (request: JobRequest | ProjectRequest | ScenarioRequest | { kind: "setup" }) => {
  try {
    // Reload project credentials in this process; never send them to the browser.
    if (typeof process.loadEnvFile === "function" && (await exists(".env"))) process.loadEnvFile(".env");
    if (request.kind === "setup") await send({ type: "setup", setup: await setup() });
    else if (request.kind.startsWith("project-"))
      await send({ type: "project", result: await projectOperation(request as ProjectRequest) });
    else if (request.kind.startsWith("scenarios-"))
      await send({ type: "project", result: await scenarioOperation(request as ScenarioRequest) });
    else await send({ type: "result", result: await execute(request as JobRequest) });
    process.exit(0);
  } catch (error) {
    await send({ type: "error", error: publicError(error) });
    process.exit(1);
  }
});
