import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importAgent } from "../src/agent/load.ts";
import { runTests } from "../src/pipeline/run-tests.ts";
import { placeDecisions } from "../src/agent/decisions.ts";
import { countSequences } from "../src/compare/stats.ts";
import { NO_REPLY, stepLabel, stepsOf } from "../src/compare/steps.ts";
import { checkInventory, forbiddenCalls, replyShift, testChanged } from "../src/compare/signals.ts";
import { fmtSequence } from "../src/compare/format.ts";
import { BUILT_IN_CHECKS } from "../src/grade/checks.ts";
import { buildReport } from "../src/report/markdown.ts";
import { TestFileSchema, type Decision, type RunRecord, type TestFile } from "../src/types.ts";
import { comparison, run, side, test as comparisonTest } from "./helpers.ts";

const yesNo = (id: string, yes: boolean, extra: Partial<Decision> = {}): Decision => ({
  id,
  type: "boolean",
  instructions: id,
  answer: { type: "boolean", probability: yes ? 0.9 : 0.1 },
  ...extra,
});

describe("a run's path", () => {
  it("puts each placed check between the tool calls around it, and ends a silent run with no reply", () => {
    const r = run(["lookup_trip", "send_sms"], {
      final_response: null,
      decisions: [
        yesNo("should_reply", true, { after: 0 }),
        yesNo("quiet_hours", false, { after: 1 }),
        yesNo("unplaced", true),
      ],
    });
    assert.deepEqual(stepsOf(r), ["?should_reply=yes", "lookup_trip", "?quiet_hours=no", "send_sms", NO_REPLY]);
    assert.equal(fmtSequence(stepsOf(r)), "should_reply: yes → lookup_trip → quiet_hours: no → send_sms → no reply");
  });

  it("reads a guardrail as tripped or passed, a choice as its option, and adds no ending to an errored run", () => {
    const guard = yesNo("relevance", true, { source: "guardrail", after: 0 });
    const intent: Decision = {
      id: "intent",
      type: "choice",
      instructions: "Which?",
      answer: { type: "choice", choice: "cancel" },
      after: 0,
    };
    assert.deepEqual(stepsOf(run([], { final_response: "ok", decisions: [guard, intent] })), [
      "?relevance=tripped",
      "?intent=cancel",
    ]);
    assert.deepEqual(stepsOf(run([], { error: "boom", final_response: null })), []);
    assert.equal(stepLabel("?reason=a=b"), "reason: a=b");
  });

  it("counts two runs as different paths when the same calls come out of a check the other way", () => {
    const paths = countSequences([
      run(["send_sms"], { decisions: [yesNo("should_reply", true, { after: 0 })] }),
      run([], { final_response: null, decisions: [yesNo("should_reply", false, { after: 0 })] }),
      run(["send_sms"], { decisions: [yesNo("should_reply", true, { after: 0 })] }),
    ]);
    assert.deepEqual(
      paths.map((p) => [fmtSequence(p.seq), p.runs]),
      [
        ["should_reply: yes → send_sms", 2],
        ["should_reply: no → no reply", 1],
      ],
    );
  });
});

describe("placeDecisions", () => {
  const calls = [
    { tool: "a", input: null, output: null, at_ms: 10 },
    { tool: "b", input: null, output: null, at_ms: 50 },
  ];
  it("counts the tool calls that started before each check", () => {
    const placed = placeDecisions(
      [yesNo("x", true, { at_ms: 5 }), yesNo("y", true, { at_ms: 30 }), yesNo("z", true, { at_ms: 60 })],
      calls,
    );
    assert.deepEqual(
      placed.map((d) => d.after),
      [0, 1, 2],
    );
  });
  it("places everything first when there were no calls, keeps checks already placed, and leaves the rest when calls aren't timed", () => {
    assert.equal(placeDecisions([yesNo("x", true)], [])[0].after, 0);
    assert.equal(placeDecisions([yesNo("x", true, { at_ms: 60, after: 0 })], calls)[0].after, 0);
    assert.equal(
      placeDecisions([yesNo("x", true, { at_ms: 30 })], [{ tool: "a", input: null, output: null }])[0].after,
      undefined,
    );
  });
});

describe("conversation tests", () => {
  it("accept earlier turns, a context and tools that must not be called", () => {
    const t = TestFileSchema.parse({
      name: "thumbs up",
      input: "👍",
      conversation: [
        { role: "user", content: "Book the 9:15" },
        { role: "assistant", content: "Booked UA518." },
      ],
      context: { now: "2026-10-13T23:40:00-07:00" },
      must_not_call_tools: ["send_sms"],
    });
    assert.equal(t.conversation?.length, 2);
    assert.throws(() =>
      TestFileSchema.parse({ name: "x", input: "hi", conversation: [{ role: "system", content: "no" }] }),
    );
  });
});

