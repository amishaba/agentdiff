// Scenario drafting: plan what a suite has to cover from the prompt and tools,
// write scenarios with made-up tool answers, and run them without real tools.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promptRules } from "../src/agent/rules.ts";
import { ScriptedSession } from "../src/agent/scripted.ts";
import { runOnce } from "../src/agent/execute.ts";
import { importAgent } from "../src/agent/load.ts";
import { completePlan, planCoverage, ruleItems, type PlannedItem } from "../src/scenarios/plan.ts";
import { scenariosForItem, toTestFile, type WrittenScenario } from "../src/scenarios/scenario.ts";
import { coverageReport, scenariosHeadline } from "../src/scenarios/report.ts";
import { agentBrief, type AgentBrief, type AskModel } from "../src/scenarios/model.ts";
import type { CoverageItem, ScenarioResult } from "../src/scenarios/types.ts";
import { APICallError } from "ai";
import { draftScenarios } from "../src/pipeline/scenarios.ts";
import { loadTests } from "../src/suite/load.ts";
import type { TestFile } from "../src/types.ts";

const RULES = "Be brief.\nREFUNDS: call lookup_customer first. Never refund twice.";
const BRIEF: AgentBrief = {
  name: "support",
  instructions: RULES,
  tools: { lookup_customer: { description: "Find a customer." }, refund: { description: "Refund an order." } },
  guardrails: [],
};
const TOOLS = Object.keys(BRIEF.tools);

/** A fake model: answers each call with whatever `answer` returns for its system prompt. */
const fakeAsk = (answer: (system: string, prompt: string) => unknown): AskModel =>
  (async ({ system, prompt }) => answer(system, prompt)) as AskModel;

const planned = (over: Partial<PlannedItem>): PlannedItem => ({
  area: "job",
  title: "refund an order",
  focus: "Refunds after looking the customer up.",
  rule: null,
  tools: ["refund"],
  ...over,
});

const written = (over: Partial<WrittenScenario> = {}): WrittenScenario => ({
  name: "refund after a declined card",
  conversation: [
    { role: "user", content: "hi" },
    { role: "assistant", content: "Hi! What can I do for you?" },
  ],
  contextJson: '{"customer":"C-7"}',
  input: "refund order 7 please",
  toolResponses: [
    { tool: "lookup_customer", outputsJson: '{"verified":true}' },
    { tool: "refund", outputsJson: '[{"status":"declined"},{"status":"refunded"}]' },
  ],
  mustCallTools: ["lookup_customer", "refund"],
  mustNotCallTools: [],
  gradingCriteria: "Tells the customer the first refund was declined, then confirms the second.",
  checks: [{ id: "looked up first", question: "Did it look the customer up before refunding?" }],
  ...over,
});

describe("the writer's brief", () => {
  it("names the tools that only read, when the config says which tools change things", () => {
    const snapshot = { name: "support", instructions: RULES, model: "m", tools: TOOLS, workflows: [], settings: {} };
    assert.deepEqual(agentBrief(snapshot, ["refund"]).readOnlyTools, ["lookup_customer"]);
    assert.equal(agentBrief(snapshot).readOnlyTools, undefined, "unknown without writeTools");
  });
});

describe("prompt rules", () => {
  it("lists each rule sentence once, without topic labels or plain sentences", () => {
    assert.deepEqual(promptRules(`${RULES}\nNever refund twice.`), [
      "call lookup_customer first.",
      "Never refund twice.",
    ]);
  });
});

