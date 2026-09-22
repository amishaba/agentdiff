// `agentdiff check`: one version of the agent, run several times per test, with
// a verdict per test. Unpredictable means the runs disagree with each other.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { testHealth } from "../src/health/health.ts";
import { healthReport } from "../src/health/report.ts";
import { byStatus, describeMovement, healthDetail, healthHeadline } from "../src/health/describe.ts";
import { runCheck } from "../src/pipeline/check.ts";
import { createViewServer } from "../src/dashboard/server.ts";
import { JobManager } from "../src/dashboard/jobs/manager.ts";
import type { RunRecord, TestFile } from "../src/types.ts";
import { run } from "./helpers.ts";

const refund: TestFile = {
  name: "refund",
  input: "refund order 7",
  must_call_tools: ["lookup_customer"],
  must_not_call_tools: ["delete_account"],
  grading_criteria: "Refunds after looking the customer up.",
};
/** Runs 1…n of one test, each calling `tools(i)`. */
const runs = (n: number, tools: (i: number) => string[], over: Partial<RunRecord> = {}) =>
  Array.from({ length: n }, (_, i) => run(tools(i + 1), { test: "refund", run: i + 1, ...over }));
const graded = (scores: number[]) => ({
  grades: scores.map((score, i) => ({ test: "refund", version: "new" as const, run: i + 1, score, reason: "" })),
  checks: [],
});
const health = (records: RunRecord[], scores: number[] = []) => testHealth(refund, records, graded(scores), "gpt-test");

describe("a test's verdict", () => {
  it("is steady when every run keeps the rules, scores well and takes the same path", () => {
    const h = health(
      runs(4, () => ["lookup_customer", "refund"]),
      [5, 5, 4, 5],
    );
    assert.equal(h.status, "steady");
    assert.deepEqual(h.rules, [
      { tool: "lookup_customer", kind: "required", kept: 4, of: 4 },
      { tool: "delete_account", kind: "forbidden", kept: 4, of: 4 },
    ]);
    assert.equal(h.score, 4.75);
    assert.deepEqual(h.usualPath, { steps: ["lookup_customer", "refund"], runs: 4, of: 4 });
    assert.deepEqual([h.paths, h.unsteady], [1, []]);
  });

  it("breaks a test rule when one run calls a forbidden tool, however well it scores", () => {
    const h = health(
      runs(4, (i) => (i === 3 ? ["lookup_customer", "delete_account"] : ["lookup_customer", "refund"])),
      [5, 5, 5, 5],
    );
    assert.equal(h.status, "rule");
    assert.equal(healthDetail(h).split(";")[0], "called delete_account in 1/4 runs");
  });

  it("scores low below 3 on average, and says so", () => {
    const h = health(
      runs(4, () => ["lookup_customer"]),
      [2, 2, 3, 2],
    );
    assert.equal(h.status, "low");
    assert.equal(healthDetail(h), "scored 2.3 of 5 on average");
  });

  it("is unpredictable when some runs call a tool and others don't", () => {
    const h = health(runs(4, (i) => (i <= 2 ? ["lookup_customer", "escalate"] : ["lookup_customer", "refund"])));
    assert.equal(h.status, "unsteady");
    assert.deepEqual(h.unsteady, ["tool:escalate", "tool:refund"]);
    assert.match(healthDetail(h), /^runs differ in whether it calls escalate, whether it calls refund/);
  });

  it("is unpredictable when scores run from good to bad, not when they wobble", () => {
    const calls = () => ["lookup_customer", "refund"];
    assert.equal(health(runs(4, calls), [5, 5, 3, 4]).status, "steady", "5, 5, 3, 4 is grader wobble");
    const h = health(runs(4, calls), [5, 2, 5, 4]);
    assert.deepEqual([h.status, h.unsteady], ["unsteady", ["grade"]]);
  });

  it("needs two runs to disagree on a check before calling it unpredictable", () => {
    const answered = (choices: string[]) => ({
      grades: [],
      checks: choices.map((choice, i) => ({
        test: "refund",
        version: "new" as const,
        run: i + 1,
        answers: { failure_type: { type: "choice" as const, choice, probabilities: { [choice]: 1 } } },
      })),
    });
    const four = runs(4, () => ["lookup_customer", "refund"]);
    const once = testHealth(refund, four, answered(["none", "none", "skipped_step", "none"]), "gpt-test");
    assert.equal(once.status, "steady", "one judge's flip on one run");
    const twice = testHealth(refund, four, answered(["none", "skipped_step", "none", "skipped_step"]), "gpt-test");
    assert.deepEqual([twice.status, twice.unsteady], ["unsteady", ["check:failure_type"]]);
  });

  it("doesn't call run-time jitter unpredictable", () => {
    const h = health(
      runs(4, () => ["lookup_customer"], {}).map((r) => ({ ...r, latency_ms: r.run <= 2 ? 300 : 9000 })),
    );
    assert.equal(h.status, "steady");
  });

  it("errors when every run errored, and lists tests worst first", () => {
    const failed = health(runs(2, () => [], { error: "provider down" }));
    assert.equal(failed.status, "error");
    const steady = health(runs(2, () => ["lookup_customer"]));
    assert.deepEqual(
      byStatus([steady, failed]).map((h) => h.status),
      ["error", "steady"],
    );
  });

  it("says what moved in plain words", () => {
    assert.deepEqual(
      ["tool:send_sms", "required:x", "path", "reply", "grade", "check:verified"].map(describeMovement),
      [
        "whether it calls send_sms",
        "whether it calls x",
        "the steps it takes",
        "whether it replies",
        "its score",
        "the answer to verified",
      ],
    );
  });
});

