import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BraintrustClient, mergeSpans, type Span } from "../src/dashboard/braintrust/client.ts";
import { incidentsFromSpans, incidentTest, prepareScenario } from "../src/dashboard/braintrust/scenario.ts";
import { strictCanonical as canonical } from "../src/lib/canonical.ts";
import { ReplaySession } from "../src/agent/replay.ts";
import { ReplayResponseSchema, TestFileSchema } from "../src/types.ts";
import { trustedRequest } from "../src/dashboard/http.ts";
import type http from "node:http";

const project = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const root: Span = {
  id: "root",
  span_id: "root",
  root_span_id: "root",
  input: "refund order 1",
  scores: { quality: 0.1 },
  output: "bad answer",
  metrics: { start: 1, end: 5 },
};
const tool: Span = {
  id: "lookup",
  span_id: "lookup",
  root_span_id: "root",
  span_parents: ["root"],
  span_attributes: { name: "tool: lookup", type: "tool" },
  input: { id: 1 },
  output: { verified: true },
  metrics: { start: 2, end: 3 },
};
function draft(spans = [root, tool]) {
  return prepareScenario(incidentsFromSpans(project, spans)[0], spans);
}

describe("Braintrust import", () => {
  it("fetches documented full-trace pages and passes the returned cursor unchanged", async () => {
    const calls: URL[] = [];
    const client = new BraintrustClient("secret", (async (url: URL, opts: RequestInit) => {
      calls.push(url);
      assert.equal((opts.headers as Record<string, string>).Authorization, "Bearer secret");
      assert.equal(opts.redirect, "error");
      return Response.json({ events: [root, tool], cursor: calls.length === 1 ? "opaque +/=" : null });
    }) as typeof fetch);
    const first = await client.logs(project);
    const next = await client.logs(project, first.cursor!);
    assert.equal(next.events.length, 2);
    assert.equal(calls[1].searchParams.get("cursor"), "opaque +/=");
    assert.equal(calls[0].searchParams.get("limit"), "50");
  });
  it("paginates project selection and never exposes API response bodies on auth errors", async () => {
    let calls = 0;
    const projects = Array.from({ length: 100 }, (_, i) => ({
      id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`,
      name: `p${i}`,
    }));
    const client = new BraintrustClient("secret", (async (url: URL) => {
      calls++;
      if (calls === 2) assert.equal(url.searchParams.get("starting_after"), projects[99].id);
      return Response.json({ objects: calls === 1 ? projects : [] });
    }) as typeof fetch);
    assert.equal((await client.projects()).length, 100);
    const denied = new BraintrustClient(
      "secret",
      (async () => new Response("secret", { status: 403 })) as typeof fetch,
    );
    await assert.rejects(
      denied.projects(),
      (e: Error) => !e.message.includes("secret") && e.message.includes("denied"),
    );
  });
  it("keeps newer event versions across pages", () => {
    const rows = mergeSpans([{ ...root, _xact_id: "0002", output: "latest" }], [{ ...root, _xact_id: "0001" }, tool]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].output, "latest");
  });
  it("includes child errors even if the root has no bad scores", () => {
    assert.equal(
      incidentsFromSpans(project, [
        { ...root, scores: {} },
        { ...tool, error: "failed" },
      ]).length,
      1,
    );
    assert.equal(incidentsFromSpans(project, [{ ...root, scores: { quality: 0.8 } }, tool]).length, 0);
  });
  it("imports responses without treating the failed answer as an expectation", () => {
    const s = draft();
    assert.equal(s.input, root.input);
    assert.equal(s.expectation, "");
    assert.equal(s.suggestedExpectation, "");
    assert.equal(s.reviewed, false);
    assert.deepEqual(s.mustCallTools, []);
    assert.equal(s.responses[0].tool, "lookup");
    assert.deepEqual(s.responses[0].output, tool.output);
  });
  it("preserves null results but leaves absent/error responses missing", () => {
    assert.equal(draft([root, { ...tool, output: null }]).responses[0].output, null);
    const { output, ...missing } = tool;
    assert.equal(draft([root, missing]).responses.length, 0);
    assert.equal(draft([root, { ...tool, error: "failed" }]).responses.length, 0);
    assert.equal(
      ReplayResponseSchema.safeParse({ tool: "a", input: null, occurrence: 1, source: "user" }).success,
      false,
    );
  });
  it("reads a conversation and recorded application state as the test's conversation and context", () => {
    const conversation = draft([
      {
        ...root,
        input: [
          { role: "system", content: "Be brief." },
          { role: "user", content: "Book it" },
          { role: "assistant", content: "Booked." },
          { role: "user", content: "👍" },
        ],
      },
      tool,
    ]);
    assert.deepEqual(
      [conversation.input, conversation.conversation, conversation.blockers],
      [
        "👍",
        [
          { role: "user", content: "Book it" },
          { role: "assistant", content: "Booked." },
        ],
        [],
      ],
    );
    const state = draft([{ ...root, input: { prompt: "hi", state: { user: 1 } } }, tool]);
    assert.deepEqual([state.input, state.context, state.blockers], ["hi", { state: { user: 1 } }, []]);
    const test = incidentTest({ ...state, reviewed: true, expectation: "Greet the user.", mustCallTools: ["lookup"] });
    assert.deepEqual(
      [test.input, test.context, test.grading_criteria, test.must_call_tools, test.replay?.responses.length],
      ["hi", { state: { user: 1 } }, "Greet the user.", ["lookup"], 1],
    );
    assert.ok(TestFileSchema.safeParse(test).success);
  });
  it("blocks unreadable input, missing parents, unfinished traces, and ambiguous repeated calls", () => {
    assert.ok(draft([root, { ...tool, span_parents: ["lost"] }]).blockers.length);
    assert.ok(
      draft([
        {
          ...root,
          input: [
            { role: "user", content: "first" },
            { role: "assistant", content: "answer" },
          ],
        },
        tool,
      ]).blockers.length,
      "ends with the agent's turn",
    );
    assert.ok(
      draft([
        {
          ...root,
          input: [
            { role: "tool", content: "{}" },
            { role: "user", content: "hi" },
          ],
        },
        tool,
      ]).blockers.length,
      "tool messages",
    );
    assert.ok(draft([{ ...root, input: { state: { user: 1 } } }, tool]).blockers.length, "no prompt or messages");
    assert.ok(draft([{ ...root, metrics: { start: 1 } }, tool]).blockers.length);
    assert.ok(draft([root, tool, { ...tool, id: "two", span_id: "two" }]).blockers.length);
  });
});

describe("recorded tool replay", () => {
  it("matches structure rather than object key order, resets per run and clones outputs", () => {
    const responses = [
      { tool: "lookup", input: { a: 1, b: 2 }, output: { ok: true }, occurrence: 1, source: "recording" as const },
    ];
    const one = new ReplaySession(responses);
    const two = new ReplaySession(responses);
    const output = one.execute("lookup", { b: 2, a: 1 }) as { ok: boolean };
    output.ok = false;
    assert.deepEqual(two.execute("lookup", { a: 1, b: 2 }), { ok: true });
    assert.deepEqual(one.calls[0].output, { ok: true });
  });
  it("blocks skipped checks and changed arguments without inventing results", () => {
    for (const [name, input] of [
      ["fraud", { id: 1 }],
      ["lookup", { id: 2 }],
    ] as const) {
      const s = new ReplaySession(draft().responses);
      assert.throws(() => s.execute(name, input), /Missing test response/);
      assert.equal(s.missing.length, 1);
      assert.equal(s.controller.signal.aborted, true);
      assert.equal(s.calls.length, 1);
      assert.equal(s.calls[0].output, null);
    }
  });
  it("uses each identical call's response only for its occurrence", () => {
    const first = draft().responses[0];
    const s = new ReplaySession([first, { ...first, occurrence: 2, output: "second" }]);
    s.execute("lookup", { id: 1 });
    assert.equal(s.execute("lookup", { id: 1 }), "second");
    assert.throws(() => s.execute("lookup", { id: 1 }));
    assert.equal(s.missing[0].occurrence, 3);
    assert.equal(canonical({ b: 2, a: 1 }), canonical({ a: 1, b: 2 }));
  });
});

it("rejects remote browser origins and DNS rebinding hosts for the local API", () => {
  const req = (headers: Record<string, string>) => ({ headers }) as http.IncomingMessage;
  assert.equal(
    trustedRequest(req({ host: "localhost:4321", origin: "http://localhost:4321", "x-agentdiff": "local" })),
    true,
  );
  assert.equal(
    trustedRequest(req({ host: "localhost:4321", origin: "https://attacker.example", "x-agentdiff": "local" })),
    false,
  );
  assert.equal(trustedRequest(req({ host: "attacker.example:4321", "x-agentdiff": "local" })), false);
  assert.equal(trustedRequest(req({ host: "localhost:4321" })), false);
});
