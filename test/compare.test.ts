import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeVersionStats, countSequences, recordsFor } from "../src/compare/stats.ts";
import { diffInstructions, diffSnapshots, snapshotUnchanged } from "../src/compare/snapshot-diff.ts";
import { failedRun, run, snapshot } from "./helpers.ts";

describe("countSequences", () => {
  it("orders by frequency, then prefers the shorter path on a tie", () => {
    const seqs = countSequences([
      run(["lookup_customer", "refund_customer"]),
      run(["lookup_customer", "refund_customer"]),
      run(["lookup_customer"]),
      run([]),
      run(["lookup_customer"]),
      run([]),
      run(["escalate"]),
    ]);
    assert.deepEqual(seqs, [
      { seq: [], runs: 2 },
      { seq: ["lookup_customer"], runs: 2 },
      { seq: ["lookup_customer", "refund_customer"], runs: 2 },
      { seq: ["escalate"], runs: 1 },
    ]);
  });
  it("leaves errored runs out entirely", () => {
    assert.deepEqual(countSequences([failedRun(), run(["escalate"])]), [{ seq: ["escalate"], runs: 1 }]);
    assert.deepEqual(countSequences([failedRun()]), []);
  });
  it("keeps order significant", () => {
    const seqs = countSequences([run(["a", "b"]), run(["b", "a"])]);
    assert.equal(seqs.length, 2);
  });
});

describe("computeVersionStats", () => {
  it("reports every required tool, even one the agent never called", () => {
    const s = computeVersionStats([run([]), run(["escalate"])], "gpt-5.4", ["lookup_customer"]);
    assert.deepEqual(s.toolCallRate, {
      lookup_customer: { called: 0, of: 2 },
      escalate: { called: 1, of: 2 },
    });
  });
  it("counts a tool once per run no matter how often it fired", () => {
    const s = computeVersionStats([run(["lookup_customer", "lookup_customer"])], "gpt-5.4", []);
    assert.deepEqual(s.toolCallRate.lookup_customer, { called: 1, of: 1 });
  });
  it("averages tokens, cost, latency, and steps over the runs that have them", () => {
    const s = computeVersionStats(
      [
        run([], { tokens: { input: 1000, output: 100 }, latency_ms: 400, steps: 1 }),
        run([], { tokens: { input: 3000, output: 300 }, latency_ms: 800, steps: 3 }),
        failedRun(),
      ],
      "gpt-5.4",
      [],
    );
    assert.equal(s.runs, 3);
    assert.equal(s.errors, 1);
    assert.equal(s.avgTokensInput, 2000);
    assert.equal(s.avgTokensOutput, 200);
    assert.equal(s.avgLatencyMs, 600);
    assert.equal(s.avgSteps, 2);
    // gpt-5.4 is $2.50 / $15 per 1M.
    assert.ok(Math.abs((s.avgCost ?? 0) - (2000 * 2.5 + 200 * 15) / 1e6) < 1e-12);
  });
  it("has no cost or grade when nothing is measurable, but keeps the error", () => {
    const s = computeVersionStats([failedRun("no credits")], "gpt-5.4", []);
    assert.equal(s.avgCost, null);
    assert.equal(s.avgGrade, null);
    assert.equal(s.gradedRuns, 0);
    assert.equal(s.sampleResponse, null);
    assert.equal(s.sampleError, "no credits");
    assert.equal(computeVersionStats([run([])], "gpt-5.4", []).sampleError, null);
  });
  it("averages grades when given", () => {
    const s = computeVersionStats([run([]), run([])], "gpt-5.4", [], [5, 2]);
    assert.equal(s.avgGrade, 3.5);
    assert.equal(s.gradedRuns, 2);
  });
  it("picks a successful response as the sample", () => {
    const s = computeVersionStats(
      [run([], { final_response: "partial", error: "timeout" }), run([], { final_response: "Refund issued." })],
      "gpt-5.4",
      [],
    );
    assert.equal(s.sampleResponse, "Refund issued.");
  });
});

describe("diffInstructions", () => {
  it("keeps only the lines that changed", () => {
    const d = diffInstructions(
      "Be helpful.\nAlways look up the customer first.\nNever swear.\n",
      "Be helpful.\nRefund quickly.\nNever swear.\n",
    );
    assert.equal(d, "- Always look up the customer first.\n+ Refund quickly.");
  });
  it("is empty for identical prompts", () => {
    assert.equal(diffInstructions("same\n", "same\n"), "");
  });
});

describe("diffSnapshots", () => {
  it("lists tool, workflow, and setting changes", () => {
    const d = diffSnapshots(
      snapshot({
        tools: ["lookup_customer", "refund_customer"],
        workflows: ["kyc"],
        settings: { maxSteps: 5, temperature: 0 },
      }),
      snapshot({ tools: ["lookup_customer", "escalate"], workflows: [], settings: { maxSteps: 8, temperature: 0 } }),
    );
    assert.deepEqual(d.toolsAdded, ["escalate"]);
    assert.deepEqual(d.toolsRemoved, ["refund_customer"]);
    assert.deepEqual(d.workflowsRemoved, ["kyc"]);
    assert.deepEqual(d.settingsChanged, [{ key: "maxSteps", old: 5, new: 8 }]);
    assert.equal(d.instructionsDiff, "");
  });
  it("treats a dropped setting as a change to null", () => {
    const d = diffSnapshots(snapshot({ settings: { maxSteps: 5 } }), snapshot({ settings: {} }));
    assert.deepEqual(d.settingsChanged, [{ key: "maxSteps", old: 5, new: null }]);
  });
});

describe("snapshotUnchanged", () => {
  it("is true only when nothing observable moved", () => {
    assert.equal(snapshotUnchanged(snapshot(), snapshot()), true);
    assert.equal(snapshotUnchanged(snapshot(), snapshot({ model: "gpt-5.3" })), false);
    assert.equal(snapshotUnchanged(snapshot(), snapshot({ instructions: "Be terse.\n" })), false);
    assert.equal(snapshotUnchanged(snapshot(), snapshot({ settings: { maxSteps: 6 } })), false);
  });
});

describe("recordsFor", () => {
  it("filters to one test on one side", () => {
    const rs = [
      run([], { test: "a", version: "old" }),
      run([], { test: "a", version: "new" }),
      run([], { test: "b", version: "old" }),
    ];
    assert.equal(recordsFor(rs, "a", "old").length, 1);
    assert.equal(recordsFor(rs, "b", "new").length, 0);
  });
});
