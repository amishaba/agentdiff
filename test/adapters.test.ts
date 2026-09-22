import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runOnce } from "../src/agent/execute.ts";
import { extractSnapshot } from "../src/agent/snapshot.ts";
import { importAgent } from "../src/agent/load.ts";
import { runTests } from "../src/pipeline/run-tests.ts";
import type { TestFile } from "../src/types.ts";
import { createOwnToolsRunner, createProbeRunner } from "../src/discovery/runner.ts";
import { DiscoveryConfigSchema } from "../src/discovery/types.ts";

// Agent files live in a temp project that resolves this repo's node_modules,
// the way a user's project resolves its own.
let dir: string;

const OPENAI_AGENT = `
import { Agent, handoff, tool, Usage, webSearchTool } from "@openai/agents";
import { z } from "zod";

const usage = () => new Usage({ requests: 1, inputTokens: 10, outputTokens: 2, totalTokens: 12 });
// Offline model: look the customer up, refund, then answer.
const model = {
  model: "offline-model",
  async getResponse(req: any) {
    const items = Array.isArray(req.input) ? req.input : [];
    const done = items.filter((i: any) => i.type === "function_call_result").map((i: any) => i.name);
    const next = ["lookup_customer", "refund_order"].find((t) => !done.includes(t));
    if (next) return { usage: usage(), output: [{ type: "function_call", callId: "c-" + next, name: next, arguments: JSON.stringify({ id: 4471 }), status: "completed" }] };
    return { usage: usage(), output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Refunded order 4471." }] }] };
  },
  async *getStreamedResponse(): AsyncIterable<any> { throw new Error("offline model doesn't stream"); },
};
const ran = () => { (globalThis as any).__realToolRuns = ((globalThis as any).__realToolRuns ?? 0) + 1; };
const lookup = tool({ name: "lookup_customer", description: "Look up a customer.", parameters: z.object({ id: z.number() }), execute: async () => { ran(); return { verified: true }; } });
const refund = tool({ name: "refund_order", description: "Refund an order.", parameters: z.object({ id: z.number() }), execute: async () => { ran(); return { status: "refunded" }; } });

export const support = new Agent({ name: "support", instructions: "Verify, then refund.", model, tools: [lookup, refund], modelSettings: { temperature: 0.2 } });
export const dynamic = new Agent({ name: "dynamic", instructions: async () => "Built at run time.", model, tools: [] });
export const hosted = new Agent({ name: "hosted", instructions: "Search.", model, tools: [webSearchTool()] });

// A two-agent team: the desk hands off to a specialist, which looks the customer up.
const step = (output: any[]) => ({ usage: usage(), output });
const deskModel = { model: "desk-model", async getResponse() { return step([{ type: "function_call", callId: "h1", name: "transfer_to_specialist", arguments: "{}", status: "completed" }]); }, async *getStreamedResponse(): AsyncIterable<any> {} };
const specialistModel = { model: "specialist-model", async getResponse(req: any) {
  const looked = Array.isArray(req.input) && req.input.some((i: any) => i.type === "function_call_result" && i.name === "lookup_customer");
  return looked ? step([{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Handled." }] }])
    : step([{ type: "function_call", callId: "l1", name: "lookup_customer", arguments: JSON.stringify({ id: 7 }), status: "completed" }]);
}, async *getStreamedResponse(): AsyncIterable<any> {} };
const specialist = new Agent({ name: "specialist", instructions: "Look them up.", model: specialistModel, tools: [lookup] });
export const desk = new Agent({ name: "desk", instructions: "Hand off.", model: deskModel, tools: [], handoffs: [specialist] });
// The same team through handoff(), whose callback is project code with a side effect.
export const deskViaHandoff = new Agent({ name: "desk", instructions: "Hand off.", model: deskModel, tools: [], handoffs: [handoff(specialist, { onHandoff: () => { (globalThis as any).__onHandoffRuns = ((globalThis as any).__onHandoffRuns ?? 0) + 1; } })] });
`;