// Real SDK agents with offline models, in a temp project that resolves this repo's node_modules.
let dir: string;
const OPENAI = `
import { Agent, tool, Usage } from "@openai/agents";
import { experimental_evaluate as evaluate } from "ai";
import { z } from "zod";
const usage = () => new Usage({ requests: 1, inputTokens: 5, outputTokens: 1, totalTokens: 6 });
const text = (t: string) => ({ usage: usage(), output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: t }] }] });
const call = (name: string, id: string) => ({ usage: usage(), output: [{ type: "function_call", callId: id, name, arguments: "{}", status: "completed" }] });
const done = (req: any, name: string) => Array.isArray(req.input) && req.input.some((i: any) => i.type === "function_call_result" && i.name === name);
// The desk records the roles it was given, looks the trip up, then answers.
const deskModel = { model: "desk", async getResponse(req: any) {
  (globalThis as any).__roles = Array.isArray(req.input) ? req.input.filter((i: any) => i.role).map((i: any) => i.role) : ["user"];
  return done(req, "lookup_trip") ? text("Your trip is on.") : call("lookup_trip", "t1");
}, async *getStreamedResponse(): AsyncIterable<any> {} };
// The lookup reads the test's context and asks Jev whether a person should take over.
const lookupTrip = tool({ name: "lookup_trip", description: "Look up the trip.", parameters: z.object({}), execute: async (_i, ctx: any) => {
  const { answers } = await evaluate({ model: "typesafe-ai/jev", state: "trip", questions: { needs_human: { type: "boolean", instructions: "Should a person take over?" } } });
  return { now: ctx?.context?.now ?? null, needs_human: answers.needs_human.probability >= 0.5 };
} });
const shouldReply = { name: "should_reply", execute: async ({ input }: any) => {
  const last = Array.isArray(input) ? input.at(-1)?.content : input;
  return { tripwireTriggered: typeof last === "string" && last.trim() === "👍", outputInfo: {} };
} };
export const desk = new Agent({ name: "desk", instructions: "Help.", model: deskModel, tools: [lookupTrip], inputGuardrails: [shouldReply] });

// A two-agent team: the front desk hands off to billing, which refunds.
const frontModel = { model: "front", async getResponse() { return call("transfer_to_billing", "h1"); }, async *getStreamedResponse(): AsyncIterable<any> {} };
const billingModel = { model: "billing", async getResponse(req: any) { return done(req, "refund") ? text("Refunded.") : call("refund", "r1"); }, async *getStreamedResponse(): AsyncIterable<any> {} };
const refund = tool({ name: "refund", description: "Refund.", parameters: z.object({}), execute: async () => ({ status: "refunded" }) });
const billing = new Agent({ name: "billing", instructions: "Refund.", model: billingModel, tools: [refund] });
export const front = new Agent({ name: "front", instructions: "Route.", model: frontModel, tools: [], handoffs: [billing] });
`;
const MASTRA = `
import { Agent } from "@mastra/core/agent";
import { z } from "zod";
const model = { specificationVersion: "v2", provider: "test", modelId: "offline", supportedUrls: {},
  doGenerate: async ({ prompt }: any) => {
    (globalThis as any).__mastraRoles = prompt.filter((m: any) => m.role !== "system").map((m: any) => m.role);
    const answered = prompt.some((m: any) => m.role === "tool");
    return { content: answered ? [{ type: "text", text: "ok" }] : [{ type: "tool-call", toolCallId: "m1", toolName: "clock", input: "{}" }],
      finishReason: answered ? "stop" : "tool-calls", usage: { inputTokens: 1, outputTokens: 1 }, warnings: [] };
  } };
export const agent = new Agent({ id: "m", name: "m", instructions: "Tell the time.", model, tools: {
  clock: { id: "clock", description: "The time.", inputSchema: z.object({}), execute: async (_i: any, ctx: any) => ({ now: ctx?.requestContext?.get("now") ?? null }) },
} });
`;
const FUNCTION = `
export async function sms(input: string, run: { conversation?: any[]; context?: Record<string, any> }) {
  if (run.context?.opted_out) return { text: null, checks: [{ id: "opted_out", answer: true, after: 0 }] };
  return { text: \`\${run.conversation?.length ?? 0} earlier: \${input}\` };
}
`;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentdiff-conversations-"));
  await fs.symlink(path.resolve("node_modules"), path.join(dir, "node_modules"), "junction");
  await fs.writeFile(path.join(dir, "package.json"), '{"type":"module"}');
  await fs.writeFile(path.join(dir, "openai.ts"), OPENAI);
  await fs.writeFile(path.join(dir, "mastra.ts"), MASTRA);
  await fs.writeFile(path.join(dir, "fn.ts"), FUNCTION);
});
after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function runOne(file: string, exportName: string, t: TestFile): Promise<RunRecord> {
  const agent = await importAgent(dir, file, exportName);
  const runsDir = await fs.mkdtemp(path.join(dir, "runs-"));
  const {
    new: [r],
  } = await runTests({ sides: [{ agent, version: "new", runsDir }], tests: [t], runsPerTest: 1, concurrency: 1 });
  return r;
}

