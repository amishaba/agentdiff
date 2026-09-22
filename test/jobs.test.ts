import { it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { JobManager } from "../src/dashboard/jobs/manager.ts";
import { CompareRequestSchema, isActiveJob, type DashboardJob } from "../src/dashboard/jobs/types.ts";
import { createViewServer } from "../src/dashboard/server.ts";
import { claimExecution, executionBusy } from "../src/dashboard/execution-lock.ts";
import { readJson, writeJson } from "../src/storage/fs.ts";
import { saveDetailedExplanation } from "../src/dashboard/jobs/explanation.ts";
import { Workspace } from "../src/storage/workspace.ts";
import { comparison } from "./helpers.ts";

const exec = promisify(execFile);
const json = (response: Response) => response.json() as Promise<Record<string, any>>;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, message: string) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 15_000) assert.fail(message);
    await pause(20);
  }
}
async function finished(job: DashboardJob) {
  await until(() => !isActiveJob(job), `Job did not finish: ${JSON.stringify(job)}`);
  return job;
}
function agent(
  prompt: string,
  // Runs take 30-180 ms, so they finish one by one and progress has steps to observe.
  behavior = 'await new Promise(r => setTimeout(r, 30 + Math.random() * 150)); return {text: "done", steps: [], usage: {inputTokens: 1, outputTokens: 1}};',
) {
  return `export const agent = {name:"offline-agent", instructions:${JSON.stringify(prompt)}, model:"offline", tools:{}, generate:async()=>{${behavior}}};`;
}

it("validates job inputs and rejects unsupported discovery modes", () => {
  for (const input of [
    { mode: "git" },
    { mode: "git", ref: "--help" },
    { mode: "files", ref: "main" },
    { mode: "baseline" },
    { mode: "git", ref: "main", command: "rm -rf" },
    { mode: "git", ref: "main", discovery: { enabled: true, maxAgentRuns: 20, confirmationRuns: 10 } },
  ])
    assert.equal(CompareRequestSchema.safeParse(input).success, false);
  assert.equal(
    CompareRequestSchema.safeParse({ mode: "git", ref: "feature/change", discovery: { maxRounds: 1 } }).success,
    true,
  );
  assert.equal(CompareRequestSchema.safeParse({ mode: "files", discovery: { maxRounds: 1 } }).success, true);
});