const FUNCTION_AGENTS = `
export async function plain(input: string) {
  return { text: "echo " + input, toolCalls: [{ name: "lookup", arguments: '{"q":"jane"}', result: { verified: true } }], usage: { prompt_tokens: 5, completion_tokens: 2 }, steps: 2 };
}
plain.instructions = "Answer briefly.";
plain.model = "gpt-5.4";
plain.tools = [{ type: "function", function: { name: "lookup", description: "Look up a customer.", parameters: { type: "object", properties: { q: { type: "string" } } } } }];

export const objectAgent = { agentName: "obj", instructions: "Say it back.", run: async (input: string) => "said " + input };

// Uses the tools agentdiff passes in when there are any, its own otherwise.
const realLookup = async (q: unknown) => { (globalThis as any).__realFunctionToolRuns = ((globalThis as any).__realFunctionToolRuns ?? 0) + 1; return { verified: true, q }; };
export async function toolUser(input: string, run: { tools?: Record<string, (input: unknown) => Promise<unknown>> } = {}) {
  const lookup = run.tools?.lookup ?? realLookup;
  const found = await lookup({ q: input });
  return { text: "found " + JSON.stringify(found), toolCalls: [{ name: "lookup", arguments: { q: input }, result: found }] };
}
toolUser.tools = ["lookup"];
export const notAnAgent = { hello: "world" };
`;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentdiff-adapters-"));
  await fs.symlink(path.resolve("node_modules"), path.join(dir, "node_modules"), "junction");
  await fs.writeFile(path.join(dir, "package.json"), '{"type":"module"}');
  await fs.writeFile(path.join(dir, "openai.ts"), OPENAI_AGENT);
  await fs.writeFile(path.join(dir, "functions.ts"), FUNCTION_AGENTS);
});
after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const realToolRuns = () => (globalThis as any).__realToolRuns ?? 0;

