// Each test gets one label, most serious first: broke a rule, worse, better, a
// different path to the same outcome, inconclusive, or the same.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { actedEarly, changeKind, ruleBreaks, sortedTests } from "../src/compare/change-kind.ts";
import type { CheckStats } from "../src/types.ts";
import { comparison, side, test } from "./helpers.ts";

const path = (...seq: string[]) => [{ seq, runs: 5 }];
const failures = (none: number): Record<string, CheckStats> => ({
  failure_type: {
    question: "What went wrong?",
    kind: "choice",
    options: ["none", "skipped_step"],
    counts: { none, skipped_step: 5 - none },
    of: 5,
  },
});
const writes = ["hold_seat", "charge"];

describe("actedEarly", () => {
  it("names the steps a write tool now runs without", () => {
    const t = test({
      old: side(
        {},
        { sequences: path("get_traveler_profile", "check_trip_policy", "?breaks_policy=no", "hold_seat", "charge") },
      ),
      new: side({}, { sequences: path("hold_seat", "charge") }),
    });
    assert.deepEqual(actedEarly(t, writes), [
      { tool: "hold_seat", skipped: ["get_traveler_profile", "check_trip_policy", "breaks_policy"] },
      { tool: "charge", skipped: ["get_traveler_profile", "check_trip_policy", "breaks_policy"] },
    ]);
    assert.equal(changeKind(t, writes), "rule");
    assert.deepEqual(ruleBreaks(t, writes), [
      "`hold_seat` without `get_traveler_profile`, `check_trip_policy`, `breaks_policy` first",
      "`charge` without `get_traveler_profile`, `check_trip_policy`, `breaks_policy` first",
    ]);
  });

  it("ignores a write tool that still follows the same steps, and one the old agent never called", () => {
    const t = test({
      old: side({}, { sequences: path("lookup", "hold_seat") }),
      new: side({}, { sequences: path("lookup", "search", "hold_seat", "charge") }),
    });
    assert.deepEqual(actedEarly(t, writes), []);
  });

  it("leaves out a check only one version has", () => {
    const t = test({
      oneSidedChecks: ["should_reply"],
      old: side({}, { sequences: path("?should_reply=passed", "lookup", "charge") }),
      new: side({}, { sequences: path("lookup", "charge") }),
    });
    assert.deepEqual(actedEarly(t, writes), []);
  });
});

describe("changeKind", () => {
  it("calls a forbidden tool called more often a broken rule", () => {
    const t = test({ mustNotCallTools: ["send_sms"], old: side({ send_sms: 0 }), new: side({ send_sms: 3 }) });
    assert.equal(changeKind(t), "rule");
  });

  it("calls a write tool called more often a broken rule", () => {
    const t = test({ old: side({ charge: 0 }), new: side({ charge: 4 }) });
    assert.equal(changeKind(t, writes), "rule");
    assert.equal(changeKind(t), "different", "without writeTools, charge is just another tool");
    // "change after YES": the traveler confirmed, so a required write tool called more often is the test passing more often.
    const required = test({ mustCallTools: ["charge"], old: side({ charge: 3 }), new: side({ charge: 5 }) });
    assert.notEqual(changeKind(required, writes), "rule");
  });

  it("reads worse and better from the grade and the runs with nothing wrong", () => {
    assert.equal(changeKind(test({ old: side({}, { avgGrade: 4.8 }), new: side({}, { avgGrade: 2.1 }) })), "worse");
    assert.equal(
      changeKind(test({ old: side({}, { checks: failures(5) }), new: side({}, { checks: failures(1) }) })),
      "worse",
    );
    // The stranded traveler: the old agent's draft review silenced it; the new one answers.
    const stranded = test({
      old: side({}, { avgGrade: 1.0, replied: { runs: 0, of: 5 }, checks: failures(0) }),
      new: side({}, { avgGrade: 4.7, replied: { runs: 5, of: 5 }, checks: failures(5) }),
    });
    assert.equal(changeKind(stranded), "better");
  });

  it("calls a new path with the same outcome a difference", () => {
    const t = test({
      old: side({}, { sequences: path("lookup", "search"), avgGrade: 4.8 }),
      new: side({}, { sequences: path("search", "lookup"), avgGrade: 4.7 }),
    });
    assert.equal(changeKind(t), "different");
  });

  it("uses only confirmed signals when the runs were checked in halves", () => {
    const t = test({
      mustNotCallTools: ["send_sms"],
      old: side({ send_sms: 0 }),
      new: side({ send_sms: 3 }),
      confirmation: { first: [], second: ["forbidden:send_sms", "tool:send_sms"], noise: [], confirmed: [] },
    });
    assert.equal(changeKind(t), "inconclusive");
    t.confirmation = { first: ["tool:send_sms"], second: ["tool:send_sms"], noise: [], confirmed: ["tool:send_sms"] };
    assert.equal(changeKind(t), "different", "a confirmed rate move on a tool nobody forbade isn't a rule break");
  });

  it("sorts rule breaks first, then worse, better, differences, inconclusive and unchanged", () => {
    const tests = [
      test({ test: "same" }),
      test({
        test: "unsure",
        old: side({ x: 0 }),
        new: side({ x: 3 }),
        confirmation: { first: [], second: ["tool:x"], noise: [], confirmed: [] },
      }),
      test({ test: "better", old: side({}, { avgGrade: 2 }), new: side({}, { avgGrade: 4.5 }) }),
      test({ test: "rule", mustNotCallTools: ["x"], old: side({ x: 0 }), new: side({ x: 3 }) }),
      test({ test: "different", old: side({ y: 0 }), new: side({ y: 3 }) }),
      test({ test: "worse", old: side({}, { avgGrade: 4.5 }), new: side({}, { avgGrade: 2 }) }),
    ];
    assert.deepEqual(
      sortedTests(comparison({ tests })).map((t) => t.test),
      ["rule", "worse", "better", "different", "unsure", "same"],
    );
  });
});
