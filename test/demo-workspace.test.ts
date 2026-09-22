/// <reference lib="dom" />
import assert from "node:assert/strict";
import { it } from "node:test";
import fixture from "../web/fixtures/dashboard.json" with { type: "json" };
import { createDemoApi, SAMPLE_STORAGE_KEY } from "../web/src/demo/api.ts";
import { RunRecordSchema, TestFileSchema } from "../src/types.ts";
import type { DemoFixture } from "../web/src/demo/types.ts";
import { behaviorDifference } from "../src/discovery/behavior.ts";

const seed = fixture as unknown as DemoFixture;
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
const memory = () => {
  const values = new Map<string, string>();
  return {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
    removeItem: (k: string) => {
      values.delete(k);
    },
  };
};

// The baked stats also hold check answers, which the demo doesn't ship, so this recounts what the traces and
// grades shipped with it can say: runs, errors and the average grade of every test on both sides.
it("the baked comparison's numbers agree with its own traces and grades", () => {
  for (const d of Object.values(seed.datasets)) {
    for (const version of ["old", "new"] as const) {
      for (const r of d.traces[version]) RunRecordSchema.parse(r);
      for (const t of d.comparison.tests) {
        const runs = d.traces[version].filter((r) => r.test === t.test);
        assert.equal(t[version].runs, runs.length, `${t.test} ${version} runs`);
        assert.equal(t[version].errors, runs.filter((r) => r.error).length, `${t.test} ${version} errors`);
        const scores = d.grades.filter((g) => g.test === t.test && g.version === version).map((g) => g.score);
        const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
        assert.ok(
          mean == null ? t[version].avgGrade == null : Math.abs(t[version].avgGrade! - mean) < 1e-9,
          `${t.test} ${version} grade`,
        );
      }
    }
    for (const experiment of d.comparison.discovery?.experiments ?? [])
      for (const c of experiment.cases) assert.deepEqual(c.difference, behaviorDifference(c.old, c.new));
  }
});

it("the static workspace serves every dashboard read without a backend and fails closed on unknown requests", async () => {
  const api = createDemoApi();
  for (const route of [
    "/api/runs",
    "/api/comparison",
    "/api/traces",
    "/api/grades",
    "/api/explanation?kind=detailed",
    "/api/report",
    "/api/project",
    "/api/project/drafts",
    "/api/jobs/setup",
    "/api/jobs/status",
    "/api/braintrust/status",
    "/api/braintrust/projects",
    "/api/braintrust/incidents",
  ]) {
    const response = await api(route);
    assert.equal(response.status, 200, route);
    assert.ok((await response.text()).length > 2, route);
  }
  assert.equal((await api("/api/not-implemented")).status, 404);
  assert.equal((await api("https://example.com/api/project")).status, 400);
  assert.equal((await api("/api/braintrust/connect", post({ key: "never-persist-this" }))).status, 400);
});

it("sample edits persist within browser storage, stay isolated, and reset completely", async () => {
  const storage = memory(),
    api = createDemoApi(storage);
  const project = await (await api("/api/project")).json();
  const original = project.config.runsPerTest;
  const edited = { ...project.config, runsPerTest: original + 3 };
  assert.equal((await api("/api/project/config", post({ revision: project.revision, config: edited }))).status, 200);
  assert.equal((await api("/api/project/config", post({ revision: project.revision, config: edited }))).status, 409);
  const resumed = createDemoApi(storage);
  assert.equal((await (await resumed("/api/project")).json()).config.runsPerTest, original + 3);
  assert.equal((await (await createDemoApi()("/api/project")).json()).config.runsPerTest, original);
  await resumed("/api/demo/reset", { method: "POST" });
  assert.equal((await (await resumed("/api/project")).json()).config.runsPerTest, original);
  assert.ok(!storage.getItem(SAMPLE_STORAGE_KEY)?.includes("never-persist-this"));
});