const conversation = [
  { role: "user" as const, content: "Is my trip still on?" },
  { role: "assistant" as const, content: "Checking now." },
];

describe("OpenAI Agents SDK runs", () => {
  const realFetch = globalThis.fetch;
  before(() => {
    process.env.AI_GATEWAY_API_KEY ??= "offline";
    globalThis.fetch = (async (input: any, init?: RequestInit) =>
      String(input).endsWith("/evaluation-model")
        ? Response.json({ answers: { needs_human: { type: "boolean", probability: 0.2 } } })
        : realFetch(input, init)) as typeof fetch;
  });
  after(() => {
    globalThis.fetch = realFetch;
  });

  it("get the earlier turns and the context, and place the guardrail and the Jev check where they ran", async () => {
    const r = await runOne("openai.ts", "desk", {
      name: "status",
      input: "any update?",
      conversation,
      context: { now: "23:40" },
    });
    assert.equal(r.error, null);
    assert.deepEqual((globalThis as any).__roles, ["user", "assistant", "user"]);
    assert.deepEqual(r.tool_calls[0].output, { now: "23:40", needs_human: false });
    assert.equal(r.tool_calls[0].agent, "desk");
    assert.deepEqual(stepsOf(r), ["?should_reply=passed", "lookup_trip", "?needs_human=no"]);
    assert.equal(r.decisions?.find((d) => d.id === "should_reply")?.source, "guardrail");
    const { extractSnapshot } = await import("../src/agent/snapshot.ts");
    assert.deepEqual(
      (await extractSnapshot(await importAgent(dir, "openai.ts", "desk"))).settings.inputGuardrails,
      ["should_reply"],
      "the snapshot lists the agent's guardrails",
    );
  });

  it("record a tripped guardrail as a check and the run as no reply, not an error", async () => {
    const r = await runOne("openai.ts", "desk", { name: "thumbs up", input: "👍", conversation });
    assert.equal(r.error, null);
    assert.equal(r.final_response, null);
    assert.deepEqual(stepsOf(r), ["?should_reply=tripped", NO_REPLY]);
  });

  it("name the agent behind each call in a team, with handoffs on the clock", async () => {
    const r = await runOne("openai.ts", "front", { name: "refund", input: "refund me" });
    assert.deepEqual(
      r.tool_calls.map((c) => [c.tool, c.agent]),
      [
        ["transfer_to_billing", "front"],
        ["refund", "billing"],
      ],
    );
    assert.ok(
      r.tool_calls.every((c) => typeof c.at_ms === "number") && r.tool_calls[0].at_ms! <= r.tool_calls[1].at_ms!,
    );
  });
});

describe("Mastra and function runs", () => {
  it("give a Mastra agent the earlier turns as messages and the context as its RequestContext", async () => {
    const r = await runOne("mastra.ts", "agent", {
      name: "time",
      input: "what time is it?",
      conversation,
      context: { now: "23:40" },
    });
    assert.equal(r.error, null);
    assert.deepEqual((globalThis as any).__mastraRoles.slice(0, 3), ["user", "assistant", "user"]);
    assert.deepEqual(
      r.tool_calls.map((c) => [c.tool, c.id, c.output]),
      [["clock", "m1", { now: "23:40" }]],
    );
    assert.equal(typeof r.tool_calls[0].at_ms, "number");
  });

  it("give a function agent the earlier turns and context, and keep the checks it reports", async () => {
    assert.equal(
      (await runOne("fn.ts", "sms", { name: "hi", input: "hi", conversation })).final_response,
      "2 earlier: hi",
    );
    const stopped = await runOne("fn.ts", "sms", { name: "stop", input: "hi", context: { opted_out: true } });
    assert.deepEqual(stepsOf(stopped), ["?opted_out=yes", NO_REPLY]);
    assert.equal(stopped.decisions?.[0].source, "agent");
  });
});

