// Guards that keep a run from spending money on a suite that can't pass: tests
// that require tools the agent doesn't have are refused before anything runs,
// and a check stops early when its runs say the tests or the setup are wrong.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { APICallError, RetryError } from "ai";
import { z } from "zod";
import { brokenRules, describeBrokenRule, healthHeadline } from "../src/health/describe.ts";
import { whyStop } from "../src/health/early-stop.ts";
import { mapLimit } from "../src/lib/async.ts";
import { accountError } from "../src/lib/llm.ts";
import { runCheck } from "../src/pipeline/check.ts";
import { runComparison } from "../src/pipeline/compare.ts";
import { openaiAsk } from "../src/scenarios/model.ts";
import { missingTools, missingToolsMessage } from "../src/suite/lint.ts";
import { loadTests } from "../src/suite/load.ts";
import { checkBasis, gradeBasis, stillValid } from "../src/grade/basis.ts";
import type { RunRecord, TestFile } from "../src/types.ts";
import { run } from "./helpers.ts";

const requiring = (name: string, tools: string[]): TestFile => ({ name, input: "hi", must_call_tools: tools });

describe("tests checked against the agent's tools", () => {
  it("lists each required tool the agent lacks, with the tests that need it, most needed first", () => {
    const tests = [
      requiring("a", ["send_sms", "lookup"]),
      requiring("b", ["send_sms"]),
      requiring("c", ["notify"]),
      { name: "d", input: "hi", must_not_call_tools: ["delete"] },
    ];
    assert.deepEqual(missingTools(tests, ["lookup", "reply"]), [
      { tool: "send_sms", tests: ["a", "b"] },
      { tool: "notify", tests: ["c"] },
    ]);
    assert.deepEqual(missingTools(tests, []), [], "an agent that declares no tools can't be checked");
    const message = missingToolsMessage(missingTools(tests, ["lookup", "reply"]), ["lookup", "reply"]);
    assert.match(message, /send_sms: required by 2 tests \(a, b\)/);
    assert.match(message, /notify: required by 1 test \(c\)/);
    assert.match(message, /The agent's tools: lookup, reply\./);
  });
});

describe("when a check stops early", () => {
  const tests = Array.from({ length: 6 }, (_, i) => requiring(`t${i}`, ["send_sms"]));
  /** n runs spread over the six tests, each calling `tools(i)`. */
  const records = (n: number, tools: (i: number) => string[], over: Partial<RunRecord> = {}) =>
    Array.from({ length: n }, (_, i) => run(tools(i), { test: `t${i % 6}`, run: Math.floor(i / 6) + 1, ...over }));

  it("waits for 20 runs before judging", () => {
    assert.equal(
      whyStop(
        tests,
        records(19, () => []),
      ),
      null,
    );
  });

  it("stops when a tool many tests require is almost never called", () => {
    const reason = whyStop(
      tests,
      records(24, () => ["lookup"]),
    );
    assert.match(reason ?? "", /^6 tests require send_sms, but 0 of their first 24 runs called it/);
    assert.match(reason ?? "", /final text/);
  });

  it("keeps going when the tool is called now and then, or only a few tests require it", () => {
    assert.equal(
      whyStop(
        tests,
        records(24, (i) => (i % 8 === 0 ? ["send_sms"] : [])),
      ),
      null,
      "3 of 24 called it",
    );
    assert.equal(
      whyStop(
        tests.slice(0, 4),
        records(24, () => []).filter((r) => r.test < "t4"),
      ),
      null,
      "4 tests",
    );
  });

  it("stops when almost every run errors, with the first error", () => {
    const reason = whyStop(
      tests,
      records(20, () => [], { error: "401 Incorrect API key\nat fetch" }),
    );
    assert.equal(reason, "20 of the first 20 runs errored (401 Incorrect API key). Fix that, then run again.");
  });
});

describe("agentdiff check, guarded", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  /** A project whose six tests all require send_sms, and an agent that replies in its final text. */
  async function project(tools: string[]): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentdiff-guards-"));
    await fs.mkdir(path.join(dir, "tests"));
    for (let i = 0; i < 6; i++)
      await fs.writeFile(path.join(dir, `tests/t${i}.json`), JSON.stringify(requiring(`t${i}`, ["send_sms"])));
    await fs.writeFile(
      path.join(dir, "agent.mjs"),
      `export const agent = {
  tools: ${JSON.stringify(tools)},
  run: async () => { globalThis.guardRuns = (globalThis.guardRuns ?? 0) + 1; return { text: "hi there", toolCalls: [] }; },
};\n`,
    );
    await fs.writeFile(
      path.join(dir, "agentdiff.config.mjs"),
      `export default { agent: "agent", agentPath: "agent.mjs", tests: "tests", runsPerTest: 4, concurrency: 1 };\n`,
    );
    process.env.AGENTDIFF_OFFLINE = "1";
    (globalThis as { guardRuns?: number }).guardRuns = 0;
    return path.join(dir, "agentdiff.config.mjs");
  }
  const agentRuns = () => (globalThis as { guardRuns?: number }).guardRuns;

  it("refuses to start when the tests require a tool the agent doesn't have", async () => {
    const config = await project(["lookup"]);
    await assert.rejects(runCheck({ config }), /send_sms: required by 6 tests \(t0, t1, t2, …\)/);
    assert.equal(agentRuns(), 0, "nothing ran");
  });

  it("stops once the required tool is skipped everywhere, then finishes on --resume", async () => {
    const config = await project(["lookup", "send_sms"]);
    const stopped = await runCheck({ config }).catch((err: Error) => err.message);
    assert.match(String(stopped), /^Stopped after 20 runs: 6 tests require send_sms, but 0 of their first 20 runs/);
    const folder = String(stopped).match(/--resume (check-\S+)/)?.[1];
    assert.ok(folder, "says how to finish");
    assert.equal(agentRuns(), 20);

    const { dir, result } = await runCheck({ config, resume: folder });
    assert.equal(agentRuns(), 24, "only the 4 runs it hadn't saved");
    assert.equal((await fs.readdir(path.join(dir, "runs"))).length, 24);
    assert.deepEqual(new Set(result.tests.map((t) => [t.runs, t.status].join(" "))), new Set(["4 rule"]));
  });
});

