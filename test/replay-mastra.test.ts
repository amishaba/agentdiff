import { it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { runOnce } from "../src/agent/execute.ts";
import type { TestFile } from "../src/types.ts";

const require = createRequire(import.meta.url);
const [major, minor] = process.versions.node.split(".").map(Number);
const supportsMastra = major > 22 || (major === 22 && minor >= 13);
// The example install is also useful when developing from an existing checkout.
let modulePath: string;
try {
  modulePath = require.resolve("@mastra/core/agent");
} catch {
  modulePath = createRequire(new URL("../example/package.json", import.meta.url)).resolve("@mastra/core/agent");
}
const { Agent } = supportsMastra ? await import(pathToFileURL(modulePath).href) : { Agent: undefined };

function model(tool: string) {
  return {
    specificationVersion: "v2",
    provider: "test",
    modelId: "offline",
    supportedUrls: {},
    doStream: async ({ prompt }: any) => {
      const answered = prompt.some((m: any) => m.role === "tool");
      const chunks = answered
        ? [
            { type: "text-start", id: "text" },
            { type: "text-delta", id: "text", delta: "done" },
            { type: "text-end", id: "text" },
          ]
        : [{ type: "tool-call", toolCallId: "call1", toolName: tool, input: '{"id":1}' }];
      return {
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: "stream-start", warnings: [] });
            for (const chunk of chunks) c.enqueue(chunk);
            c.enqueue({
              type: "finish",
              finishReason: answered ? "stop" : "tool-calls",
              usage: { inputTokens: 1, outputTokens: 1 },
            });
            c.close();
          },
        }),
      };
    },
    doGenerate: async ({ prompt }: any) => {
      const answered = prompt.some((m: any) => m.role === "tool");
      return {
        content: answered
          ? [{ type: "text", text: "done" }]
          : [{ type: "tool-call", toolCallId: "call1", toolName: tool, input: '{"id":1}' }],
        finishReason: answered ? "stop" : "tool-calls",
        usage: { inputTokens: 1, outputTokens: 1 },
        warnings: [],
      };
    },
  };
}
function makeAgent(toolName: string, executed: () => void) {
  const agent = new Agent({
    id: "test-agent",
    name: "test-agent",
    instructions: "Use the tool.",
    model: model(toolName),
    tools: {
      [toolName]: {
        id: toolName,
        description: "test tool",
        inputSchema: z.object({ id: z.number() }),
        outputSchema: z.object({ verified: z.boolean() }),
        execute: async () => {
          executed();
          return { verified: false };
        },
      },
    },
  });
  Object.defineProperty(agent, "__agentdiffReplaySupported", { value: true });
  return agent;
}
const test: TestFile = {
  name: "incident",
  input: "refund",
  replay: {
    incidentId: "test",
    projectId: "p",
    rootSpanId: "r",
    reviewed: true,
    responses: [{ tool: "lookup", input: { id: 1 }, output: { verified: true }, occurrence: 1, source: "recording" }],
  },
};

it(
  "runs real Mastra orchestration with an offline model and never executes the production tool",
  { skip: !supportsMastra },
  async () => {
    let liveCalls = 0;
    const agent = makeAgent("lookup", () => liveCalls++);
    const runs = await Promise.all([runOnce(agent, test, "old", 1), runOnce(agent, test, "new", 2)]);
    for (const record of runs) {
      assert.equal(record.error, null);
      assert.equal(record.final_response, "done");
      assert.equal(record.replay?.status, "complete");
      assert.deepEqual(record.tool_calls[0].output, { verified: true });
    }
    assert.equal(liveCalls, 0);
  },
);

it(
  "blocks a newly added fraud check, retains its arguments, then succeeds with a supplied response",
  { skip: !supportsMastra },
  async () => {
    let liveCalls = 0;
    const agent = makeAgent("fraud", () => liveCalls++);
    const blocked = await runOnce(agent, test, "new", 1);
    assert.equal(blocked.replay?.status, "blocked");
    assert.equal(blocked.tool_calls[0].tool, "fraud");
    assert.deepEqual(blocked.replay?.missing[0], { tool: "fraud", input: { id: 1 }, occurrence: 1 });
    const supplied: TestFile = {
      ...test,
      replay: {
        ...test.replay!,
        responses: [
          ...test.replay!.responses,
          { tool: "fraud", input: { id: 1 }, output: { verified: true }, occurrence: 1, source: "user" },
        ],
      },
    };
    const record = await runOnce(agent, supplied, "new", 1);
    assert.equal(record.replay?.status, "complete");
    assert.equal(record.error, null);
    assert.equal(liveCalls, 0);
  },
);

it("rejects an unsupported adapter before generation", async () => {
  let called = false;
  const record = await runOnce(
    {
      generate() {
        called = true;
      },
    },
    test,
    "old",
    1,
  );
  assert.equal(called, false);
  assert.equal(record.replay?.status, "error");
});

it(
  "does not report a successful replay when a saved response fails the new tool schema",
  { skip: !supportsMastra },
  async () => {
    const agent = makeAgent("lookup", () => assert.fail("live executor called"));
    const invalid: TestFile = {
      ...test,
      replay: { ...test.replay!, responses: [{ ...test.replay!.responses[0], output: { wrong: true } }] },
    };
    const record = await runOnce(agent, invalid, "new", 1);
    assert.equal(record.replay?.status, "error");
    assert.match(record.error!, /output schema/);
  },
);
