import fixture from "../../fixtures/dashboard.json" with { type: "json" };
import scenarioRuns from "../../fixtures/scenarios.json" with { type: "json" };
import checkRuns from "../../fixtures/check.json" with { type: "json" };
import type { DemoFixture, DemoState } from "./types.ts";
import type { DashboardJob, JobKind } from "../../../src/dashboard/jobs/types.ts";
import {
  CheckRequestSchema,
  CompareRequestSchema,
  ExplainRequestSchema,
  ScenariosRequestSchema,
} from "../../../src/dashboard/jobs/types.ts";
import { AddScenariosSchema, type ScenarioRun } from "../../../src/dashboard/scenarios/types.ts";
import type { CheckRun } from "../../../src/dashboard/check/types.ts";
import { ConfigWriteSchema, PromoteDraftSchema } from "../../../src/dashboard/project/types.ts";
import { ReplayResponseSchema } from "../../../src/types.ts";
import { z } from "zod";

export const SAMPLE_STORAGE_KEY = "agentdiff-sample-workspace-v1";
// The newest comparison, so a fixture baked from a real workspace (scripts/bake-demo-from-workspace.ts) works too.
const mainDir = (fixture as unknown as DemoFixture).runs[0]?.dir ?? "compare-sample-workspace";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const markdown = (value: string) =>
  new Response(value, { headers: { "content-type": "text/markdown; charset=utf-8" } });
const reviewSchema = z.object({
  id: z.string(),
  expectation: z.string(),
  mustCallTools: z.array(z.string()),
  responses: z.array(ReplayResponseSchema),
});

