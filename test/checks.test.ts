import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkStats, evaluateChecks } from "../src/grade/checks.ts";
import { testChanged } from "../src/compare/signals.ts";
import { buildExplainerContext } from "../src/explain/context.ts";
import { checkRows, checkShifts, shownCheckRows } from "../src/compare/check-rows.ts";
import { buildReport } from "../src/report/markdown.ts";
import { TestFileSchema, type CheckResult, type TestFile } from "../src/types.ts";
import { comparison, run, side, test } from "./helpers.ts";

const refund: TestFile = {
  name: "refund",
  input: "Refund order 4471",
  grading_criteria: "Verify the customer before refunding.",
  checks: {
    verified_first: "Did the agent verify the customer before refunding?",
    outcome: { question: "What did the agent do?", options: ["refunded", "escalated"] },
  },
};

// A stand-in for Jev: "verified" when lookup_customer ran; "refunded" when refund_customer did.
function fakeJev(fail = false) {
  const calls: { state: any; questions: any }[] = [];
  const model = {
    specificationVersion: "v4" as const,
    provider: "test",
    modelId: "jev",
    supportedQuestionTypes: ["boolean", "choice"] as const,
    async doEvaluate(options: { state: any; questions: any }) {
      calls.push(options);
      if (fail) throw new Error("gateway down");
      const tools = options.state.tool_calls.map((c: any) => c.tool);
      const refunded = tools.includes("refund_customer");
      const verified = tools.includes("lookup_customer");
      const all = {
        verified_first: { type: "boolean" as const, probability: verified ? 0.9 : 0.1 },
        outcome: {
          type: "choice" as const,
          choice: refunded ? "refunded" : "escalated",
          probabilities: refunded ? { refunded: 0.8, escalated: 0.2 } : { refunded: 0.1, escalated: 0.9 },
        },
        failure_type: { type: "choice" as const, choice: refunded && !verified ? "skipped_step" : "none" },
        acted_before_check: { type: "boolean" as const, probability: refunded && !verified ? 0.85 : 0.05 },
      };
      // Answer exactly the questions asked, like the gateway.
      return {
        answers: Object.fromEntries(Object.keys(options.questions).map((id) => [id, all[id as keyof typeof all]])),
        warnings: [],
      };
    },
  };
  return { model, calls };
}

