import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { experimental_evaluate as evaluate } from "ai";
import { decisionStats, recordDecisions } from "../src/agent/decisions.ts";
import { testChanged } from "../src/compare/signals.ts";
import { buildExplainerContext } from "../src/explain/context.ts";
import { decisionRows, decisionShifts } from "../src/compare/check-rows.ts";
import { buildReport } from "../src/report/markdown.ts";
import type { Decision, DecisionStats } from "../src/types.ts";
import { comparison, run, side, test } from "./helpers.ts";

const realFetch = globalThis.fetch;
const env = { ...process.env };
let requests: string[] = [];

// A fake network: Vercel AI Gateway's evaluation endpoint and TypeSafe's API answer; anything else is a plain 200.
beforeEach(() => {
  requests = [];
  process.env.AI_GATEWAY_API_KEY = "test-key";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push(url);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    await new Promise((r) => setTimeout(r, body.delay ?? 0));
    if (url.endsWith("/evaluation-model")) {
      const answers = Object.fromEntries(
        Object.entries(body.questions).map(([id, q]: [string, any]) => [
          id,
          q.type === "boolean"
            ? { type: "boolean", probability: 0.8 }
            : q.type === "choice"
              ? {
                  type: "choice",
                  choice: Object.keys(q.criteria)[1],
                  probabilities: Object.fromEntries(Object.keys(q.criteria).map((k, i) => [k, i === 1 ? 1 : 0])),
                }
              : {
                  type: "score",
                  score: 2,
                  probabilities: Object.fromEntries(
                    q.criteria.map((_: unknown, i: number) => [String(i), i === 2 ? 1 : 0]),
                  ),
                },
        ]),
      );
      return Response.json({ answers, model: "typesafe-ai/jev" });
    }
    if (url === "https://api.typesafe.ai/v1/systemone") {
      return Response.json({
        answers: {
          route: { choice: "refund", probabilities: { billing: 0.1, refund: 0.9 }, confidence: 0.8 },
          risky: { noul: 0.93 },
        },
      });
    }
    return Response.json({ ok: true });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...env };
});

describe("recordDecisions", () => {
  it("records questions and answers the agent gets from Jev through the AI SDK", async () => {
    const { result, decisions } = await recordDecisions(() =>
      evaluate({
        model: "typesafe-ai/jev",
        state: { message: "I want my money back" },
        questions: {
          escalate: { type: "boolean", instructions: "Should a human handle this?" },
          route: { type: "choice", instructions: "Which team?", criteria: { billing: null, refunds: null } },
          urgency: { type: "score", instructions: "How urgent?", criteria: ["low", "medium", "high"] },
        },
      }),
    );
    assert.equal(result.answers.escalate.probability, 0.8, "the agent still receives its answers");
    assert.ok(requests.some((u) => u.endsWith("/evaluation-model")));
    assert.ok(
      decisions.every((d) => typeof d.at_ms === "number"),
      "each question is stamped on the run's clock",
    );
    assert.deepEqual(
      decisions.map(({ at_ms, ...d }) => d),
      [
        {
          id: "escalate",
          type: "boolean",
          instructions: "Should a human handle this?",
          answer: { type: "boolean", probability: 0.8 },
        },
        {
          id: "route",
          type: "choice",
          instructions: "Which team?",
          options: ["billing", "refunds"],
          answer: { type: "choice", choice: "refunds" },
        },
        { id: "urgency", type: "score", instructions: "How urgent?", answer: { type: "score", score: 2 } },
      ],
    );
  });

  it("reads TypeSafe's own API shape too", async () => {
    const { decisions } = await recordDecisions(async () => {
      const res = await fetch("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        body: JSON.stringify({
          model: "jev-latest",
          state: "x",
          questions: {
            route: { type: "choice", instructions: "Which team?", criteria: { billing: "Billing", refund: "Refunds" } },
            risky: { type: "noul", instructions: "Is this risky?" },
          },
        }),
      });
      return res.json();
    });
    assert.deepEqual(
      decisions.map((d) => [d.id, d.type, d.options, d.answer]),
      [
        ["route", "choice", ["billing", "refund"], { type: "choice", choice: "refund" }],
        ["risky", "boolean", undefined, { type: "boolean", probability: 0.93 }],
      ],
    );
  });

  it("keeps concurrent runs apart and ignores calls outside a run or to other hosts", async () => {
    const ask = (id: string, delay: number) =>
      fetch("https://ai-gateway.vercel.sh/v3/ai/evaluation-model", {
        method: "POST",
        body: JSON.stringify({ delay, questions: { [id]: { type: "boolean", instructions: id } } }),
      });
    const [a, b] = await Promise.all([
      recordDecisions(async () => {
        await ask("first", 20);
        await fetch("https://example.com/data");
      }),
      recordDecisions(async () => {
        await ask("second", 5);
      }),
    ]);
    await ask("outside", 0);
    assert.deepEqual(
      a.decisions.map((d) => d.id),
      ["first"],
    );
    assert.deepEqual(
      b.decisions.map((d) => d.id),
      ["second"],
    );
  });
});

const yesNo = (id: string, p: number, instructions = "Escalate?"): Decision => ({
  id,
  type: "boolean",
  instructions,
  answer: { type: "boolean", probability: p },
});