it(
  "executes real comparison workers, counts saved evidence, and cancels, times out and fails cleanly",
  { timeout: 60_000 },
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentdiff-jobs-"));
    const manager = new JobManager(dir);
    const config = (runs: number, offline = true) =>
      `for (const k of ["OPENAI_API_KEY","AI_GATEWAY_API_KEY","VERCEL_OIDC_TOKEN","AGENTDIFF_GRADER"]) delete process.env[k]; ${offline ? 'process.env.AGENTDIFF_OFFLINE="1";' : "delete process.env.AGENTDIFF_OFFLINE;"} export default {agent:"agent",agentPath:"new.mjs",versions:{old:"old.mjs",new:"new.mjs"},tests:"tests",runsPerTest:${runs}};`;
    const configure = async (runs: number, offline = true) =>
      fs.writeFile(path.join(dir, "agentdiff.config.mjs"), config(runs, offline));
    const startComparison = (mode: "files" | "git", ifChanged = false) =>
      manager.start({ kind: "compare", options: { mode, ifChanged, ...(mode === "git" ? { ref: "main" } : {}) } });
    try {
      await fs.mkdir(path.join(dir, "tests"));
      await fs.writeFile(path.join(dir, "tests", "read.json"), JSON.stringify({ name: "read", input: "Read this" }));
      await configure(4);
      await fs.writeFile(path.join(dir, "old.mjs"), agent("Read first"));
      await fs.writeFile(path.join(dir, "new.mjs"), agent("Read quickly"));
      await fs.writeFile(path.join(dir, ".gitignore"), ".agentdiff/\n");
      await exec("git", ["init", "-b", "main"], { cwd: dir });
      await exec("git", ["add", "."], { cwd: dir });
      await exec(
        "git",
        ["-c", "user.name=AgentDiff test", "-c", "user.email=test@example.invalid", "commit", "-m", "test project"],
        { cwd: dir },
      );
      const setup = await manager.setup();
      assert.equal(setup.testCount, 1);
      assert.ok(setup.refs.includes("main"));
      // Every stage runs, so a comparison without its keys stops before any agent does, and says which keys.
      await configure(4, false);
      const keyless = await finished(startComparison("files"));
      assert.equal(keyless.status, "error");
      assert.equal(keyless.resultDir, undefined);
      assert.match(keyless.message!, /OPENAI_API_KEY — discovery planning and the explanation/);
      assert.match(keyless.message!, /AI_GATEWAY_API_KEY — grading and checks with Jev/);
      await configure(4);
      const job = startComparison("files");
      assert.throws(() => claimExecution("braintrust-replay"), /running/);
      const seen = new Set<number>();
      while (isActiveJob(job)) {
        if (job.dir && job.progress.completed != null) {
          const root = path.join(dir, ".agentdiff", job.dir);
          const saved = (
            await Promise.all(["runs", "old-runs"].map((p) => fs.readdir(path.join(root, p)).catch(() => [])))
          ).flat().length;
          assert.ok(job.progress.completed <= saved, "Progress cannot lead saved evidence");
          assert.equal(job.progress.total, 8);
          seen.add(job.progress.completed);
        }
        await pause(10);
      }
      assert.equal(job.status, "complete", job.message);
      assert.ok(seen.size >= 2);
      assert.equal(job.progress.completed, 8);
      const result = await readJson<any>(path.join(dir, ".agentdiff", job.resultDir!, "comparison.json"));
      assert.equal(result.tests[0].old.runs, 4);
      assert.equal(result.tests[0].new.runs, 4);
      // Every stage is recorded in order; with no keys, judging and the explanation say they were blocked.
      assert.deepEqual(
        result.stages.map((s: any) => `${s.stage}:${s.status}`),
        [
          "collect:done",
          "snapshot:done",
          "run:done",
          "discover:blocked",
          "judge:blocked",
          "explain:blocked",
          "save:done",
        ],
      );
      // Offline, agentdiff makes no model calls: judging, discovery and the explanation say so, and the job still completes.
      assert.match(result.stages.find((s: any) => s.stage === "judge").detail, /^offline; /);
      assert.equal(result.grader, "jev");
      assert.match(job.message!, /^Comparison saved · incomplete · discover blocked: offline/);
      assert.equal((await finished(startComparison("git", true))).status, "skipped");
      await fs.writeFile(path.join(dir, "new.mjs"), agent("Changed working tree"));
      assert.equal((await finished(startComparison("git"))).status, "complete");
      assert.ok(!(await fs.readdir(path.join(dir, ".agentdiff"))).some((name) => name.startsWith("worktree-")));
      // A fresh worker reloads edited config, with no server import cache.
      await configure(2);
      assert.equal((await manager.setup()).config.runsPerTest, 2);
      await fs.writeFile(
        path.join(dir, "old.mjs"),
        agent("Hang", 'await new Promise(r => setTimeout(r, 60_000)); return {text:"late"};'),
      );
      const cancelled = startComparison("files");
      await until(
        () => cancelled.progress.phase === "runs" && (cancelled.progress.completed ?? 0) >= 2,
        "The old agent's runs did not begin",
      );
      manager.cancel(cancelled.id);
      assert.equal((await finished(cancelled)).status, "cancelled");
      assert.ok(!(await fs.readdir(path.join(dir, ".agentdiff"))).some((name) => name.startsWith("worktree-")));
      const timeoutManager = new JobManager(dir, 1000);
      const timedOut = await finished(
        timeoutManager.start({ kind: "compare", options: { mode: "files", ifChanged: false } }),
      );
      assert.equal(timedOut.status, "error");
      assert.match(timedOut.message!, /timed out/);
      await fs.writeFile(path.join(dir, "old.mjs"), agent("Fail", 'throw new Error("offline failure");'));
      const failed = await finished(startComparison("files"));
      assert.equal(failed.status, "error");
      assert.match(failed.message!, /could not complete/);
      assert.equal(executionBusy(), false);
      await fs.writeFile(
        path.join(dir, "agentdiff.config.mjs"),
        'process.env.JOBS_TEST_SECRET="test-secret-value"; throw new Error("Credential test-secret-value was rejected");',
      );
      await assert.rejects(manager.setup(), /Credential \[redacted\] was rejected/);
    } finally {
      manager.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);

it(
  "protects local job routes and keeps detailed explanations scoped to the selected comparison",
  { timeout: 30_000 },
  async () => {
    const cwd = process.cwd(),
      key = process.env.OPENAI_API_KEY;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentdiff-jobs-http-"));
    const manager = new JobManager(dir);
    const server = createViewServer(manager);
    try {
      delete process.env.OPENAI_API_KEY;
      process.chdir(dir);
      await writeJson(".agentdiff/compare-first/comparison.json", comparison({ explanation: "Short first" }));
      await writeJson(".agentdiff/compare-second/comparison.json", comparison({ explanation: "Short second" }));
      await saveDetailedExplanation(new Workspace("."), "compare-first", async (selected, options) => {
        assert.equal(selected.explanation, "Short first");
        assert.equal(options.detail, "detailed");
        assert.equal(options.throwOnError, true);
        return "Detailed first";
      });
      await assert.rejects(
        saveDetailedExplanation(new Workspace("."), "compare-first", async () => {
          throw new Error("provider unavailable");
        }),
        /provider unavailable/,
      );
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const url = `http://127.0.0.1:${(server.address() as any).port}`;
      const get = (p: string, headers = { "x-agentdiff": "local" }) => fetch(url + p, { headers });
      const post = (p: string, body: unknown) =>
        fetch(url + p, {
          method: "POST",
          headers: { "x-agentdiff": "local", "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      assert.equal((await get("/api/jobs/status", {} as any)).status, 403);
      assert.equal(
        (await get("/api/jobs/status", { "x-agentdiff": "local", origin: "https://other.invalid" } as any)).status,
        403,
      );
      assert.equal((await post("/api/jobs/explain", { dir: "../outside" })).status, 400);
      assert.equal((await post("/api/jobs/compare", { mode: "baseline" })).status, 400);
      assert.equal((await post("/api/jobs/discover", { mode: "git", ref: "main" })).status, 404);
      const release = claimExecution("braintrust-replay");
      assert.equal((await post("/api/jobs/compare", { mode: "files" })).status, 409);
      release();
      assert.equal((await post("/api/jobs/baseline", { replace: false })).status, 404);
      assert.equal((await json(await get("/api/explanation?dir=compare-first&kind=short"))).text, "Short first");
      const detailed = await json(await get("/api/explanation?dir=compare-first&kind=detailed"));
      assert.equal(detailed.text, "Detailed first");
      assert.ok(detailed.generatedAt);
      assert.equal((await json(await get("/api/explanation?dir=compare-second&kind=detailed"))).text, "");
      assert.equal((await get("/api/explanation?dir=compare-first&kind=other")).status, 400);
      const response = await post("/api/jobs/explain", { dir: "compare-second" });
      assert.equal(response.status, 202);
      const started = await json(response);
      const failed = await finished(manager.get(started.id)!);
      assert.equal(failed.status, "error");
      assert.equal(failed.explanationDir, "compare-second");
      assert.match(failed.message!, /OPENAI_API_KEY/);
      assert.equal((await json(await get(`/api/jobs/${started.id}`))).status, "error");
      assert.equal((await json(await get("/api/jobs/status"))).job.id, started.id);
      assert.equal((await post(`/api/jobs/${started.id}/extra/cancel`, {})).status, 404);
      assert.equal(
        (await fs.readFile(".agentdiff/compare-first/explanation.md", "utf8")).includes("Detailed first"),
        true,
      );
      await assert.rejects(fs.access(".agentdiff/compare-second/explanation.md"));
    } finally {
      manager.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      process.chdir(cwd);
      if (key === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = key;
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);