describe("agentdiff check --trial", () => {
  afterEach(() => {
    delete process.env.AGENTDIFF_OFFLINE;
  });

  it("runs every test once, ungraded, lists the rules broken most, and --resume finishes it", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentdiff-trial-"));
    await fs.mkdir(path.join(dir, "tests"));
    for (let i = 0; i < 6; i++)
      await fs.writeFile(
        path.join(dir, `tests/t${i}.json`),
        JSON.stringify({ ...requiring(`t${i}`, ["send_sms"]), must_not_call_tools: ["lookup"] }),
      );
    await fs.writeFile(
      path.join(dir, "agent.mjs"),
      `export const agent = {
  tools: ["lookup", "send_sms"],
  run: async () => { globalThis.trialRuns = (globalThis.trialRuns ?? 0) + 1; return { text: "hi", toolCalls: [{ tool: "lookup" }] }; },
};\n`,
    );
    const config = path.join(dir, "agentdiff.config.mjs");
    await fs.writeFile(
      config,
      `export default { agent: "agent", agentPath: "agent.mjs", tests: "tests", runsPerTest: 4 };\n`,
    );
    (globalThis as { trialRuns?: number }).trialRuns = 0;

    const trial = await runCheck({ config, trial: true });
    assert.equal((globalThis as { trialRuns?: number }).trialRuns, 6, "once per test, with no grading key needed");
    assert.deepEqual([trial.result.trial, trial.result.graded, trial.result.runsPerTest], [true, false, 1]);
    assert.equal(healthHeadline(trial.result), "0 of 6 tests kept their tool rules · 6 broke one");
    assert.deepEqual(brokenRules(trial.result.tests).map(describeBrokenRule), [
      "send_sms, required: skipped in 6 tests",
      "lookup, forbidden: called in 6 tests",
    ]);
    assert.match(
      await fs.readFile(path.join(trial.dir, "report.md"), "utf8"),
      /## Rules broken most\n\n- send_sms, required/,
    );

    process.env.AGENTDIFF_OFFLINE = "1";
    const full = await runCheck({ config, resume: path.basename(trial.dir) });
    assert.equal(
      (globalThis as { trialRuns?: number }).trialRuns,
      24,
      "the trial's 6 runs kept, 18 more to reach 4 each",
    );
    assert.deepEqual([full.result.trial, full.result.runsPerTest], [undefined, 4]);
  });
});