// A stand-in for an OpenAI model answering the same checks as one JSON object.
function fakeOpenAI(answer: Record<string, unknown>) {
  const calls: any[] = [];
  const model = {
    specificationVersion: "v2" as const,
    provider: "test",
    modelId: "gpt-test",
    supportedUrls: {},
    async doGenerate(options: any) {
      calls.push(options);
      return {
        content: [{ type: "text", text: JSON.stringify(answer) }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
    async doStream(): Promise<never> {
      throw new Error("not streamed");
    },
  };
  return { model: model as any, calls };
}

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

describe("evaluateChecks", () => {
  it("asks OpenAI the same questions in one structured call when it is the grader", async () => {
    const { model, calls } = fakeOpenAI({
      verified_first: false,
      outcome: "refunded",
      failure_type: "skipped_step",
      acted_before_check: true,
    });
    const records = [run(["refund_customer"], { test: "refund", version: "new", run: 1 })];
    const [result] = await evaluateChecks(records, [refund], {
      grader: "openai",
      openaiModel: model,
      writeTools: ["refund_customer"],
    });
    assert.equal(calls.length, 1);
    const schema = calls[0].responseFormat.schema;
    assert.deepEqual(Object.keys(schema.properties).sort(), [
      "acted_before_check",
      "failure_type",
      "outcome",
      "verified_first",
    ]);
    assert.equal(schema.properties.verified_first.type, "boolean");
    assert.deepEqual(schema.properties.outcome.enum, ["refunded", "escalated"]);
    assert.ok(schema.properties.failure_type.enum.includes("unwanted_reply"));
    assert.match(
      schema.properties.failure_type.description,
      /unwanted_reply: It replied when the input needed no reply/,
    );
    assert.match(JSON.stringify(calls[0].prompt), /write_tools/);
    assert.deepEqual(result.answers, {
      verified_first: { type: "yes_no", probability: 0 },
      outcome: { type: "choice", choice: "refunded", probabilities: { refunded: 1 } },
      failure_type: { type: "choice", choice: "skipped_step", probabilities: { skipped_step: 1 } },
      acted_before_check: { type: "yes_no", probability: 1 },
    });
  });

  it("asks each run's checks in one call and records the answers", async () => {
    const { model, calls } = fakeJev();
    const records = [
      run(["lookup_customer", "refund_customer"], { test: "refund", version: "old", run: 1 }),
      run(["refund_customer"], { test: "refund", version: "new", run: 1 }),
      run([], { test: "refund", version: "new", run: 2, error: "timeout", final_response: null }),
      run(["lookup_customer"], { test: "other", version: "new", run: 1 }),
    ];
    const results = await evaluateChecks(records, [refund, { name: "other", input: "hi" }], {
      jevModel: model,
      tools: { refund_customer: "Issue a refund." },
    });

    assert.equal(
      calls.length,
      3,
      "errored runs are skipped; a test without checks of its own still gets the built-in ones",
    );
    assert.deepEqual(Object.keys(calls[2].questions), ["failure_type", "acted_before_check"]);
    assert.equal(calls[0].questions.failure_type.type, "choice");
    assert.ok(
      "skipped_step" in calls[0].questions.failure_type.criteria && "none" in calls[0].questions.failure_type.criteria,
    );
    assert.equal(calls[0].questions.acted_before_check.type, "boolean");
    assert.equal(calls[0].state.expectations, "Verify the customer before refunding.");
    assert.equal(calls[2].state.expectations, undefined, "no grading criteria, no expectations");
    assert.deepEqual(calls[0].state.tools, { refund_customer: "Issue a refund." });
    assert.equal(calls[0].questions.verified_first.type, "boolean");
    assert.equal(calls[0].questions.outcome.type, "choice");
    assert.deepEqual(Object.keys(calls[0].questions.outcome.criteria), ["refunded", "escalated"]);
    assert.deepEqual(
      calls[0].state.tool_calls.map((c: any) => c.tool),
      ["lookup_customer", "refund_customer"],
    );
    assert.deepEqual(
      results
        .filter((r) => r.test === "refund")
        .map((r) => [
          r.version,
          r.answers.verified_first,
          (r.answers.outcome as any).choice,
          (r.answers.failure_type as any).choice,
        ]),
      [
        ["old", { type: "yes_no", probability: 0.9 }, "refunded", "none"],
        ["new", { type: "yes_no", probability: 0.1 }, "refunded", "skipped_step"],
      ],
    );
    assert.deepEqual(results.find((r) => r.test === "other")?.answers.acted_before_check, {
      type: "yes_no",
      probability: 0.05,
    });
  });

  it("keeps a failed call as an error instead of an answer", async () => {
    const [r] = await evaluateChecks([run([], { test: "refund" })], [refund], { jevModel: fakeJev(true).model });
    assert.deepEqual(r.answers, {});
    assert.match(r.error ?? "", /gateway down/);
  });

  it("skips checks when no AI Gateway key is set", async () => {
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_OIDC_TOKEN;
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    assert.deepEqual(await evaluateChecks([run([], { test: "refund" })], [refund], { warn }), []);
    assert.match(warnings.join("\n"), /AI_GATEWAY_API_KEY/);
  });
});

describe("checkStats", () => {
  it("counts yes answers and picks per option, ignoring failed runs", () => {
    const r = (run: number, p: number, choice: string, error?: string): CheckResult => ({
      test: "refund",
      version: "new",
      run,
      error,
      answers: error
        ? {}
        : {
            verified_first: { type: "yes_no", probability: p },
            outcome: { type: "choice", choice, probabilities: {} },
          },
    });
    const stats = checkStats(refund, "new", [
      r(1, 0.9, "refunded"),
      r(2, 0.4, "refunded"),
      r(3, 0.5, "escalated"),
      r(4, 0, "", "boom"),
    ]);
    assert.deepEqual(stats?.verified_first, {
      question: "Did the agent verify the customer before refunding?",
      kind: "yes_no",
      yes: 2,
      of: 3,
    });
    assert.deepEqual(stats?.outcome, {
      question: "What did the agent do?",
      kind: "choice",
      options: ["refunded", "escalated"],
      counts: { refunded: 2, escalated: 1 },
      of: 3,
    });
    assert.equal(checkStats(refund, "old", []), undefined);
    assert.equal(
      stats?.failure_type,
      undefined,
      "runs saved before the built-in checks existed have no answers for them",
    );
  });

  it("tallies the built-in checks for a test without checks of its own", () => {
    const r = (run: number, failure: string, acted: number): CheckResult => ({
      test: "other",
      version: "new",
      run,
      answers: {
        failure_type: { type: "choice", choice: failure, probabilities: {} },
        acted_before_check: { type: "yes_no", probability: acted },
      },
    });
    const stats = checkStats({ name: "other", input: "hi" }, "new", [r(1, "none", 0.1), r(2, "wrong_order", 0.9)]);
    assert.equal(stats?.failure_type.kind, "choice");
    assert.deepEqual(
      stats?.failure_type.kind === "choice" && [
        stats.failure_type.counts.none,
        stats.failure_type.counts.wrong_order,
        stats.failure_type.of,
      ],
      [1, 1, 2],
    );
    assert.deepEqual(stats?.acted_before_check, {
      question: stats?.acted_before_check.question,
      kind: "yes_no",
      yes: 1,
      of: 2,
    });
  });

  it("won't let a test reuse a built-in check id", () => {
    const parsed = TestFileSchema.safeParse({ name: "t", input: "hi", checks: { failure_type: "Did it fail?" } });
    assert.equal(parsed.success, false);
    assert.match(JSON.stringify(parsed.error?.issues), /built-in checks/);
  });
});

describe("check shifts", () => {
  const yesNo = (yes: number) => ({ question: "Verified first?", kind: "yes_no" as const, yes, of: 5 });
  const choice = (refunded: number) => ({
    question: "Outcome?",
    kind: "choice" as const,
    options: ["refunded", "escalated"],
    counts: { refunded, escalated: 5 - refunded },
    of: 5,
  });

  it("flags a move of 20+ points of runs and shows the option that moved", () => {
    const t = test({
      old: side({}, { checks: { verified_first: yesNo(5), outcome: choice(1) } }),
      new: side({}, { checks: { verified_first: yesNo(1), outcome: choice(4) } }),
    });
    assert.deepEqual(
      checkRows(t).map((r) => [r.id, r.old, r.new, r.shifted]),
      [
        ["verified_first", "5/5", "1/5", true],
        ["outcome", "refunded 1/5", "refunded 4/5", true],
      ],
    );
    assert.equal(testChanged(t), true);
  });

  it("treats a one-run wobble as unchanged and shows the most common option", () => {
    const t = test({
      old: side({}, { checks: { verified_first: yesNo(5), outcome: choice(1) } }),
      new: side({}, { checks: { verified_first: yesNo(5), outcome: choice(1) } }),
    });
    assert.deepEqual(checkShifts(t), []);
    assert.equal(checkRows(t)[1].new, "escalated 4/5");
    assert.equal(testChanged(t), false);
  });

  it("shows built-in checks only when they move, naming the failure that grew", () => {
    const failures = (none: number, skipped: number) => ({
      question: "What went wrong?",
      kind: "choice" as const,
      options: ["none", "skipped_step", "wrong_order"],
      counts: { none, skipped_step: skipped, wrong_order: 0 },
      of: 5,
    });
    const acted = (yes: number) => ({ question: "Acted before the check?", kind: "yes_no" as const, yes, of: 5 });
    const moved = test({
      old: side({}, { checks: { failure_type: failures(5, 0), acted_before_check: acted(0) } }),
      new: side({}, { checks: { failure_type: failures(2, 3), acted_before_check: acted(0) } }),
    });
    assert.deepEqual(
      shownCheckRows(moved).map((r) => [r.id, r.old, r.new, r.builtIn]),
      [["failure_type", "skipped_step 0/5", "skipped_step 3/5", true]],
    );
    assert.equal(testChanged(moved), true);
    const report = buildReport(comparison({ tests: [moved] }), "");
    assert.match(report, /`failure_type` skipped_step 0\/5 → \*\*skipped_step 3\/5\*\*/);
    assert.doesNotMatch(report, /`acted_before_check` 0\/5/, "unchanged built-in checks stay out of the table");
    assert.match(
      buildExplainerContext(comparison({ tests: [moved] })),
      /outcome check "What went wrong\?": skipped_step 0\/5 runs -> skipped_step 3\/5 runs \(changed\)/,
    );

    const fixed = test({
      old: side({}, { checks: { failure_type: failures(2, 3) } }),
      new: side({}, { checks: { failure_type: failures(5, 0) } }),
    });
    assert.deepEqual(
      shownCheckRows(fixed).map((r) => [r.old, r.new]),
      [["skipped_step 3/5", "skipped_step 0/5"]],
      "a failure that went away is named, not none",
    );

    const still = test({
      old: side({}, { checks: { failure_type: failures(5, 0) } }),
      new: side({}, { checks: { failure_type: failures(5, 0) } }),
    });
    assert.deepEqual(shownCheckRows(still), []);
    assert.doesNotMatch(buildReport(comparison({ tests: [still] }), ""), /outcome checks/);
  });

  it("appears in the report table, its legend and the explainer context", () => {
    const t = test({
      mustCallTools: ["lookup_customer"],
      old: side({ lookup_customer: 5 }, { checks: { verified_first: yesNo(5) } }),
      new: side({ lookup_customer: 5 }, { checks: { verified_first: yesNo(1) } }),
    });
    const c = comparison({ tests: [t] });
    const report = buildReport(c, "");
    assert.match(report, /\| outcome checks \|/);
    assert.match(report, /`verified_first` 5\/5 → \*\*1\/5\*\*/);
    assert.match(report, /outcome checks: runs answering yes/);
    assert.match(
      buildExplainerContext(c),
      /outcome check "Verified first\?": 5\/5 runs answered yes -> 1\/5 runs answered yes \(changed\)/,
    );
  });
});
