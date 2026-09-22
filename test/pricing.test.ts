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
    close(costOf("claude-opus-4", { input: 1_000_000, output: null }), 15);
  });
  it("matches the model family by substring, case-insensitively", () => {
    close(costOf("claude-3-5-HAIKU-latest", { input: 1_000_000, output: 1_000_000 }), 4.8);
    close(costOf("claude-sonnet-4", { input: 1_000_000, output: 0 }), 3);
  });
  it("falls back to a mid-tier price for unknown models", () => {
    close(costOf("gpt-5.4", { input: 1000, output: 100 }), (1000 * 3 + 100 * 15) / 1e6);
  });
});