describe("coverage plan", () => {
  it("titles rule items as they read, without list markers or markdown, and once each", () => {
    assert.deepEqual(
      ruleItems([
        "2. **NEVER refer to tool names when speaking to the USER.**",
        "- **opt-out**: Opt the lead out. Never call both.",
        "- Document receipt (ALWAYS reply):",
        "**NEVER refer to tool names when speaking to the USER.**",
      ]).map((i) => i.title),
      [
        "NEVER refer to tool names when speaking to the USER.",
        "Opt the lead out. Never call both.",
        "Document receipt (ALWAYS reply):",
      ],
    );
  });

  it("gives every rule sentence its own item, adds the model's other items in area order, and drops repeats", () => {
    const plan = completePlan(
      [
        planned({ area: "adversarial", title: "someone claiming to be staff", tools: [] }),
        planned({}),
        planned({ title: "  " }),
        planned({ title: "Refund an order." }),
        // Already a rule sentence: the rule's own item covers it.
        planned({ area: "rule", title: "look up first", rule: "call lookup_customer first" }),
        planned({ area: "rule", title: "polite", rule: "Stay polite." }),
      ],
      promptRules(RULES),
    );
    assert.deepEqual(
      plan.map((i) => [i.id, i.area, i.title, i.rule ?? null]),
      [
        ["c01", "job", "refund an order", null],
        ["c02", "rule", "call lookup_customer first.", "call lookup_customer first."],
        ["c03", "rule", "Never refund twice.", "Never refund twice."],
        ["c04", "rule", "polite", "Stay polite."],
        ["c05", "adversarial", "someone claiming to be staff", null],
      ],
    );
  });

  it("tells the planner which rules are covered, and returns only what else to cover", async () => {
    let seen: { rules: string[]; agent: AgentBrief } | undefined;
    const rules = promptRules(RULES);
    const items = await planCoverage(
      fakeAsk((_, prompt) => {
        seen = JSON.parse(prompt);
        return { items: [planned({}), planned({ area: "rule", title: "x", rule: "Never refund twice." })] };
      }),
      BRIEF,
      rules,
    );
    assert.deepEqual(seen?.rules, ["call lookup_customer first.", "Never refund twice."]);
    assert.deepEqual(Object.keys(seen!.agent.tools), TOOLS);
    assert.deepEqual(
      items.map((i) => i.title),
      ["refund an order"],
    );
  });
});

describe("written scenarios", () => {
  it("become test files with the conversation, the situation and a response for every tool", () => {
    const test = toTestFile(written(), TOOLS) as TestFile;
    assert.deepEqual(test.conversation?.length, 2);
    assert.deepEqual(test.context, { customer: "C-7" });
    assert.deepEqual(test.tool_responses, {
      lookup_customer: [{ verified: true }],
      refund: [{ status: "declined" }, { status: "refunded" }],
    });
    assert.deepEqual(test.checks, { looked_up_first: "Did it look the customer up before refunding?" });
  });

  it("answer a forbidden tool, so calling it is a broken rule rather than a stopped run", () => {
    const test = toTestFile(
      written({
        mustCallTools: ["lookup_customer"],
        mustNotCallTools: [{ tool: "refund", why: "the customer only asked about the order" }],
        toolResponses: [written().toolResponses[0]],
      }),
      TOOLS,
    ) as TestFile;
    assert.deepEqual(test.must_not_call_tools, ["refund"]);
    assert.deepEqual(test.tool_responses?.refund, [{ ok: true }]);
  });

  it("keep a tool answer that isn't JSON as the plain text it is", () => {
    const test = toTestFile(
      written({ toolResponses: [{ tool: "refund", outputsJson: " Refund issued for order 7 " }] }),
      TOOLS,
    ) as TestFile;
    assert.deepEqual(test.tool_responses?.refund, ["Refund issued for order 7"]);
  });

  it("leave a tool allowed when the writer forbade it without a reason", () => {
    const test = toTestFile(
      written({ mustCallTools: [], mustNotCallTools: [{ tool: "lookup_customer", why: " " }] }),
      TOOLS,
    ) as TestFile;
    assert.equal(test.must_not_call_tools, undefined);
  });

  it("are dropped, with the reason, when they can't run as written", () => {
    const reasons = [
      written({ contextJson: "[1]" }),
      written({ mustNotCallTools: [{ tool: "refund", why: "twice" }] }),
      written({ toolResponses: [{ tool: "send_email", outputsJson: "{}" }] }),
      written({ checks: [{ id: "failure_type", question: "?" }], input: " " }),
    ].map((s) => toTestFile(s, TOOLS));
    assert.deepEqual(reasons, [
      "its context isn't a JSON object",
      "refund is both required and forbidden",
      "the agent has no tool send_email",
      "it has no message",
    ]);
  });

  it("answer every tool the scenario left out or left empty with a plain success, so a call to it isn't a stopped run", () => {
    const test = toTestFile(
      written({ toolResponses: [{ tool: "lookup_customer", outputsJson: "[]" }], mustCallTools: ["refund"] }),
      TOOLS,
    ) as TestFile;
    assert.deepEqual(test.tool_responses, { lookup_customer: [{ ok: true }], refund: [{ ok: true }] });
  });

  it("join a tool listed twice into one list of answers, in call order", () => {
    const test = toTestFile(
      written({
        toolResponses: [
          { tool: "refund", outputsJson: '{"status":"declined"}' },
          { tool: "refund", outputsJson: '[{"status":"refunded"}]' },
        ],
      }),
      TOOLS,
    ) as TestFile;
    assert.deepEqual(test.tool_responses?.refund, [{ status: "declined" }, { status: "refunded" }]);
  });

  it("leave tool responses out for an agent without tools", () => {
    const test = toTestFile(written({ toolResponses: [], mustCallTools: [] }), []) as TestFile;
    assert.equal(test.tool_responses, undefined);
  });

  it("come back per coverage item, the invalid ones listed as dropped", async () => {
    const item: CoverageItem = { id: "c01", area: "job", title: "refund", focus: "", tools: [] };
    const out = await scenariosForItem(
      fakeAsk(() => ({ scenarios: [written(), written({ name: "", input: "x" })] })),
      BRIEF,
      item,
      { count: 2, existing: [] },
    );
    assert.deepEqual(
      out.tests.map((t) => t.name),
      ["refund after a declined card"],
    );
    assert.deepEqual(out.dropped, [{ name: "", reason: "it has no name" }]);
  });
});

