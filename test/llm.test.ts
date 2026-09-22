// agentdiff's own OpenAI calls: low reasoning effort by default, for speed, and a concurrency limit.
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { generateText } from "ai";
import { z } from "zod";
import { modelConcurrency, openaiModel } from "../src/lib/llm.ts";
import { openaiAsk } from "../src/scenarios/model.ts";

const env = { ...process.env };
const realFetch = globalThis.fetch;
afterEach(() => {
  process.env = { ...env };
  globalThis.fetch = realFetch;
});

/** The request body agentdiff's model sends, with OpenAI answered locally. */
async function sentBody(): Promise<Record<string, unknown>> {
  process.env.OPENAI_API_KEY = "offline-test-key";
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return Response.json({
      id: "x",
      object: "chat.completion",
      created: 1,
      model: body.model,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  }) as typeof fetch;
  await generateText({ model: openaiModel(), prompt: "hi", temperature: 0 });
  return body;
}

it("asks reasoning models for low effort unless told otherwise", async () => {
  process.env.AGENTDIFF_MODEL = "gpt-5.1";
  assert.equal((await sentBody()).reasoning_effort, "low");
  process.env.AGENTDIFF_REASONING = "medium";
  assert.equal((await sentBody()).reasoning_effort, "medium");
  process.env.AGENTDIFF_REASONING = "default";
  assert.equal((await sentBody()).reasoning_effort, undefined, "left to the model");
});

it("sends no temperature to a reasoning model, which doesn't take one", async () => {
  process.env.AGENTDIFF_MODEL = "gpt-5.1";
  assert.equal((await sentBody()).temperature, undefined);
  process.env.AGENTDIFF_MODEL = "gpt-4.1";
  assert.equal((await sentBody()).temperature, 0);
});

it("runs 12 model calls at once unless told otherwise", () => {
  delete process.env.AGENTDIFF_MODEL_CONCURRENCY;
  assert.equal(modelConcurrency(), 12);
  process.env.AGENTDIFF_MODEL_CONCURRENCY = "20";
  assert.equal(modelConcurrency(), 20);
  process.env.AGENTDIFF_MODEL_CONCURRENCY = "lots";
  assert.equal(modelConcurrency(), 12);
});

it("asks again once when the model returns nothing, then says why", async () => {
  process.env.OPENAI_API_KEY = "offline-test-key";
  const answers = ["", JSON.stringify({ ok: "yes" })];
  let calls = 0;
  globalThis.fetch = (async () => {
    const content = answers[Math.min(calls++, answers.length - 1)];
    return Response.json({
      id: "x",
      object: "chat.completion",
      created: 1,
      model: "gpt-5.1",
      choices: [{ index: 0, finish_reason: content ? "stop" : "length", message: { role: "assistant", content } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  }) as typeof fetch;
  const ask = openaiAsk();
  const request = { schema: z.object({ ok: z.string() }), system: "s", prompt: "p" };
  assert.deepEqual(await ask(request), { ok: "yes" });
  assert.equal(calls, 2, "one retry");
  answers.splice(0, 2, "", "");
  calls = 0;
  await assert.rejects(ask(request), /no usable answer twice \(finish reason: length\)/);
});