describe("agentdiff check", () => {
  it("runs the agent as it is on every test and saves a verdict per test", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentdiff-check-"));
    await fs.mkdir(path.join(dir, "tests"));
    await fs.writeFile(
      path.join(dir, "tests/refund.json"),
      JSON.stringify({ name: "refund", input: "refund order 7", must_call_tools: ["lookup_customer"] }),
    );
    await fs.writeFile(
      path.join(dir, "tests/thanks.json"),
      JSON.stringify({ name: "thanks", input: "thanks!", must_not_call_tools: ["send_sms"] }),
    );
    // Refunds without the lookup, and texts back a thank-you it was told not to send.
    await fs.writeFile(
      path.join(dir, "agent.mjs"),
      `export const agent = {
  instructions: "Look the customer up first.",
  tools: ["lookup_customer", "refund", "send_sms"],
  run: async (input) => ({ text: "", toolCalls: input.startsWith("refund") ? [{ tool: "refund" }] : [{ tool: "send_sms" }] }),
};\n`,
    );
    await fs.writeFile(
      path.join(dir, "agentdiff.config.mjs"),
      `export default { agent: "agent", agentPath: "agent.mjs", tests: "tests", runsPerTest: 4 };\n`,
    );
    process.env.AGENTDIFF_OFFLINE = "1";
    try {
      const { dir: out, result } = await runCheck({ config: path.join(dir, "agentdiff.config.mjs"), runs: 2 });
      assert.equal(result.graded, false);
      assert.deepEqual(
        result.tests.map((t) => [t.test, t.status, t.runs]),
        [
          ["refund", "rule", 2],
          ["thanks", "rule", 2],
        ],
      );
      assert.equal(healthHeadline(result), "0 of 2 tests steady · 2 break a test rule");
      const report = await fs.readFile(path.join(out, "report.md"), "utf8");
      assert.equal(report, healthReport(result));
      assert.match(report, /\| thanks \| Breaks a test rule \|.*called send_sms in 2\/2 runs/);
      assert.equal((await fs.readdir(path.join(out, "runs"))).length, 4, "every run is saved, for its trace");

      // A check stopped after its runs is judged from what it saved, without running the agent again.
      await fs.writeFile(
        path.join(dir, "agent.mjs"),
        "export const agent = { run: async () => { throw new Error('ran again'); } };\n",
      );
      const resumed = await runCheck({ config: path.join(dir, "agentdiff.config.mjs"), resume: path.basename(out) });
      assert.equal(resumed.dir, out, "the same folder");
      assert.deepEqual(
        resumed.result.tests.map((t) => [t.test, t.status, t.runs]),
        result.tests.map((t) => [t.test, t.status, t.runs]),
      );

      // The dashboard reads the saved check back, every run with its tool calls.
      const server = createViewServer(new JobManager(dir));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const get = async (p: string) => (await fetch(base + p, { headers: { "x-agentdiff": "local" } })).json();
        assert.equal((await fetch(base + "/api/checks")).status, 403, "a request from another page is refused");
        const [summary] = await get("/api/checks");
        assert.deepEqual([summary.dir, summary.tests, summary.steady], [path.basename(out), 2, 0]);
        const saved = await get(`/api/checks/run?dir=${summary.dir}`);
        assert.deepEqual(
          saved.runs.thanks.map((r: { toolCalls: { tool: string }[] }) => r.toolCalls.map((c) => c.tool)),
          [["send_sms"], ["send_sms"]],
        );
        assert.equal(
          (await fetch(`${base}/api/checks/run?dir=../outside`, { headers: { "x-agentdiff": "local" } })).status,
          404,
        );
      } finally {
        server.close();
      }
    } finally {
      delete process.env.AGENTDIFF_OFFLINE;
    }
  });

  it("needs at least two runs, to compare them", async () => {
    await assert.rejects(runCheck({ config: "missing.mjs", runs: 1 }), /at least 2/);
  });
});
