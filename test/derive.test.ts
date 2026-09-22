import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fmtMs, missingRequired, severity, sortedTests } from "../web/src/data/derive.ts";
import { comparison, run, side, test } from "./helpers.ts";

describe("severity", () => {
  it("ranks skipped required tools above grade drops, and noise at zero", () => {
    const skipped = test({ mustCallTools: ["a"], old: side({ a: 5 }), new: side({ a: 0 }) });
    const graded = test({ old: side({}, { avgGrade: 5 }), new: side({}, { avgGrade: 2 }) });
    const noise = test({ old: side({}, { avgGrade: 5 }), new: side({}, { avgGrade: 4.6 }) });
    assert.equal(severity(skipped), 10);
    assert.equal(severity(graded), 3);
    assert.equal(severity(noise), 0);
    const c = comparison({ tests: [noise, graded, skipped] });
    assert.deepEqual(sortedTests(c), [skipped, graded, noise]);
  });
});

describe("missingRequired", () => {
  it("names the required tools a run skipped", () => {
    const t = test({ mustCallTools: ["lookup_customer", "refund_customer"] });
    assert.deepEqual(missingRequired(t, run(["refund_customer"])), ["lookup_customer"]);
    assert.deepEqual(missingRequired(t, run(["lookup_customer", "refund_customer"])), []);
  });
});

describe("fmtMs", () => {
  it("switches to seconds at 1000ms", () => {
    assert.equal(fmtMs(999.4), "999ms");
    assert.equal(fmtMs(2312.37), "2.3s");
    assert.equal(fmtMs(null), "n/a");
  });
});