describe("scripted tool responses", () => {
  it("answer each tool in call order, repeat the last answer, and stop on a tool with none", () => {
    const session = new ScriptedSession({ refund: [{ status: "declined" }, { status: "refunded" }] });
    assert.deepEqual(session.execute("refund", { id: 7 }), { status: "declined" });
    assert.deepEqual(session.execute("refund", { id: 7 }), { status: "refunded" });
    assert.deepEqual(session.execute("refund", { id: 8 }), { status: "refunded" });
    assert.throws(() => session.execute("send_email", {}), /no response for send_email/);
    assert.match(session.failure!, /send_email/);
    assert.equal(session.controller.signal.aborted, true);
  });

  it("can't be combined with a recorded replay in one test", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentdiff-both-"));
    await fs.writeFile(
      path.join(dir, "both.json"),
      JSON.stringify({
        name: "both",
        input: "refund",
        tool_responses: { refund: [{}] },
        replay: { incidentId: "i", projectId: "p", rootSpanId: "r", reviewed: true, responses: [] },
      }),
    );
    await assert.rejects(loadTests(dir, "."), /replay\) or tool_responses, not both/);
  });

  it("stand in for the agent's own tools when a test runs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentdiff-scripted-"));
    await fs.writeFile(
      path.join(dir, "agent.mjs"),
      `export const agent = {
  tools: ["lookup_customer", "refund"],
  run: async (input, run) => {
    const who = await run.tools.lookup_customer({ order: 7 });
    const first = await run.tools.refund({ order: 7 });
    const second = await run.tools.refund({ order: 7 });
    return { text: who.verified + " " + first.status + " " + second.status, toolCalls: [{ tool: "lookup_customer" }, { tool: "refund" }, { tool: "refund" }] };
  },
};
`,
    );
    const agent = await importAgent(dir, "agent.mjs", "agent");
    const test = toTestFile(written(), TOOLS) as TestFile;
    const run = await runOnce(agent, test, "new", 1);
    assert.equal(run.error, null);
    assert.equal(run.final_response, "true declined refunded");
    assert.deepEqual(
      run.tool_calls.map((c) => [c.tool, c.output]),
      [
        ["lookup_customer", { verified: true }],
        ["refund", { status: "declined" }],
        ["refund", { status: "refunded" }],
      ],
    );
    const missing = await runOnce(agent, { ...test, tool_responses: { refund: [{}] } }, "new", 1);
    assert.match(missing.error ?? "", /no response for lookup_customer/);
  });
});