describe("agentdiff check --resume, already graded", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.OPENAI_API_KEY;
  });

  it("keeps the saved grades and check answers instead of paying for them again", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentdiff-regrade-"));
    await fs.mkdir(path.join(dir, "tests"));
    await fs.writeFile(
      path.join(dir, "tests/t.json"),
      JSON.stringify({ name: "t", input: "hi", grading_criteria: "Says hi." }),
    );
    await fs.writeFile(
      path.join(dir, "agent.mjs"),
      "export const agent = { run: async () => { throw new Error('ran again'); } };\n",
    );
    const config = path.join(dir, "agentdiff.config.mjs");
    await fs.writeFile(
      config,
      `export default { agent: "agent", agentPath: "agent.mjs", tests: "tests", grader: "openai" };\n`,
    );
    const folder = "check-2026-10-12T00-00-00-000";
    const out = path.join(dir, ".agentdiff", folder);
    await fs.mkdir(path.join(out, "runs"), { recursive: true });
    const scores = [5, 4];
    for (const n of [1, 2])
      await fs.writeFile(path.join(out, `runs/t-${n}.json`), JSON.stringify(run([], { test: "t", run: n })));
    await fs.writeFile(
      path.join(out, "grades.json"),
      JSON.stringify(scores.map((score, i) => ({ test: "t", version: "new", run: i + 1, score, reason: "" }))),
    );
    await fs.writeFile(
      path.join(out, "checks.json"),
      JSON.stringify([1, 2].map((n) => ({ test: "t", version: "new", run: n, answers: {} }))),
    );
    process.env.OPENAI_API_KEY = "offline-test-key";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("no model calls expected");
    }) as typeof fetch;

    const { result } = await runCheck({ config, resume: folder });
    assert.equal(calls, 0);
    assert.deepEqual([result.tests[0].score, result.tests[0].status], [4.5, "steady"]);
  });
});

describe("agentdiff's own model calls", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("ask again once after a timeout", async () => {
    process.env.OPENAI_API_KEY = "offline-test-key";
    let calls = 0;
    let timeouts = 1;
    globalThis.fetch = (async () => {
      if (calls++ < timeouts) throw new DOMException("The operation timed out.", "TimeoutError");
      return Response.json({
        id: "x",
        object: "chat.completion",
        created: 1,
        model: "gpt-5.1",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: '{"ok":"yes"}' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }) as typeof fetch;
    const ask = openaiAsk();
    const request = { schema: z.object({ ok: z.string() }), system: "s", prompt: "p" };
    assert.deepEqual(await ask(request), { ok: "yes" });
    assert.equal(calls, 2);
    [calls, timeouts] = [0, 2];
    await assert.rejects(ask(request), /took over 4 minutes to answer, twice/);
    assert.equal(calls, 2, "once more, not more");
  });
});

describe("errors no retry fixes", () => {
  const apiError = (statusCode: number, message: string, responseBody = "") =>
    new APICallError({ message, url: "https://api.openai.com/v1/x", requestBodyValues: {}, statusCode, responseBody });

  it("are an empty account or a refused key, however the SDK wrapped them", () => {
    const quota = apiError(429, "You have no credits remaining.", '{"error":{"code":"insufficient_quota"}}');
    const retried = new RetryError({
      message: "Failed after 4 attempts.",
      reason: "maxRetriesExceeded",
      errors: [quota],
    });
    assert.equal(
      accountError(retried),
      "The model provider's account can't spend more (no credits left, or a spend limit reached): You have no credits remaining.",
    );
    assert.match(
      accountError(new Error("wrapped", { cause: apiError(401, "Incorrect API key") })) ?? "",
      /refused the API key \(401\)/,
    );
    assert.match(
      accountError(apiError(429, "Your organization has reached its configured enforced spend limit.")) ?? "",
      /spend limit reached\): Your organization/,
    );
    assert.equal(accountError(apiError(429, "Rate limit reached for requests")), null, "a rate limit passes");
    assert.equal(accountError(apiError(500, "server error")), null);
  });

  it("stop a batch: nothing after the failure starts", async () => {
    const started: number[] = [];
    await assert.rejects(
      mapLimit([1, 2, 3, 4, 5], 1, async (n) => {
        started.push(n);
        if (n === 2) throw new Error("no credits");
      }),
    );
    assert.deepEqual(started, [1, 2]);
  });
});

