// A change counts only when it repeats: it has to move old → new in both halves
// of the runs, and not move between the old agent's own two halves.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareSides, confirm } from "../src/compare/confirm.ts";
import { confirmedChange, inconclusiveChange, severity } from "../src/compare/signals.ts";
import { changeKind } from "../src/compare/change-kind.ts";
import { checkRows } from "../src/compare/check-rows.ts";
import type { RunRecord, TestFile, Version } from "../src/types.ts";

const test: TestFile = { name: "refund", input: "refund me" };
const verdicts = { grades: [], checks: [] };

/** Ten runs of one version; `tools(run)` says what run N called and `reply(run)` whether it replied. */
function runs(
  version: Version,
  tools: (run: number) => string[],
  reply: (run: number) => boolean = () => true,
): RunRecord[] {
  return Array.from({ length: 10 }, (_, i) => ({
    test: "refund",
    version,
    run: i + 1,
    input: "refund me",
    tool_calls: tools(i + 1).map((tool) => ({ tool, input: null, output: null })),
    final_response: reply(i + 1) ? "done" : null,
    steps: 1,
    tokens: { input: 100, output: 10 },
    latency_ms: 100,
    error: null,
  }));
}

function verdict(old: RunRecord[], neu: RunRecord[], t: TestFile = test) {
  const o = { runs: old, model: "gpt-5.4" },
    n = { runs: neu, model: "gpt-5.4" };
  const full = compareSides(t, o, n, verdicts);
  full.confirmation = confirm(t, full, o, n, verdicts, 10);
  return full;
}

describe("confirm", () => {
  it("confirms a change that shows up in both halves", () => {
    const t = verdict(
      runs(
        "old",
        () => ["lookup"],
        () => false,
      ),
      runs(
        "new",
        () => ["lookup"],
        () => true,
      ),
    );
    assert.deepEqual(t.confirmation!.confirmed, ["reply", "path"]);
    assert.deepEqual(t.confirmation!.noise, []);
    assert.equal(confirmedChange(t), true);
    assert.equal(inconclusiveChange(t), false);
  });

  it("calls a change inconclusive when it only shows up in one half", () => {
    // The new agent refunds in runs 6–8 only: 3 of 10 overall, but 0 of 5 in the first half.
    const t = verdict(
      runs("old", () => ["lookup"]),
      runs("new", (r) => (r >= 6 && r <= 8 ? ["lookup", "refund"] : ["lookup"])),
    );
    assert.ok(t.confirmation!.second.includes("tool:refund"));
    assert.ok(!t.confirmation!.first.includes("tool:refund"));
    assert.deepEqual(t.confirmation!.confirmed, []);
    assert.equal(confirmedChange(t), false);
    assert.equal(inconclusiveChange(t), true);
  });

  it("doesn't confirm a signal the old agent also moves against itself", () => {
    // The old agent escalates in 3 of its first 5 runs and none of its last 5; the new one always does.
    const t = verdict(
      runs("old", (r) => (r <= 3 ? ["escalate"] : [])),
      runs("new", () => ["escalate"]),
    );
    assert.ok(t.confirmation!.first.includes("tool:escalate") && t.confirmation!.second.includes("tool:escalate"));
    assert.ok(t.confirmation!.noise.includes("tool:escalate"));
    assert.ok(!t.confirmation!.confirmed.includes("tool:escalate"));
  });

  it("sorts a regression that didn't repeat below one that did", () => {
    const required = { ...test, must_call_tools: ["lookup"] };
    const unsure = verdict(
      runs("old", () => ["lookup"]),
      runs("new", (r) => (r >= 6 && r <= 8 ? [] : ["lookup"])),
      required,
    );
    const sure = verdict(
      runs("old", () => ["lookup"]),
      runs("new", () => []),
      required,
    );
    assert.equal(inconclusiveChange(unsure), true);
    assert.ok(severity(sure) > severity(unsure));
  });

  it("confirms nothing when nothing moved", () => {
    const t = verdict(
      runs("old", () => ["lookup"]),
      runs("new", () => ["lookup"]),
    );
    assert.deepEqual(t.confirmation, { first: [], second: [], noise: [], confirmed: [] });
    assert.equal(confirmedChange(t), false);
    assert.equal(inconclusiveChange(t), false);
  });

  it("counts a run time that moved 25% and a full second in both halves, and not a smaller one", () => {
    const timed = (version: Version, ms: (run: number) => number) =>
      runs(version, () => ["lookup"]).map((r) => ({ ...r, latency_ms: ms(r.run) }));
    const slower = verdict(
      timed("old", () => 2000),
      timed("new", () => 4000),
    );
    assert.deepEqual(slower.confirmation!.confirmed, ["latency"]);
    assert.equal(changeKind(slower), "different");
    assert.deepEqual(
      verdict(
        timed("old", () => 200),
        timed("new", () => 900),
      ).confirmation!.confirmed,
      [],
    );
    // Slower in the second half only: run time that didn't repeat is provider jitter, not a change of any kind.
    const once = verdict(
      timed("old", () => 2000),
      timed("new", (n) => (n > 5 ? 8000 : 2000)),
    );
    assert.deepEqual(once.confirmation!.confirmed, []);
    assert.equal(inconclusiveChange(once), false);
    assert.equal(changeKind(once), "same");
  });

  it("doesn't call one judge answering one run differently a shifted check", () => {
    const four = (version: Version) => runs(version, () => ["lookup"]).filter((r) => r.run <= 4);
    const answers = (version: Version, yes: number[]) =>
      four(version).map((r) => ({
        test: "refund",
        version,
        run: r.run,
        answers: { verified: { type: "yes_no" as const, probability: yes.includes(r.run) ? 1 : 0 } },
      }));
    const shifted = (newYes: number[]) => {
      const judged = { grades: [], checks: [...answers("old", [1, 2, 3, 4]), ...answers("new", newYes)] };
      const asked = { ...test, checks: { verified: "Did it verify the customer?" } };
      return checkRows(
        compareSides(asked, { runs: four("old"), model: "m" }, { runs: four("new"), model: "m" }, judged),
      )[0].shifted;
    };
    assert.equal(shifted([1, 2, 3]), false, "yes 4/4 → 3/4: one run");
    assert.equal(shifted([1, 2]), true, "yes 4/4 → 2/4: two runs");
  });
});