describe("forbidden and write tools in the report", () => {
  const t = comparisonTest({
    test: "after STOP",
    mustCallTools: [],
    mustNotCallTools: ["send_sms"],
    old: side({ send_sms: 0, charge: 0 }),
    new: side({ send_sms: 3, charge: 4 }),
  });
  it("flag a forbidden tool called more often as a regression", () => {
    assert.deepEqual(forbiddenCalls(t), [{ tool: "send_sms", oldRate: "0/5", newRate: "3/5" }]);
    assert.equal(testChanged(t), true);
    const report = buildReport(comparison({ tests: [t], writeTools: ["charge"] }), "");
    assert.match(report, /## 1 of 1 test changed: 1 broke a rule · 1 forbidden tool called more often/);
    assert.match(
      report,
      /\| 🛑 \*\*after STOP\*\* \| never `send_sms` 0\/5 → \*\*3\/5\*\* \| `charge` 0\/5 → \*\*4\/5\*\* \|/,
    );
    assert.match(report, /\| test \| required and forbidden tools \| writes \|/);
  });
});

describe("replies and checks the agent only has in one version", () => {
  const guard = (yes: number) => ({
    type: "boolean" as const,
    source: "guardrail" as const,
    instructions: "input guardrail",
    runs: 3,
    runsAsking: 3,
    asks: 3,
    yes,
  });
  const triage = (yes: number) => ({
    type: "boolean" as const,
    instructions: "Needs a person?",
    runs: 3,
    runsAsking: 3,
    asks: 3,
    yes,
  });
  const thumbs = comparisonTest({
    test: "thumbs up",
    oneSidedChecks: ["should_reply"],
    old: side(
      {},
      { runs: 3, replied: { runs: 0, of: 3 }, decisions: { should_reply: guard(3), needs_person: triage(0) } },
    ),
    new: side({}, { runs: 3, replied: { runs: 3, of: 3 }, decisions: { needs_person: triage(0) } }),
  });
  const same = comparisonTest({
    test: "status question",
    oneSidedChecks: ["should_reply"],
    old: side(
      {},
      { runs: 3, replied: { runs: 3, of: 3 }, decisions: { should_reply: guard(0), needs_person: triage(0) } },
    ),
    new: side({}, { runs: 3, replied: { runs: 3, of: 3 }, decisions: { needs_person: triage(0) } }),
  });
  const escalates = comparisonTest({
    test: "stranded",
    oneSidedChecks: ["should_reply"],
    old: side({}, { runs: 3, replied: { runs: 3, of: 3 }, decisions: { needs_person: triage(3) } }),
    new: side({}, { runs: 3, replied: { runs: 3, of: 3 }, decisions: { needs_person: triage(0) } }),
  });

  it("counts a new reply where the old version stayed silent, and nothing for a removed check alone", () => {
    assert.deepEqual(replyShift(thumbs), { old: "0/3", new: "3/3", started: true });
    assert.equal(testChanged(thumbs), true);
    assert.equal(testChanged(same), false, "only the removed check differs");
    assert.equal(testChanged(escalates), true, "a check both versions run still counts when its answers move");
    assert.deepEqual(checkInventory([thumbs, same, escalates]), {
      removed: [{ id: "should_reply", source: "guardrail" }],
      added: [],
    });
  });

  it("puts replies and removed checks in the headline, and lists a removed check once", () => {
    const report = buildReport(comparison({ tests: [thumbs, same, escalates] }), "");
    assert.match(
      report,
      /^## 2 of 3 tests changed · started replying in 1 test it used to leave alone · checks removed: should_reply$/m,
    );
    // No grade or check says whether the new reply is wrong, so it is a difference, not a regression.
    assert.match(report, /\| • thumbs up \| – \| 0\/3 → \*\*3\/3\*\* \|/);
    assert.match(report, /Removed from the agent: `should_reply` guardrail\./);
    assert.doesNotMatch(report, /\| thumbs up \| `should_reply`/, "no per-test rows for a removed check");
    assert.match(report, /\| stranded \| `needs_person` \| 3\/3 → 3\/3 \| yes 3\/3 → \*\*yes 0\/3\*\* \| same \|/);
    assert.doesNotMatch(report, /\| status question \| `needs_person`/, "unchanged rows are left out");
  });

  it("gives Jev failure types for replying when it shouldn't and staying silent when it should reply", () => {
    assert.ok(
      "unwanted_reply" in BUILT_IN_CHECKS.failure_type.options &&
        "missing_reply" in BUILT_IN_CHECKS.failure_type.options,
    );
    assert.match(BUILT_IN_CHECKS.acted_before_check.question, /Only `tool_calls` count; the reply itself doesn't/);
  });
});
