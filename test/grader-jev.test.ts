import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { gradeRecords, jevGrade } from "../src/grade/grader.ts";
import { graderKind, missingKeys } from "../src/lib/llm.ts";
import { NO_FINAL_TEXT, NO_REPLY_TEXT, type TestFile } from "../src/types.ts";
import { run } from "./helpers.ts";

type Call = { state: any; questions: any };

// A stand-in for Jev behind AI Gateway: records each call and answers from `answer`.
function fakeJev(answer: (call: Call) => { score: number; probabilities?: Record<string, number> } | Error) {
  const calls: Call[] = [];
  const model = {
    specificationVersion: "v4" as const,
    provider: "test",
    modelId: "jev",
    supportedQuestionTypes: ["score"] as const,
    async doEvaluate(options: Call) {
      calls.push(options);
      const a = answer(options);
      if (a instanceof Error) throw a;
      return { answers: { grade: { type: "score" as const, ...a } }, warnings: [] };
    },
  };
  return { model, calls };
}

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

describe("jevGrade", () => {
  it("reads Jev's 0-based expected level from the distribution", () => {
    // TypeSafe's documented example: 57% on level 1, 43% on level 2 → 1.43.
    const g = jevGrade({ score: 1.43, probabilities: { "0": 0, "1": 0.57, "2": 0.43 } });
    assert.equal(g.score, 2.43);
    assert.match(g.reason, /meets little of the criteria \(2\/5, 57% likely\)/);
  });

  it("falls back to the score and keeps grades within 1–5", () => {
    assert.equal(jevGrade({ score: 3 }).score, 4);
    assert.equal(jevGrade({ score: 9 }).score, 5);
    assert.equal(jevGrade({ score: -2 }).score, 1);
    assert.equal(jevGrade({ score: 2, probabilities: { high: 1 } }).score, 3);
  });
});

describe("gradeRecords with AGENTDIFF_GRADER=jev", () => {
  const tests = [
    { name: "refund", input: "Refund order 4471", grading_criteria: "Verifies the customer before refunding." },
    { name: "chat", input: "Hi" },
  ];

  it("asks one five-level score question per run and maps the answers", async () => {
    process.env.AGENTDIFF_GRADER = "jev";
    // The SDK requires a probability for every level, as Jev returns.
    const { model, calls } = fakeJev(() => ({
      score: 3.2,
      probabilities: { "0": 0, "1": 0, "2": 0, "3": 0.8, "4": 0.2 },
    }));
    const records = [
      run(["lookup_customer", "refund_customer"], {
        test: "refund",
        version: "old",
        run: 1,
        final_response: "Refunded after checking.",
      }),
      run(["refund_customer"], { test: "refund", version: "new", run: 1, final_response: "Refunded." }),
      run([], { test: "chat", version: "old", run: 1, final_response: "Hello!" }),
    ];
    const grades = await gradeRecords(records, tests, { jevModel: model });

    assert.equal(calls.length, 2, "the test without criteria is not graded");
    const q = calls[0].questions.grade;
    assert.equal(q.type, "score");
    assert.equal(q.criteria.length, 5);
    assert.deepEqual(Object.keys(calls[0].state).sort(), ["criteria", "input", "response", "tool_calls"]);
    assert.deepEqual(
      calls[0].state.tool_calls.map((c: { tool: string }) => c.tool),
      ["lookup_customer", "refund_customer"],
      "the grader sees what the agent did, not only what it said",
    );
    assert.equal(calls[0].state.criteria, "Verifies the customer before refunding.");
    assert.deepEqual(
      grades.map((g) => [g.test, g.version, g.score]),
      [
        ["refund", "old", 4.2],
        ["refund", "new", 4.2],
      ],
    );
    assert.match(grades[0].reason, /^Jev: meets most of the criteria \(4\/5, 80% likely\)\.$/);
  });

  it("grades a run that said nothing, with the earlier messages in the input", async () => {
    process.env.AGENTDIFF_GRADER = "jev";
    const { model, calls } = fakeJev(() => ({ score: 4 }));
    const thumbs: TestFile = {
      name: "thumbs up",
      input: "👍",
      grading_criteria: "A thumbs-up after a confirmation needs no reply.",
      conversation: [
        { role: "user", content: "Book it" },
        { role: "assistant", content: "Booked." },
      ],
    };
    const grades = await gradeRecords(
      [run([], { test: "thumbs up", version: "new", run: 1, final_response: null })],
      [thumbs],
      { jevModel: model },
    );
    assert.equal(grades.length, 1, "a silent run is graded, not skipped");
    assert.equal(calls[0].state.input, "user: Book it\nassistant: Booked.\nuser (new message): 👍");
    assert.equal(calls[0].state.response, NO_REPLY_TEXT);
  });

  it("grades a message sent through a tool, not only the final text", async () => {
    process.env.AGENTDIFF_GRADER = "jev";
    const { model, calls } = fakeJev(() => ({ score: 5 }));
    const sms: TestFile = { name: "sms", input: "can I apply?", grading_criteria: "Texts back how to apply." };
    const send = { tool: "send_sms", input: { body: "Yes! Here's the link to apply." }, output: { sent: true } };
    await gradeRecords([run([], { test: "sms", tool_calls: [send], final_response: null })], [sms], {
      jevModel: model,
    });
    assert.deepEqual(calls[0].state.tool_calls, [
      { tool: "send_sms", input: JSON.stringify(send.input), output: JSON.stringify(send.output) },
    ]);
    assert.equal(calls[0].state.response, NO_FINAL_TEXT, "a run that replied through a tool isn't called silent");
  });

  it("records a failed call as a grader error, like the OpenAI grader", async () => {
    process.env.AGENTDIFF_GRADER = "jev";
    const { model } = fakeJev(() => new Error("rate limited"));
    const [g] = await gradeRecords(
      [run([], { test: "refund", version: "new", run: 1, final_response: "Done." })],
      tests,
      { jevModel: model },
    );
    assert.equal(g.score, 1);
    assert.match(g.reason, /^grader error: .*rate limited/);
  });

  it("skips grading when no AI Gateway key is set", async () => {
    process.env.AGENTDIFF_GRADER = "jev";
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_OIDC_TOKEN;
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    assert.deepEqual(await gradeRecords([run([], { test: "refund", final_response: "Done." })], tests, { warn }), []);
    assert.match(warnings.join("\n"), /AI_GATEWAY_API_KEY/);
  });
});

describe("choosing the grader", () => {
  it("uses AGENTDIFF_GRADER, then the config, then Jev", () => {
    delete process.env.AGENTDIFF_GRADER;
    assert.equal(graderKind(), "jev");
    assert.equal(graderKind("openai"), "openai");
    process.env.AGENTDIFF_GRADER = "jev";
    assert.equal(graderKind("openai"), "jev");
    process.env.AGENTDIFF_GRADER = "something else";
    assert.equal(graderKind("openai"), "openai", "an unknown value is ignored");
  });

  it("names each missing key and what it is for", () => {
    for (const k of ["OPENAI_API_KEY", "AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN"]) delete process.env[k];
    assert.deepEqual(
      missingKeys("jev").map((m) => m.key),
      ["OPENAI_API_KEY", "AI_GATEWAY_API_KEY"],
    );
    assert.deepEqual(missingKeys("openai"), [
      { key: "OPENAI_API_KEY", for: "grading, checks, discovery planning and the explanation" },
    ]);
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.AI_GATEWAY_API_KEY = "gw-test";
    assert.deepEqual(missingKeys("jev"), []);
  });
});