describe("OpenAI Agents SDK", () => {
  it("snapshots the agent's prompt, model, tools and settings", async () => {
    const agent = await importAgent(dir, "openai.ts", "support");
    const s = await extractSnapshot(agent);
    assert.equal(s.name, "support");
    assert.equal(s.instructions, "Verify, then refund.");
    assert.equal(s.model, "offline-model");
    assert.deepEqual(s.tools, ["lookup_customer", "refund_order"]);
    assert.equal(s.toolDefinitions?.refund_order.description, "Refund an order.");
    assert.deepEqual((s.toolDefinitions?.refund_order.inputSchema as any)?.properties, { id: { type: "number" } });
    assert.deepEqual(s.settings, { temperature: 0.2 });
    assert.equal(
      (await extractSnapshot(await importAgent(dir, "openai.ts", "dynamic"))).instructions,
      "Built at run time.",
    );
  });

  it("records each run's tool calls with their outputs, the reply, steps and tokens", async () => {
    const agent = await importAgent(dir, "openai.ts", "support");
    const runsDir = await fs.mkdtemp(path.join(dir, "runs-"));
    const {
      new: [r],
    } = await runTests({
      sides: [{ agent, version: "new", runsDir }],
      tests: [{ name: "refund", input: "Refund order 4471" }],
      runsPerTest: 1,
      concurrency: 1,
    });
    assert.equal(r.error, null);
    assert.deepEqual(
      r.tool_calls.map(({ at_ms, ...c }) => c),
      [
        {
          tool: "lookup_customer",
          input: { id: 4471 },
          output: { verified: true },
          id: "c-lookup_customer",
          agent: "support",
        },
        {
          tool: "refund_order",
          input: { id: 4471 },
          output: { status: "refunded" },
          id: "c-refund_order",
          agent: "support",
        },
      ],
    );
    const [a, b] = r.tool_calls.map((c) => c.at_ms!);
    assert.ok(a >= 0 && b > a, `each call starts on the run's clock, in order: ${a}, ${b}`);
    assert.equal(r.final_response, "Refunded order 4471.");
    assert.equal(r.steps, 3);
    assert.deepEqual(r.tokens, { input: 30, output: 6 });
  });

  it("replays recorded tool responses without running the real tools, and blocks on a missing one", async () => {
    const agent = await importAgent(dir, "openai.ts", "support");
    const replay = (responses: any[]): TestFile => ({
      name: "incident",
      input: "Refund order 4471",
      replay: { incidentId: "i", projectId: "p", rootSpanId: "r", reviewed: true, responses },
    });
    const lookup = {
      tool: "lookup_customer",
      input: { id: 4471 },
      output: { verified: false },
      occurrence: 1,
      source: "recording" as const,
    };
    const before = realToolRuns();

    const blocked = await runOnce(agent, replay([lookup]), "new", 1);
    assert.equal(blocked.replay?.status, "blocked");
    assert.deepEqual(blocked.replay?.missing, [{ tool: "refund_order", input: { id: 4471 }, occurrence: 1 }]);

    const refund = {
      tool: "refund_order",
      input: { id: 4471 },
      output: { status: "held" },
      occurrence: 1,
      source: "user" as const,
    };
    const done = await runOnce(agent, replay([lookup, refund]), "new", 1);
    assert.equal(done.error, null);
    assert.equal(done.replay?.status, "complete");
    assert.deepEqual(
      done.tool_calls.map((c) => c.output),
      [{ verified: false }, { status: "held" }],
    );
    assert.equal(realToolRuns(), before, "the agent's own tools never ran");
  });

  it("never answers a call whose arguments changed with the recorded success", async () => {
    // The recording booked order 9999; this agent asks about 4471. Same tool, different arguments: blocked, not "refunded".
    const agent = await importAgent(dir, "openai.ts", "support");
    const recorded = {
      tool: "lookup_customer",
      input: { id: 9999 },
      output: { verified: true },
      occurrence: 1,
      source: "recording" as const,
    };
    const r = await runOnce(
      agent,
      {
        name: "incident",
        input: "Refund order 4471",
        replay: { incidentId: "i", projectId: "p", rootSpanId: "r", reviewed: true, responses: [recorded] },
      },
      "new",
      1,
    );
    assert.equal(r.replay?.status, "blocked");
    assert.deepEqual(r.replay?.missing, [{ tool: "lookup_customer", input: { id: 4471 }, occurrence: 1 }]);
    assert.equal(r.final_response, null);
  });

  it("runs discovery probes against fixtures instead of the real tools", async () => {
    const agent = await importAgent(dir, "openai.ts", "support");
    const config = DiscoveryConfigSchema.parse({ fixtures: "fixtures.ts" });
    const before = realToolRuns();
    await assert.rejects(
      createProbeRunner({ old: agent, new: agent }, () => ({ lookup_customer: () => ({ verified: true }) }), config),
      /fixture for refund_order/,
    );
    const probe = await createProbeRunner(
      { old: agent, new: agent },
      () => ({ lookup_customer: () => ({ verified: true }), refund_order: () => ({ status: "fixture" }) }),
      config,
    );
    const r = await probe({ input: "Refund order 4471" }, "new", 1, "probe");
    assert.equal(r.error, null);
    assert.deepEqual(
      r.tool_calls.map((c) => [c.tool, c.output]),
      [
        ["lookup_customer", { verified: true }],
        ["refund_order", { status: "fixture" }],
      ],
    );
    assert.equal(realToolRuns(), before);
  });

  it("snapshots every agent in a handoff team and records the handoff in the run", async () => {
    const agent = await importAgent(dir, "openai.ts", "desk");
    const s = await extractSnapshot(agent);
    assert.equal(s.instructions, "## desk\nHand off.\n\n## specialist\nLook them up.");
    assert.deepEqual(s.tools, ["lookup_customer"]);
    assert.equal(s.settings["specialist.model"], "specialist-model");
    assert.deepEqual(s.settings["desk.handoffs"], ["specialist"]);
    const r = await runOnce(agent, { name: "t", input: "help" }, "new", 1);
    assert.equal(r.error, null);
    assert.deepEqual(
      r.tool_calls.map((c) => c.tool),
      ["transfer_to_specialist", "lookup_customer"],
    );
    assert.equal(r.final_response, "Handled.");
  });

  it("passes maxTurns to the SDK's runner", async () => {
    const agent = await importAgent(dir, "openai.ts", "support", { maxTurns: 1 });
    const r = await runOnce(agent, { name: "t", input: "Refund order 4471" }, "new", 1);
    assert.match(r.error ?? "", /max turns/i);
  });

  it("replays a whole handoff team, and never runs a handoff() callback", async () => {
    const before = realToolRuns();
    const lookup = {
      tool: "lookup_customer",
      input: { id: 7 },
      output: { verified: "from the recording" },
      occurrence: 1,
      source: "recording" as const,
    };
    for (const name of ["desk", "deskViaHandoff"]) {
      const agent = await importAgent(dir, "openai.ts", name);
      const r = await runOnce(
        agent,
        {
          name: "t",
          input: "help",
          replay: { incidentId: "i", projectId: "p", rootSpanId: "r", reviewed: true, responses: [lookup] },
        },
        "new",
        1,
      );
      assert.equal(r.error, null, name);
      assert.equal(r.replay?.status, "complete", name);
      // The path keeps the handoff and who made each call, like a normal run.
      assert.deepEqual(
        r.tool_calls.map((c) => [c.tool, c.agent, c.output]),
        [
          ["transfer_to_specialist", "desk", r.tool_calls[0].output],
          ["lookup_customer", "specialist", { verified: "from the recording" }],
        ],
        name,
      );
      assert.equal(r.final_response, "Handled.");
    }
    assert.equal(realToolRuns(), before, "the specialist's real tool never ran");
    assert.equal((globalThis as any).__onHandoffRuns ?? 0, 0, "the handoff callback never ran");
  });

  it('runs each agent\'s own tools when discovery.tools is "own"', async () => {
    const agent = await importAgent(dir, "openai.ts", "support");
    const before = realToolRuns();
    const probe = createOwnToolsRunner({ old: agent, new: agent }, DiscoveryConfigSchema.parse({ tools: "own" }));
    const r = await probe({ input: "Refund order 4471" }, "new", 1, "probe");
    assert.equal(r.error, null);
    assert.deepEqual(
      r.tool_calls.map((c) => [c.tool, c.output]),
      [
        ["lookup_customer", { verified: true }],
        ["refund_order", { status: "refunded" }],
      ],
    );
    assert.equal(realToolRuns(), before + 2, "its own simulated tools ran");
  });

  it("runs discovery probes on every agent in a team", async () => {
    const agent = await importAgent(dir, "openai.ts", "desk");
    const config = DiscoveryConfigSchema.parse({ fixtures: "fixtures.ts" });
    await assert.rejects(
      createProbeRunner({ old: agent, new: agent }, () => ({}), config),
      /fixture for lookup_customer/,
      "the specialist's tools count too",
    );
    const probe = await createProbeRunner(
      { old: agent, new: agent },
      () => ({ lookup_customer: () => ({ verified: "fixture" }) }),
      config,
    );
    const r = await probe({ input: "help" }, "new", 1, "probe");
    assert.equal(r.error, null);
    assert.deepEqual(
      r.tool_calls.map((c) => [c.tool, c.output]),
      [
        ["transfer_to_specialist", r.tool_calls[0].output],
        ["lookup_customer", { verified: "fixture" }],
      ],
    );
  });

  it("refuses to replay a tool that runs on OpenAI's side", async () => {
    const agent = await importAgent(dir, "openai.ts", "hosted");
    const r = await runOnce(
      agent,
      {
        name: "t",
        input: "hi",
        replay: { incidentId: "i", projectId: "p", rootSpanId: "r", reviewed: true, responses: [] },
      },
      "new",
      1,
    );
    assert.match(r.error ?? "", /runs on OpenAI's side/);
  });
});

describe("function agents", () => {
  it("runs a function and reads its reply, tool calls and usage in OpenAI's shapes", async () => {
    const agent = await importAgent(dir, "functions.ts", "plain");
    const r = await runOnce(agent, { name: "t", input: "hi" }, "new", 1);
    assert.equal(r.final_response, "echo hi");
    assert.deepEqual(r.tool_calls, [{ tool: "lookup", input: { q: "jane" }, output: { verified: true } }]);
    assert.deepEqual(r.tokens, { input: 5, output: 2 });
    assert.equal(r.steps, 2);
    const s = await extractSnapshot(agent);
    assert.deepEqual([s.name, s.instructions, s.model, s.tools], ["plain", "Answer briefly.", "gpt-5.4", ["lookup"]]);
    assert.equal(s.toolDefinitions?.lookup.description, "Look up a customer.");
  });

  it("runs an object with run(), and a plain string reply", async () => {
    const agent = await importAgent(dir, "functions.ts", "objectAgent");
    const r = await runOnce(agent, { name: "t", input: "hi" }, "new", 1);
    assert.equal(r.final_response, "said hi");
    assert.deepEqual(r.tool_calls, []);
    const s = await extractSnapshot(agent);
    assert.deepEqual([s.name, s.instructions, s.model], ["obj", "Say it back.", "unknown"]);
  });

  it("replays a function through the tools it's given, never its own", async () => {
    const agent = await importAgent(dir, "functions.ts", "toolUser");
    const before = (globalThis as any).__realFunctionToolRuns ?? 0;
    const replay = (responses: any[]): TestFile => ({
      name: "t",
      input: "jane",
      replay: { incidentId: "i", projectId: "p", rootSpanId: "r", reviewed: true, responses },
    });
    const done = await runOnce(
      agent,
      replay([
        { tool: "lookup", input: { q: "jane" }, output: { verified: false }, occurrence: 1, source: "recording" },
      ]),
      "new",
      1,
    );
    assert.equal(done.error, null);
    assert.equal(done.final_response, 'found {"verified":false}');
    assert.deepEqual(
      done.tool_calls.map((c) => [c.tool, c.output]),
      [["lookup", { verified: false }]],
    );
    const blocked = await runOnce(agent, replay([]), "new", 1);
    assert.equal(blocked.replay?.status, "blocked");
    assert.deepEqual(blocked.replay?.missing, [{ tool: "lookup", input: { q: "jane" }, occurrence: 1 }]);
    assert.equal((globalThis as any).__realFunctionToolRuns ?? 0, before, "the function's own lookup never ran");
  });

  it("stops a function that reports a tool call it made some other way", async () => {
    const agent = await importAgent(dir, "functions.ts", "plain");
    const r = await runOnce(
      agent,
      {
        name: "t",
        input: "hi",
        replay: { incidentId: "i", projectId: "p", rootSpanId: "r", reviewed: true, responses: [] },
      },
      "new",
      1,
    );
    assert.match(r.error ?? "", /lookup ran outside the tools agentdiff passed in/);
  });

  it("names what it accepts when the export isn't an agent", async () => {
    await assert.rejects(
      importAgent(dir, "functions.ts", "notAnAgent"),
      /Mastra agent, an OpenAI Agents SDK agent, or a function/,
    );
  });
});