describe("agentdiff scenarios", () => {
  it("plans, writes and saves scenarios for review, with a coverage report", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentdiff-scenarios-"));
    await fs.writeFile(
      path.join(dir, "agent.mjs"),
      `export const agent = { instructions: ${JSON.stringify(RULES)}, tools: ["lookup_customer", "refund"], run: async () => ({ text: "ok" }) };\n`,
    );
    await fs.writeFile(
      path.join(dir, "agentdiff.config.mjs"),
      `export default { agent: "agent", agentPath: "agent.mjs", tests: "tests" };\n`,
    );
    const ask = fakeAsk((system, prompt) => {
      if (system.includes("plan test coverage")) return { items: [planned({})] };
      const { item } = JSON.parse(prompt) as { item: CoverageItem };
      // The writer fails on one rule, so the report shows a gap.
      if (item.title === "Never refund twice.") throw new Error("model timed out");
      return { scenarios: [written({ name: `${item.title} case` })] };
    });
    const { dir: out, result } = await draftScenarios({ config: path.join(dir, "agentdiff.config.mjs"), ask });
    assert.deepEqual(
      result.plan.map((i) => i.title),
      ["refund an order", "call lookup_customer first.", "Never refund twice."],
    );
    assert.deepEqual(
      result.drafts.map((d) => d.file),
      ["refund-an-order-case.json", "call-lookup-customer-first-case.json"],
    );
    assert.deepEqual(result.failed, [{ coverageId: "c03", reason: "model timed out" }]);
    const saved = JSON.parse(await fs.readFile(path.join(out, "tests", "refund-an-order-case.json"), "utf8"));
    assert.deepEqual(saved._coverage, { id: "c01", area: "job", title: "refund an order" });
    assert.deepEqual(saved.tool_responses.refund, [{ status: "declined" }, { status: "refunded" }]);
    const report = await fs.readFile(path.join(out, "report.md"), "utf8");
    assert.equal(report, coverageReport(result, "tests"));
    assert.match(report, /\| c03 \| Never refund twice\. \| \*\*none\*\* \|/);
    assert.equal(scenariosHeadline(result), "2 scenarios for 3 things to cover · 1 gap");
    await assert.rejects(fs.access(path.join(dir, "tests")), "nothing is added to the suite");
  });

  it("tells the planner and the writer which topics to leave out", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentdiff-scenarios-avoid-"));
    await fs.writeFile(
      path.join(dir, "agent.mjs"),
      `export const agent = { instructions: ${JSON.stringify(RULES)}, tools: ["lookup_customer", "refund"], run: async () => ({ text: "ok" }) };\n`,
    );
    await fs.writeFile(
      path.join(dir, "agentdiff.config.mjs"),
      `export default { agent: "agent", agentPath: "agent.mjs", tests: "tests" };\n`,
    );
    const seen: { system: string; avoid?: string }[] = [];
    const ask = fakeAsk((system, prompt) => {
      seen.push({ system, avoid: (JSON.parse(prompt) as { avoidTopics?: string }).avoidTopics });
      return system.includes("plan test coverage") ? { items: [] } : { scenarios: [written()] };
    });
    await draftScenarios({ config: path.join(dir, "agentdiff.config.mjs"), ask, avoid: "medical emergencies" });
    assert.ok(seen.length >= 2);
    for (const call of seen) {
      assert.equal(call.avoid, "medical emergencies");
      assert.match(call.system, /avoidTopics/);
    }
  });

  it("numbers a scenario whose name another one already has", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentdiff-scenarios-names-"));
    await fs.writeFile(
      path.join(dir, "agent.mjs"),
      `export const agent = { instructions: ${JSON.stringify(RULES)}, tools: ["lookup_customer", "refund"], run: async () => ({ text: "ok" }) };\n`,
    );
    await fs.writeFile(
      path.join(dir, "agentdiff.config.mjs"),
      `export default { agent: "agent", agentPath: "agent.mjs", tests: "tests" };\n`,
    );
    const ask = fakeAsk((system) =>
      system.includes("plan test coverage") ? { items: [] } : { scenarios: [written({ name: "Refund twice" })] },
    );
    const { result } = await draftScenarios({ config: path.join(dir, "agentdiff.config.mjs"), ask });
    assert.deepEqual(
      result.drafts.map((d) => [d.test.name, d.file]),
      [
        ["Refund twice", "refund-twice.json"],
        ["Refund twice (2)", "refund-twice-2.json"],
      ],
    );
  });

  it("keeps the rule scenarios when planning fails, and says so", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentdiff-scenarios-noplan-"));
    await fs.writeFile(
      path.join(dir, "agent.mjs"),
      `export const agent = { instructions: ${JSON.stringify(RULES)}, tools: ["lookup_customer", "refund"], run: async () => ({ text: "ok" }) };\n`,
    );
    await fs.writeFile(
      path.join(dir, "agentdiff.config.mjs"),
      `export default { agent: "agent", agentPath: "agent.mjs", tests: "tests" };\n`,
    );
    const ask = fakeAsk((system, prompt) => {
      if (system.includes("plan test coverage")) throw new Error("rate limited");
      return { scenarios: [written({ name: `${(JSON.parse(prompt) as { item: CoverageItem }).item.title} case` })] };
    });
    const { dir: out, result } = await draftScenarios({ config: path.join(dir, "agentdiff.config.mjs"), ask });
    assert.equal(result.planError, "rate limited");
    assert.deepEqual(
      result.plan.map((i) => i.area),
      ["rule", "rule"],
    );
    assert.equal(result.drafts.length, 2);
    assert.match(await fs.readFile(path.join(out, "report.md"), "utf8"), /Planning failed \(rate limited\)/);
  });

  it("stops when the account can't make calls, and keeps what it wrote", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentdiff-scenarios-credits-"));
    await fs.writeFile(
      path.join(dir, "agent.mjs"),
      `export const agent = { instructions: ${JSON.stringify(RULES)}, tools: ["lookup_customer", "refund"], run: async () => ({ text: "ok" }) };\n`,
    );
    await fs.writeFile(
      path.join(dir, "agentdiff.config.mjs"),
      `export default { agent: "agent", agentPath: "agent.mjs", tests: "tests" };\n`,
    );
    process.env.AGENTDIFF_MODEL_CONCURRENCY = "1";
    let calls = 0;
    const ask = fakeAsk((system, prompt) => {
      calls++;
      const title = (JSON.parse(prompt) as { item?: CoverageItem }).item?.title;
      if (title === "call lookup_customer first.") return { scenarios: [written({ name: "first case" })] };
      throw new APICallError({
        message: "You have no credits remaining.",
        url: "https://api.openai.com/v1/responses",
        requestBodyValues: {},
        statusCode: 429,
        responseBody: '{"error":{"code":"insufficient_quota"}}',
      });
    });
    try {
      await assert.rejects(
        draftScenarios({ config: path.join(dir, "agentdiff.config.mjs"), ask }),
        /a spend limit reached\): You have no credits remaining\.\nStopped\. The 1 scenarios written before that are in /,
      );
    } finally {
      delete process.env.AGENTDIFF_MODEL_CONCURRENCY;
    }
    assert.equal(calls, 2, "the first rule and the plan beside it: the second rule never starts");
    const folder = (await fs.readdir(path.join(dir, ".agentdiff"))).find((f) => f.startsWith("scenarios-"))!;
    const out = path.join(dir, ".agentdiff", folder);
    assert.equal((await fs.readdir(path.join(out, "tests"))).length, 1, "the rule written before the stop is kept");
    await assert.rejects(fs.access(path.join(out, "partial")), "the per-item saves are folded into tests/");
  });

  it("reports every gap and dropped scenario under Not written", () => {
    const result: ScenarioResult = {
      agentName: "support",
      agentFile: "agent.mjs",
      createdAt: "",
      plan: [{ id: "c01", area: "job", title: "refund", focus: "", tools: [] }],
      drafts: [],
      dropped: [{ coverageId: "c01", name: "bad", reason: "it has no message" }],
      failed: [],
    };
    assert.match(coverageReport(result, "tests"), /## Not written\n- c01 "bad": dropped, it has no message/);
  });
});
