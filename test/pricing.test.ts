import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { costOf } from "../src/compare/pricing.ts";

const close = (a: number | null, b: number) => assert.ok(a != null && Math.abs(a - b) < 1e-12, `${a} ≠ ${b}`);

describe("costOf", () => {
  it("is null when the run reported no usage at all", () => {
    assert.equal(costOf("gpt-5.4", null), null);
    assert.equal(costOf("gpt-5.4", { input: null, output: null }), null);
  });
  it("prices a half-known usage as if the missing side were zero", () => {
    close(costOf("claude-opus-4-1", { input: 1_000_000, output: null }), 15);
  });
  it("prices each model at its own rate, not its family's", () => {
    close(costOf("gpt-5.4", { input: 1000, output: 100 }), (1000 * 2.5 + 100 * 15) / 1e6);
    close(costOf("gpt-5.4-mini", { input: 1_000_000, output: 1_000_000 }), 5.25);
    close(costOf("claude-opus-5-5", { input: 1_000_000, output: 0 }), 4);
  });
  it("reads provider prefixes, dated snapshots and aliases as the model they name", () => {
    close(costOf("openai/GPT-5.1", { input: 1_000_000, output: 0 }), 1.25);
    close(costOf("gpt-5.4-mini-2026-03-17", { input: 0, output: 1_000_000 }), 4.5);
    close(costOf("anthropic/claude-sonnet-4-5-20250929", { input: 1_000_000, output: 0 }), 3);
    close(costOf("claude-3-5-haiku-latest", { input: 1_000_000, output: 1_000_000 }), 4.8);
  });
  it("is null for a model with no listed price, rather than a guess", () => {
    assert.equal(costOf("gpt-5.4-pro", { input: 1000, output: 100 }), null);
    assert.equal(costOf("my-function-agent", { input: 1000, output: 100 }), null);
  });
});