describe("agentdiff compare --baseline", () => {
  afterEach(() => {
    delete process.env.AGENTDIFF_OFFLINE;
  });

  it("uses a finished check of the old file as the old side, and runs only the new one", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentdiff-compare-baseline-"));
    await fs.mkdir(path.join(dir, "tests"));
    for (const name of ["a", "b"])
      await fs.writeFile(path.join(dir, `tests/${name}.json`), JSON.stringify({ name, input: "refund order 7" }));
    const agent = (version: string, tools: string) =>
      `export const agent = { instructions: "${version}", tools: ["lookup", "refund"], run: async () => { globalThis.baselineRuns ??= {}; globalThis.baselineRuns.${version} = (globalThis.baselineRuns.${version} ?? 0) + 1; return { text: "ok", toolCalls: ${tools} }; } };\n`;
    await fs.writeFile(path.join(dir, "old.mjs"), agent("old", '[{ tool: "lookup" }, { tool: "refund" }]'));
    await fs.writeFile(path.join(dir, "new.mjs"), agent("new", '[{ tool: "refund" }]'));
    const config = path.join(dir, "agentdiff.config.mjs");
    await fs.writeFile(
      config,
      `export default { agent: "agent", versions: { old: "old.mjs", new: "new.mjs" }, tests: "tests", runsPerTest: 2 };\n`,
    );
    process.env.AGENTDIFF_OFFLINE = "1";
    // A check of versions.old, as compare --baseline needs: check defaults to versions.new.
    const { dir: checked } = await runCheck({ config, file: "old.mjs" });
    const counts = () => (globalThis as { baselineRuns?: Record<string, number> }).baselineRuns ?? {};
    (globalThis as { baselineRuns?: Record<string, number> }).baselineRuns = {};

    const result = await runComparison(undefined, { config, baseline: path.basename(checked) });
    assert.equal(result.skipped, false);
    assert.deepEqual(counts(), { new: 4 }, "the old agent didn't run again");
    if (result.skipped) return;
    assert.equal(
      (await fs.readdir(path.join(result.dir, "old-runs"))).length,
      4,
      "the old side's runs are saved with it",
    );
    assert.equal(result.comparison.baseline, path.basename(checked));
    const oldRun = JSON.parse(await fs.readFile(path.join(result.dir, "old-runs", "a-1.json"), "utf8"));
    assert.equal(oldRun.latency_ms, null, "run time measured earlier isn't compared");
    assert.deepEqual(
      result.comparison.tests.map((t) => [t.test, t.old.runs, t.new.runs]),
      [
        ["a", 2, 2],
        ["b", 2, 2],
      ],
    );
    await assert.rejects(runComparison("main", { config, baseline: path.basename(checked) }), /not a git ref/);
  });
});

describe("test names", () => {
  it("are refused when two tests share one, since runs are matched and saved by name", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentdiff-names-"));
    await fs.mkdir(path.join(dir, "tests"));
    await fs.writeFile(path.join(dir, "tests/a.json"), JSON.stringify({ name: "Refund order!", input: "hi" }));
    await fs.writeFile(path.join(dir, "tests/b.json"), JSON.stringify({ name: "refund order", input: "hello" }));
    await assert.rejects(loadTests(dir, "tests"), /a\.json and b\.json would save their runs under the same file name/);
  });
});

describe("saved grades", () => {
  it("are reused only while the test still says what they were judged against", () => {
    const test: TestFile = { name: "t", input: "hi", grading_criteria: "Says hi." };
    const tools = { lookup: "Find a customer." };
    const grade = (basis?: string) => ({ test: "t", version: "new" as const, run: 1, score: 5, reason: "", basis });
    const check = (basis?: string) => ({ test: "t", version: "new" as const, run: 1, answers: {}, basis });
    const saved = {
      grades: [grade(gradeBasis(test)), grade(gradeBasis({ ...test, grading_criteria: "Says bye." })), grade()],
      checks: [check(checkBasis(test, tools)), check(checkBasis(test, { lookup: "Something else." })), check()],
    };
    const valid = stillValid(saved, [test], tools);
    assert.deepEqual(
      valid.grades.map((g) => g.basis),
      [gradeBasis(test), undefined],
      "the current wording and an old save without a fingerprint stay; the edited criteria's grade goes",
    );
    assert.deepEqual(
      valid.checks.map((c) => c.basis),
      [checkBasis(test, tools), undefined],
      "a check answered against other tool descriptions goes",
    );
    assert.deepEqual(stillValid(saved, [], tools), { grades: [], checks: [] }, "a test that's gone takes its grades");
  });
});
