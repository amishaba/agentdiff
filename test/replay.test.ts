// A replayed or discovered run keeps the framework's own record of its path
// (handoffs, who made each call, when) only when it matches what the fake
// tools actually answered.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { answeredCalls } from "../src/agent/replay.ts";

const call = (tool: string, extra: Record<string, unknown> = {}) => ({ tool, input: null, output: null, ...extra });

describe("answeredCalls", () => {
  const answered = [
    call("lookup", { input: { id: 1 }, output: { ok: true } }),
    call("refund", { input: { id: 1 }, output: { status: "held" } }),
  ];

  it("keeps handoffs, agents and times, with the answered inputs and outputs", () => {
    const reported = [
      call("transfer_to_payments", { agent: "desk", at_ms: 3 }),
      call("lookup", { agent: "payments", at_ms: 5, output: '{"ok":true}' }),
      call("refund", { agent: "payments", at_ms: 9 }),
    ];
    assert.deepEqual(answeredCalls(reported, answered), [
      call("transfer_to_payments", { agent: "desk", at_ms: 3 }),
      call("lookup", { agent: "payments", at_ms: 5, input: { id: 1 }, output: { ok: true } }),
      call("refund", { agent: "payments", at_ms: 9, input: { id: 1 }, output: { status: "held" } }),
    ]);
  });

  it("falls back to the answered calls when the record disagrees", () => {
    assert.equal(
      answeredCalls([call("lookup"), call("charge")], answered),
      answered,
      "a call the session never answered",
    );
    assert.equal(answeredCalls([call("lookup")], answered), answered, "a call the record left out");
    assert.equal(answeredCalls([], answered), answered);
  });
});

describe("mastraReplaySupported", () => {
  it("accepts 1.63.2 and later 1.x, and nothing else", async () => {
    const { mastraReplaySupported } = await import("../src/agent/load.ts");
    for (const v of ["1.63.2", "1.63.10", "1.72.0", "1.99.0-beta.1"]) assert.equal(mastraReplaySupported(v), true, v);
    for (const v of ["1.63.1", "1.62.9", "0.10.0", "2.0.0"]) assert.equal(mastraReplaySupported(v), false, v);
  });
});
