import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dominantSequence,
  failedSides,
  gradeChange,
  sequenceShift,
  testChanged,
  toolRateShifts,
  toolRegressions,
} from "../src/compare/signals.ts";
import { fmtMoney, fmtSequence, pctChange } from "../src/compare/format.ts";
import { comparison, side, test } from "./helpers.ts";
import { buildReport } from "../src/report/markdown.ts";
import { printSummary } from "../src/report/terminal.ts";
import { formatPrComment } from "../src/github/pull-request.ts";

describe("failedSides", () => {
  const dead = (error: string | null = "no credits") => side({}, { errors: 5, sampleError: error });
  it("names a side only when every one of its runs errored", () => {
    assert.deepEqual(
      failedSides(
        comparison({ tests: [test({ old: side({}), new: dead() }), test({ old: side({}), new: dead(null) })] }),
      ),
      [{ side: "new", runs: 10, error: "no credits" }],
    );
    assert.deepEqual(
      failedSides(comparison({ tests: [test({ old: dead(), new: dead() })] })).map((f) => f.side),
      ["old", "new"],
    );
  });
  it("tolerates a partly-failed side", () => {
    assert.deepEqual(failedSides(comparison({ tests: [test({ old: side({}), new: side({}, { errors: 4 }) })] })), []);
    assert.deepEqual(failedSides(comparison()), []);
  });
});

describe("pctChange", () => {
  it("formats a signed whole percentage", () => {
    assert.equal(pctChange(0.01, 0.0038), "-62%");
    assert.equal(pctChange(2, 3), "+50%");
    assert.equal(pctChange(2, 2), "+0%");
  });
  it("handles a zero or missing baseline", () => {
    assert.equal(pctChange(0, 0), "+0%");
    assert.equal(pctChange(0, 1), "new value");
    assert.equal(pctChange(null, 1), null);
    assert.equal(pctChange(1, null), null);
  });
});

describe("fmtMoney", () => {
  it("keeps four decimals under a cent so tiny run costs stay visible", () => {
    assert.equal(fmtMoney(0.0038), "$0.0038");
    assert.equal(fmtMoney(0.01), "$0.01");
    assert.equal(fmtMoney(null), "n/a");
  });
});

describe("toolRegressions", () => {
  it("flags a required tool whose call rate dropped", () => {
    const t = test({
      mustCallTools: ["lookup_customer", "refund_customer"],
      old: side({ lookup_customer: 5, refund_customer: 5 }),
      new: side({ lookup_customer: 1, refund_customer: 5 }),
    });
    assert.deepEqual(toolRegressions(t), [{ tool: "lookup_customer", oldRate: "5/5", newRate: "1/5" }]);
  });
  it("ignores rises and tools that are not required", () => {
    const t = test({
      mustCallTools: ["escalate"],
      old: side({ escalate: 2, lookup_customer: 5 }),
      new: side({ escalate: 5, lookup_customer: 0 }),
    });
    assert.deepEqual(toolRegressions(t), []);
  });
  it("skips a required tool neither side has stats for", () => {
    const t = test({ mustCallTools: ["ghost"], old: side({}), new: side({}) });
    assert.deepEqual(toolRegressions(t), []);
  });
});

describe("toolRateShifts", () => {
  it("treats 5/5 → 4/5 as a 20-point shift despite float rounding", () => {
    const t = test({ old: side({ refund_customer: 5 }), new: side({ refund_customer: 4 }) });
    assert.deepEqual(toolRateShifts(t), ["refund_customer"]);
  });
  it("ignores swings under 20 points", () => {
    const t = test({
      old: side({ lookup_customer: 10 }, { runs: 10 }),
      new: side({ lookup_customer: 9 }, { runs: 10 }),
    });
    assert.deepEqual(toolRateShifts(t), []);
  });
  it("counts a tool that only one side ever called", () => {
    const t = test({ old: side({}), new: side({ escalate: 5 }) });
    assert.deepEqual(toolRateShifts(t), ["escalate"]);
  });
});

