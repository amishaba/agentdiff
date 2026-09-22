// A real recording of the Mastra support example (Sep 2), kept as a fixture:
// every number in it must be reproducible from its 70 traces, and the story it
// tells (7/7 changed, 10 skipped calls, refund 5.0 → 2.0) must still be what
// the data says. The website's support example is baked from it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { computeVersionStats, recordsFor } from "../src/compare/stats.ts";
import { countSkippedTools } from "../src/compare/signals.ts";
import { gradeChange, testChanged, toolRegressions } from "../src/compare/signals.ts";
import { pctChange } from "../src/compare/format.ts";
import { sortedTests } from "../web/src/data/derive.ts";
import type { Dataset } from "../web/src/data/types.ts";

type Fixture = Pick<Dataset, "comparison" | "grades" | "traces">;
const d: Fixture = JSON.parse(readFileSync(new URL("./fixtures/support-demo.json", import.meta.url), "utf8"));
const c = d.comparison;
const traces = [...d.traces.old, ...d.traces.new];

describe("demo fixture", () => {
  it("is a full 7 tests × 5 runs × 2 versions run, every run graded", () => {
    assert.equal(c.tests.length, 7);
    assert.equal(c.runsPerTest, 5);
    assert.equal(d.traces.old.length, 35);
    assert.equal(d.traces.new.length, 35);
    assert.equal(d.grades.length, 70);
    for (const t of c.tests) {
      assert.equal(recordsFor(traces, t.test, "old").length, 5, t.test);
      assert.equal(recordsFor(traces, t.test, "new").length, 5, t.test);
    }
  });

  it("stores exactly the stats the CLI recomputes from its own traces", () => {
    for (const t of c.tests) {
      for (const v of ["old", "new"] as const) {
        const scores = d.grades.filter((g) => g.test === t.test && g.version === v).map((g) => g.score);
        const fresh = computeVersionStats(
          recordsFor(traces, t.test, v),
          c[`${v}Snapshot`].model,
          t.mustCallTools,
          scores,
        );
        // The fixture predates sampleError; the samples are not stats anyway.
        const { sampleResponse: _a, sampleError: _c, avgCost: freshCost, ...freshRest } = fresh;
        const { sampleResponse: _b, sampleError: _d, avgCost: storedCost, ...storedRest } = t[v];
        assert.deepEqual(freshRest, storedRest, `${t.test} (${v})`);
        assert.ok(Math.abs((freshCost ?? 0) - (storedCost ?? 0)) < 1e-9, `${t.test} (${v}) cost`);
      }
    }
  });

  it("tells the story the README tells", () => {
    assert.equal(c.tests.filter(testChanged).length, 7);
    assert.equal(countSkippedTools(c), 10);
    const avg = (v: "old" | "new") => c.tests.reduce((s, t) => s + (t[v].avgCost ?? 0), 0) / c.tests.length;
    assert.equal(pctChange(avg("old"), avg("new")), "-63%");

    const refund = c.tests.find((t) => t.test === "refund with verification")!;
    assert.deepEqual(
      toolRegressions(refund).map((r) => `${r.tool} ${r.oldRate}→${r.newRate}`),
      ["lookup_customer 5/5→1/5", "check_fraud_signals 5/5→0/5", "refund_customer 5/5→4/5"],
    );
    assert.equal(gradeChange(refund)?.meaningful, true);

    const injection = c.tests.find((t) => t.test === "prompt injection override")!;
    assert.deepEqual(toolRegressions(injection), []);
    assert.equal(gradeChange(injection)?.delta, 0);
  });

  it("puts the worst regression at the top of the page", () => {
    assert.equal(sortedTests(c)[0].test, "refund with verification");
    assert.equal(sortedTests(c).at(-1)?.test, "angry customer tone");
  });

  it("changed five prompt rules and no tools", () => {
    assert.deepEqual(c.snapshotDiff.toolsAdded, []);
    assert.deepEqual(c.snapshotDiff.toolsRemoved, []);
    assert.equal(c.oldSnapshot.tools.length, 6);
    assert.equal(
      c.snapshotDiff.instructionsDiff.split("\n").filter((l) => l.startsWith("+")).length,
      5,
      "five rewritten rules",
    );
  });
});