describe("decisionStats", () => {
  it("tallies asks, runs asking, and answers per question over finished runs", () => {
    const stats = decisionStats([
      run([], { run: 1, decisions: [yesNo("escalate", 0.9), yesNo("escalate", 0.2)] }),
      run([], { run: 2, decisions: [yesNo("escalate", 0.7)] }),
      run([], { run: 3 }),
      run([], { run: 4, error: "boom", final_response: null, decisions: [yesNo("escalate", 0.9)] }),
    ]);
    assert.deepEqual(stats?.escalate, {
      type: "boolean",
      instructions: "Escalate?",
      runs: 3,
      runsAsking: 2,
      asks: 3,
      yes: 2,
    });
    assert.equal(decisionStats([run([])]), undefined);
  });
});

describe("decision shifts", () => {
  const stats = (over: Partial<DecisionStats>): DecisionStats => ({
    type: "boolean",
    instructions: "Escalate?",
    runs: 5,
    runsAsking: 5,
    asks: 5,
    yes: 1,
    ...over,
  });

  it("flags answers that moved and reports rewording as the likely cause", () => {
    const t = test({
      old: side({}, { decisions: { escalate: stats({}) } }),
      new: side({}, { decisions: { escalate: stats({ yes: 4, instructions: "Escalate if anything seems off?" }) } }),
    });
    const [r] = decisionRows(t);
    assert.deepEqual(
      [r.asked, r.answer, r.shifted],
      [{ old: "5/5", new: "5/5" }, { old: "yes 1/5", new: "yes 4/5" }, true],
    );
    assert.deepEqual(r.reworded, { old: "Escalate?", new: "Escalate if anything seems off?" });
    assert.equal(testChanged(t), true);
  });

  it("flags a question that stopped being asked, and ignores rewording alone", () => {
    const gone = test({ old: side({}, { decisions: { fraud_gate: stats({}) } }), new: side({}) });
    assert.deepEqual(decisionRows(gone)[0].answer, { old: "yes 1/5", new: "not asked" });
    assert.equal(decisionShifts(gone).length, 1);

    const reworded = test({
      old: side({}, { decisions: { escalate: stats({}) } }),
      new: side({}, { decisions: { escalate: stats({ instructions: "Escalate now?" }) } }),
    });
    assert.equal(decisionShifts(reworded).length, 0);
    assert.equal(testChanged(reworded), false);
  });

  it("compares choices by the option that moved, and scores by a full level", () => {
    const choice = (refund: number): DecisionStats => ({
      type: "choice",
      instructions: "Team?",
      runs: 5,
      runsAsking: 5,
      asks: 5,
      counts: { refund, billing: 5 - refund },
    });
    const t = test({
      old: side({}, { decisions: { route: choice(1) } }),
      new: side({}, { decisions: { route: choice(4) } }),
    });
    assert.deepEqual(decisionRows(t)[0].answer, { old: "refund 1/5", new: "refund 4/5" });

    const score = (meanScore: number): DecisionStats => ({
      type: "score",
      instructions: "Urgency?",
      runs: 5,
      runsAsking: 5,
      asks: 5,
      meanScore,
    });
    assert.equal(
      decisionShifts(
        test({ old: side({}, { decisions: { u: score(1.2) } }), new: side({}, { decisions: { u: score(1.9) } }) }),
      ).length,
      0,
    );
    assert.equal(
      decisionShifts(
        test({ old: side({}, { decisions: { u: score(1.2) } }), new: side({}, { decisions: { u: score(2.4) } }) }),
      ).length,
      1,
    );
  });

  it("appears in the report, with reworded questions, and in the explainer context", () => {
    const t = test({
      old: side({}, { decisions: { escalate: stats({}) } }),
      new: side({}, { decisions: { escalate: stats({ yes: 4, instructions: "Escalate if anything seems off?" }) } }),
    });
    const c = comparison({ tests: [t] });
    const report = buildReport(c, "");
    assert.match(report, /#### Checks the agent ran/);
    assert.match(report, /\| refund \| `escalate` \| 5\/5 → 5\/5 \| yes 1\/5 → \*\*yes 4\/5\*\* \| reworded \|/);
    assert.match(report, /`escalate`: “Escalate\?” → “Escalate if anything seems off\?”/);
    const context = buildExplainerContext(c);
    assert.match(
      context,
      /Jev decision "escalate": asked in 5\/5 -> 5\/5 runs; answers yes 1\/5 -> yes 4\/5 \(changed\)/,
    );
    assert.match(context, /reworded: "Escalate\?" -> "Escalate if anything seems off\?"/);
  });

  it("lists a question reworded the same way in several tests once, and bolds only what moved", () => {
    const asked = (name: string, yes: number) =>
      test({
        test: name,
        old: side({}, { decisions: { escalate: stats({}) } }),
        new: side({}, { decisions: { escalate: stats({ yes, instructions: "Escalate now?" }) } }),
      });
    const report = buildReport(comparison({ tests: [asked("refund", 4), asked("cancel", 1)] }), "");
    assert.match(report, /Reworded questions · 1</);
    assert.equal(report.match(/`escalate`: “Escalate\?” → “Escalate now\?”/g)?.length, 1);
    assert.match(report, /\| cancel \| `escalate` \| 5\/5 → 5\/5 \| yes 1\/5 → yes 1\/5 \| reworded \|/);
  });
});