/** Isolated state also makes the hosted demo testable without a server or browser. */
export function createDemoApi(storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">) {
  const seed = (): DemoState => ({
    ...structuredClone(fixture as unknown as DemoFixture),
    scenarioRuns: structuredClone(scenarioRuns as unknown as ScenarioRun[]),
    checkRuns: structuredClone(checkRuns as unknown as CheckRun[]),
    job: null,
    projectId: "clinic-booking",
    threshold: 0.5,
    receipts: {},
  });
  let state = seed();
  try {
    const saved = JSON.parse(storage?.getItem(SAMPLE_STORAGE_KEY) ?? "null");
    if (
      saved?.project?.revision &&
      saved?.datasets?.[mainDir] &&
      saved?.reviews &&
      saved?.receipts &&
      saved?.scenarioRuns &&
      saved?.checkRuns
    )
      state = saved;
  } catch {
    /* Disabled or corrupt storage falls back to the in-memory sample. */
  }
  const persist = () => {
    try {
      storage?.setItem(SAMPLE_STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* The sample still works without browser storage. */
    }
  };
  const fail = (message: string, status = 400) => json({ error: message }, status);
  function complete(kind: JobKind, extra: Partial<DashboardJob> = {}): DashboardJob {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      kind,
      status: "complete",
      createdAt: now,
      finishedAt: now,
      progress: { phase: "saving", message: "Recorded results loaded." },
      message: "Recorded results loaded.",
      ...extra,
    };
  }
  function route(url: URL, method: string, body: unknown): Response {
    const path = url.pathname;
    if (method === "POST" && path === "/api/demo/reset") {
      try {
        storage?.removeItem(SAMPLE_STORAGE_KEY);
      } catch {
        /* storage blocked; the reset still applies in memory */
      }
      state = seed();
      return json({ ok: true });
    }
    if (method === "GET") {
      if (path === "/api/runs") return json(state.runs);
      if (["/api/comparison", "/api/traces", "/api/grades", "/api/explanation", "/api/report"].includes(path)) {
        const data = state.datasets[url.searchParams.get("dir") ?? mainDir];
        if (!data) return fail("This comparison is not part of this recorded run. Select one above.", 404);
        if (path === "/api/report") return markdown(data.report);
        if (path === "/api/explanation")
          return json({ text: url.searchParams.get("kind") === "detailed" ? data.detailed : data.explanation });
        return json(path === "/api/comparison" ? data.comparison : path === "/api/traces" ? data.traces : data.grades);
      }
      if (path === "/api/project") return json(state.project);
      if (path === "/api/project/drafts") return json(state.drafts);
      if (path === "/api/project/draft") {
        const draft = state.drafts.drafts.find(
          (d) => d.dir === url.searchParams.get("dir") && d.file === url.searchParams.get("file"),
        );
        return draft
          ? json({
              name: draft.name,
              input: draft.input,
              must_call_tools: [],
              grading_criteria: "",
              _discovery: {
                findingId: draft.findingId,
                hypothesis: draft.hypothesis,
                evidence: draft.experimentId,
                review: "Review the expected behaviour before adding.",
              },
              _sample: true,
            })
          : fail("This draft is not available.", 404);
      }
      if (path === "/api/scenarios")
        return json(
          state.scenarioRuns.map((r) => ({
            dir: r.dir,
            agentName: r.agentName,
            createdAt: r.createdAt,
            scenarios: r.drafts.length,
            items: r.plan.length,
          })),
        );
      if (path === "/api/scenarios/run") {
        const run = state.scenarioRuns.find((r) => r.dir === url.searchParams.get("dir"));
        return run ? json(run) : fail("This scenarios run is not part of this recorded run.", 404);
      }
      if (path === "/api/checks")
        return json(
          state.checkRuns.map((r) => ({
            dir: r.dir,
            agentName: r.agentName,
            createdAt: r.createdAt,
            tests: r.tests.length,
            steady: r.tests.filter((t) => t.status === "steady").length,
            runsPerTest: r.runsPerTest,
          })),
        );
      if (path === "/api/checks/run") {
        const run = state.checkRuns.find((r) => r.dir === url.searchParams.get("dir"));
        return run ? json(run) : fail("This check is not part of this recorded run.", 404);
      }
      if (path === "/api/jobs/setup")
        return json({ ...state.setup, config: state.project.config, testCount: state.project.testCount });
      if (path === "/api/jobs/status") return json({ job: state.job, busy: false });
      if (path.startsWith("/api/jobs/"))
        return path === `/api/jobs/${state.job?.id}` ? json(state.job) : fail("This job is not available.", 404);
      if (path === "/api/braintrust/status")
        return json({ connected: true, projectId: state.projectId, threshold: state.threshold });
      if (path === "/api/braintrust/projects")
        return json({ projects: [{ id: "clinic-booking", name: "Bramblewood clinic booking" }] });
      if (path === "/api/braintrust/incidents") {
        const incidents = state.incidents.filter(
          (i) => i.errorCount || (i.scores ?? []).some((s) => s.value < state.threshold),
        );
        return json({ incidents, hasMore: false, checkedAt: "2026-09-24T14:30:00.000Z" });
      }
      if (path === "/api/braintrust/missing") {
        // A recorded run has its incidents' tool outputs already: nothing is missing.
        return json({ dir: null, missing: [] });
      }
      if (path === "/api/braintrust/scenario")
        return state.reviews[url.searchParams.get("id") ?? ""]
          ? json(state.reviews[url.searchParams.get("id")!])
          : fail("Sample incident unavailable.", 404);
    }
    if (method === "POST") {
      if (path === "/api/project/config") {
        const request = ConfigWriteSchema.parse(body);
        if (request.revision !== state.project.revision)
          return fail("The sample settings changed. Reload the project before saving.", 409);
        state.project.config = request.config;
        state.project.revision = (parseInt(state.project.revision.slice(-8), 16) + 1).toString(16).padStart(64, "0");
        return json({ config: state.project.config, revision: state.project.revision });
      }
      if (path === "/api/project/drafts/promote") {
        const request = PromoteDraftSchema.parse(body);
        if (state.receipts[request.requestId]) return json(state.receipts[request.requestId]);
        const draft = state.drafts.drafts.find((d) => d.dir === request.dir && d.file === request.file);
        if (!draft || draft.revision !== request.draftRevision || state.project.revision !== request.revision)
          return fail("Reload this draft before saving.", 409);
        if (!draft.savedFile) {
          draft.savedFile = `discovery-sample-${state.project.testCount + 1}.json`;
          state.project.testCount++;
        }
        return json(
          (state.receipts[request.requestId] = { files: [draft.savedFile], testsDir: state.project.config.tests }),
        );
      }
      if (path === "/api/scenarios/add") {
        const request = AddScenariosSchema.parse(body);
        if (state.receipts[request.requestId]) return json(state.receipts[request.requestId]);
        const run = state.scenarioRuns.find((r) => r.dir === request.dir);
        const drafts = request.files.map((file) => run?.drafts.find((d) => d.file === file));
        if (!run || drafts.some((d) => !d || d.issue)) return fail("Reload these sample scenarios before adding.", 409);
        const files = drafts.map((d) => {
          if (!d!.savedFile) {
            d!.savedFile = `scenario-sample-${state.project.testCount + 1}.json`;
            state.project.testCount++;
          }
          return d!.savedFile;
        });
        return json((state.receipts[request.requestId] = { files, testsDir: state.project.config.tests }));
      }
      if (path === "/api/jobs/check") {
        CheckRequestSchema.parse(body);
        state.job = complete("check", { resultDir: state.checkRuns[0].dir });
        return json(state.job);
      }
      if (path === "/api/jobs/scenarios") {
        ScenariosRequestSchema.parse(body);
        state.job = complete("scenarios", { resultDir: state.scenarioRuns[0].dir });
        return json(state.job);
      }
      if (path === "/api/jobs/compare") {
        CompareRequestSchema.parse(body);
        state.job = complete("compare", { resultDir: mainDir });
        return json(state.job);
      }
      if (path === "/api/jobs/explain") {
        const request = ExplainRequestSchema.parse(body);
        if (!state.datasets[request.dir]) return fail("This comparison is not available.", 404);
        state.job = complete("explain", { explanationDir: request.dir, resultDir: request.dir });
        return json(state.job);
      }
      if (path === "/api/braintrust/project") {
        const request = z
          .object({ projectId: z.literal("clinic-booking"), threshold: z.number().min(0).max(1) })
          .parse(body);
        state.projectId = request.projectId;
        state.threshold = request.threshold;
        return json({ ok: true });
      }
      if (path === "/api/braintrust/connect")
        return fail("No API key is needed to browse this recorded run. Connect your account from the local app.");
      if (path === "/api/braintrust/review") {
        const request = reviewSchema.parse(body),
          review = state.reviews[request.id];
        if (!review) return fail("Sample incident unavailable.", 404);
        review.expectation = request.expectation;
        review.mustCallTools = request.mustCallTools;
        review.reviewed = true;
        for (const response of request.responses) {
          review.responses = review.responses.filter(
            (r) =>
              r.tool !== response.tool ||
              r.occurrence !== response.occurrence ||
              JSON.stringify(r.input) !== JSON.stringify(response.input),
          );
          review.responses.push(response);
        }
        const revision = crypto.randomUUID();
        const incident = state.incidents.find((i) => i.id === request.id)!;
        incident.reviewed = true;
        incident.reviewRevision = revision;
        return json({ ...review, reviewRevision: revision });
      }
      if (path === "/api/braintrust/add") {
        const request = z.object({ id: z.string() }).parse(body),
          review = state.reviews[request.id];
        if (!review?.reviewed) return fail("Review the incident first.");
        const incident = state.incidents.find((i) => i.id === request.id)!,
          file = `incident-${request.id}.json`;
        incident.savedFile = file;
        incident.savedRevision = incident.reviewRevision;
        return json({ file, testsDir: state.project.config.tests, reviewRevision: incident.reviewRevision });
      }
    }
    return fail("This action is not available in the recorded run.", 404);
  }
  return async (input: string, init?: RequestInit): Promise<Response> => {
    init?.signal?.throwIfAborted();
    try {
      const url = new URL(input, "https://sample.agentdiff.invalid");
      if (url.origin !== "https://sample.agentdiff.invalid" || !url.pathname.startsWith("/api/"))
        return fail("The recorded run only handles its own API routes.", 400);
      const response = route(url, init?.method ?? "GET", init?.body ? JSON.parse(String(init.body)) : undefined);
      if (response.ok && (init?.method ?? "GET") === "POST") persist();
      return response;
    } catch (error) {
      return fail(
        error instanceof z.ZodError
          ? "Check the sample form values."
          : error instanceof Error
            ? error.message
            : "Sample action failed.",
      );
    }
  };
}
let api: ReturnType<typeof createDemoApi> | undefined;
export function demoRequest(url: string, init?: RequestInit) {
  if (!api) {
    let storage: Storage | undefined;
    try {
      storage = window.sessionStorage;
    } catch {
      /* storage blocked (private mode): run without persistence */
    }
    api = createDemoApi(storage);
  }
  return api(url, init);
}
