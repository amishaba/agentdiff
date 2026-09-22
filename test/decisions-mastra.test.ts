import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { experimental_evaluate as evaluate } from "ai";
import { runTests } from "../src/pipeline/run-tests.ts";

const require = createRequire(import.meta.url);
const [major, minor] = process.versions.node.split(".").map(Number);
const supportsMastra = major > 22 || (major === 22 && minor >= 13);
let modulePath: string;
try {
  modulePath = require.resolve("@mastra/core/agent");
} catch {
  modulePath = createRequire(new URL("../example/package.json", import.meta.url)).resolve("@mastra/core/agent");
}
const { Agent } = supportsMastra ? await import(pathToFileURL(modulePath).href) : { Agent: undefined };

// An offline model that calls the `triage` tool once, then answers.
const model = {
  specificationVersion: "v2",
  provider: "test",
  modelId: "offline",
  supportedUrls: {},
  doGenerate: async ({ prompt }: any) => {
    const answered = prompt.some((m: any) => m.role === "tool");
    return {
      content: answered
        ? [{ type: "text", text: "done" }]
        : [{ type: "tool-call", toolCallId: "c1", toolName: "triage", input: "{}" }],
      finishReason: answered ? "stop" : "tool-calls",
      usage: { inputTokens: 1, outputTokens: 1 },
      warnings: [],
    };
  },
};

it(
  "records the Jev decisions a real Mastra agent makes inside a tool, per run",
  { skip: !supportsMastra },
  async () => {
    const realFetch = globalThis.fetch;
    process.env.AI_GATEWAY_API_KEY = "test-key";
    let asked = 0;
    // Gateway stand-in: the first run's question gets "yes", later ones "no".
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      if (!String(input).endsWith("/evaluation-model")) return realFetch(input, init);
      return Response.json({ answers: { escalate: { type: "boolean", probability: asked++ === 0 ? 0.9 : 0.1 } } });
    }) as typeof fetch;
    try {
      const agent = new Agent({
        id: "gated",
        name: "gated",
        instructions: "Triage the request.",
        model,
        tools: {
          triage: {
            id: "triage",
            description: "Decide whether a human should take over",
            inputSchema: z.object({}),
            outputSchema: z.object({ escalate: z.boolean() }),
            execute: async () => {
              const { answers } = await evaluate({
                model: "typesafe-ai/jev",
                state: "customer message",
                questions: { escalate: { type: "boolean", instructions: "Should a human take over?" } },
              });
              return { escalate: answers.escalate.probability >= 0.5 };
            },
          },
        },
      });
      const runsDir = await mkdtemp(path.join(tmpdir(), "agentdiff-decisions-"));
      const { new: records } = await runTests({
        sides: [{ agent, version: "new", runsDir }],
        tests: [{ name: "triage", input: "help" }],
        runsPerTest: 3,
        concurrency: 3,
      });
      assert.equal(records.length, 3);
      assert.ok(
        records.every((r) => !r.error && r.decisions?.length === 1),
        JSON.stringify(records.map((r) => [r.error, r.decisions])),
      );
      const yes = records
        .map((r) => r.decisions![0].answer)
        .filter((a) => a.type === "boolean" && a.probability >= 0.5).length;
      assert.equal(yes, 1, "each run keeps its own answer");
      const { at_ms, ...decision } = records[0].decisions![0];
      assert.deepEqual(
        { ...decision, answer: undefined },
        { id: "escalate", type: "boolean", instructions: "Should a human take over?", answer: undefined, after: 1 },
        "asked inside the tool, so placed after its call",
      );
      assert.ok(at_ms! >= records[0].tool_calls[0].at_ms!, "the question starts after the tool call does");
    } finally {
      globalThis.fetch = realFetch;
    }
  },
);