describe("gradeChange", () => {
  it("is null unless both sides were graded", () => {
    assert.equal(gradeChange(test({ old: side({}, { avgGrade: 5 }) })), null);
  });
  it("calls a move of more than one point meaningful, anything less noise", () => {
    const at = (o: number, n: number) =>
      gradeChange(test({ old: side({}, { avgGrade: o }), new: side({}, { avgGrade: n }) }));
    assert.equal(at(5, 2)?.meaningful, true);
    assert.equal(at(5, 4)?.meaningful, false);
    assert.equal(at(3.4, 2.6)?.meaningful, false);
    assert.equal(at(2, 3.2)?.meaningful, true);
  });
});

describe("sequences", () => {
  const stats = (seqs: [string[], number][], runs = 5, errors = 0) =>
    side({}, { runs, errors, sequences: seqs.map(([seq, n]) => ({ seq, runs: n })) });

  it("formats a direct answer as (no tools)", () => {
    assert.equal(fmtSequence([]), "(no tools)");
    assert.equal(fmtSequence(["a", "b"]), "a → b");
  });
  it("reports the dominant sequence out of the runs that succeeded", () => {
    const d = dominantSequence(stats([[["lookup_customer"], 3]], 5, 1));
    assert.deepEqual(d, { seq: ["lookup_customer"], runs: 3, of: 4 });
    assert.equal(dominantSequence(side({})), null);
  });
  it("is quiet when the path is the same and still a majority on both sides", () => {
    const t = test({
      old: stats([[["lookup_customer", "refund_customer"], 5]]),
      new: stats([
        [["lookup_customer", "refund_customer"], 4],
        [[], 1],
      ]),
    });
    assert.equal(sequenceShift(t), null);
  });
  it("notices a reordering even when every tool still fires", () => {
    const t = test({
      old: stats([[["lookup_customer", "refund_customer"], 5]]),
      new: stats([[["refund_customer", "lookup_customer"], 5]]),
    });
    assert.deepEqual(sequenceShift(t), {
      old: "lookup_customer → refund_customer (5/5)",
      new: "refund_customer → lookup_customer (5/5)",
    });
  });
  it("notices the dominant path losing its majority", () => {
    const t = test({
      old: stats([[["lookup_customer"], 5]]),
      new: stats([
        [["lookup_customer"], 2],
        [[], 2],
        [["escalate"], 1],
      ]),
    });
    assert.notEqual(sequenceShift(t), null);
  });
});

describe("testChanged", () => {
  it("counts a tool-order-only change consistently in the dashboard, terminal, report and PR comment", () => {
    const sameRates = { search: 5, read: 5 };
    const t = test({
      test: "research",
      mustCallTools: ["search", "read"],
      old: side(sameRates, { sequences: [{ seq: ["search", "read"], runs: 5 }] }),
      new: side(sameRates, { sequences: [{ seq: ["read", "search"], runs: 5 }] }),
    });
    const c = comparison({ tests: [t] });
    assert.equal(testChanged(t), true);
    const report = buildReport(c, "");
    assert.match(report, /^## 1 of 1 test changed/);
    assert.match(formatPrComment(report), /1 of 1 test changed/);
    const output: string[] = [],
      log = console.log;
    try {
      console.log = (...args) => {
        output.push(args.join(" "));
      };
      printSummary(c, "", "report.md");
    } finally {
      console.log = log;
    }
    assert.match(output.join("\n"), /1 of 1 test\(s\) changed behaviour/);
    t.new.sequences = t.old.sequences;
    assert.equal(testChanged(t), false);
  });
  it("is false for an identical test", () => {
    const s = () => side({ lookup_customer: 5 }, { avgCost: 0.01, avgGrade: 4.8 });
    assert.equal(testChanged(test({ mustCallTools: ["lookup_customer"], old: s(), new: s() })), false);
  });
  it("is true on a cost move of 10% or more", () => {
    assert.equal(testChanged(test({ old: side({}, { avgCost: 0.01 }), new: side({}, { avgCost: 0.009 }) })), true);
    assert.equal(testChanged(test({ old: side({}, { avgCost: 0.01 }), new: side({}, { avgCost: 0.0095 }) })), false);
  });
  it("is true when the error count differs", () => {
    assert.equal(testChanged(test({ old: side({}), new: side({}, { errors: 1 }) })), true);
  });
  it("is true on a meaningful grade drop with no tool change", () => {
    assert.equal(testChanged(test({ old: side({}, { avgGrade: 4.8 }), new: side({}, { avgGrade: 3.0 }) })), true);
  });
});