it("a recorded run without Braintrust shows an empty inbox, not a broken one", async () => {
  const api = createDemoApi();
  const inbox = await (await api("/api/braintrust/incidents")).json();
  assert.deepEqual(inbox.incidents ?? [], []);
  assert.deepEqual((await (await api("/api/braintrust/missing?id=nothing-here")).json()).missing, []);
});

it("hosted and explicit sample requests never fall through to the local API", async () => {
  const { appFetch } = await import("../web/src/data/request.ts");
  const previousWindow = globalThis.window,
    previousFetch = globalThis.fetch;
  let liveCalls = 0;
  const fakeWindow = {
    location: { search: "?view=dashboard" },
    sessionStorage: memory(),
    __AGENTDIFF__: undefined as { mode: string } | undefined,
  };
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: fakeWindow });
  globalThis.fetch = async () => {
    liveCalls++;
    return new Response('{"live":true}', { headers: { "content-type": "application/json" } });
  };
  try {
    assert.equal((await appFetch("/api/braintrust/incidents")).status, 200);
    assert.equal(liveCalls, 0);
    assert.equal((await appFetch("/api/unknown")).status, 404);
    assert.equal(liveCalls, 0);
    fakeWindow.__AGENTDIFF__ = { mode: "live" };
    fakeWindow.location.search = "?view=dashboard&demo=1";
    assert.equal((await appFetch("/api/project")).status, 200);
    assert.equal(liveCalls, 0);
    fakeWindow.location.search = "?view=dashboard";
    assert.deepEqual(await (await appFetch("/api/project")).json(), { live: true });
    assert.equal(liveCalls, 1);
  } finally {
    globalThis.fetch = previousFetch;
    Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: previousWindow });
  }
});

it("sample scenarios are valid tests, list and open without a backend, and add to the suite once", async () => {
  const api = createDemoApi(memory());
  const runs = await (await api("/api/scenarios")).json();
  assert.equal(runs.length, 1);
  const run = await (await api(`/api/scenarios/run?dir=${runs[0].dir}`)).json();
  for (const d of run.drafts) TestFileSchema.parse(d.test);
  for (const d of run.drafts)
    assert.ok(
      run.plan.some((i: { id: string }) => i.id === d.coverageId),
      "every draft belongs to a planned item",
    );
  const before = (await (await api("/api/project")).json()).testCount;
  const request = { requestId: crypto.randomUUID(), dir: run.dir, files: [run.drafts[0].file, run.drafts[1].file] };
  const added = await (await api("/api/scenarios/add", post(request))).json();
  assert.equal(added.files.length, 2);
  assert.deepEqual(await (await api("/api/scenarios/add", post(request))).json(), added, "a retry adds nothing");
  assert.equal((await (await api("/api/project")).json()).testCount, before + 2);
  const reread = await (await api(`/api/scenarios/run?dir=${run.dir}`)).json();
  assert.equal(reread.drafts[0].savedFile, added.files[0]);
  const job = await (await api("/api/jobs/scenarios", post({}))).json();
  assert.deepEqual([job.kind, job.status, job.resultDir], ["scenarios", "complete", run.dir]);
});

it("the sample check lists, opens with every run, and loads as a finished job", async () => {
  const api = createDemoApi(memory());
  const [summary] = await (await api("/api/checks")).json();
  const run = await (await api(`/api/checks/run?dir=${summary.dir}`)).json();
  assert.deepEqual(
    [...new Set(run.tests.map((t: { status: string }) => t.status))].sort(),
    ["low", "rule", "steady", "unsteady"],
    "the sample shows each verdict",
  );
  for (const t of run.tests) assert.equal(run.runs[t.test].length, run.runsPerTest);
  const job = await (await api("/api/jobs/check", post({}))).json();
  assert.deepEqual([job.kind, job.status, job.resultDir], ["check", "complete", summary.dir]);
});
