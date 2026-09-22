// What the comparisons page derives from a saved comparison.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoveryFindings, factsOf, promptChanges, runStatus, verdict } from "../web/src/review/model.ts";
import { foldedSteps } from "../web/src/review/tree.ts";
import { pathDiff, shiftGroups, tableRows } from "../web/src/review/groups.ts";
import type { RunRecord } from "../src/types.ts";
import { comparison, run, side, snapshot, test } from "./helpers.ts";

const path = (...seq: string[]) => [{ seq, runs: 3 }];

describe("runStatus", () => {
  const t = test({
    mustCallTools: ["lookup"],
    mustNotCallTools: ["send_sms"],
    old: side({ lookup: 3 }, { sequences: path("lookup", "check_policy", "charge") }),
    new: side({}),
  });
  const newRun = (tools: string[], over: Partial<RunRecord> = {}) => run(tools, { version: "new", ...over });
  it("names a broken rule, a low grade, the old path, or a different one", () => {
    assert.equal(runStatus(t, newRun(["lookup", "send_sms"]), []), "rule", "forbidden tool");
    assert.equal(runStatus(t, newRun(["charge"]), []), "rule", "required tool skipped");
    assert.equal(
      runStatus(t, newRun(["lookup", "charge"]), ["charge"]),
      "rule",
      "a write tool without a step that used to come first",
    );
    assert.equal(
      runStatus(t, newRun(["lookup", "refund"]), ["refund"]),
      "rule",
      "a write tool the old agent never called",
    );
    assert.equal(runStatus(t, newRun(["lookup", "check_policy", "charge"]), ["charge"], 2), "low");
    assert.equal(runStatus(t, newRun(["lookup", "check_policy", "charge"]), ["charge"]), "same");
    assert.equal(runStatus(t, newRun(["lookup", "check_policy", "charge", "email"]), ["charge"]), "different");
    assert.equal(runStatus(t, newRun([], { error: "boom" }), []), "error");
    assert.equal(runStatus(t, run(["lookup"], { version: "old" }), []), "old");
  });
});

describe("foldedSteps", () => {
  it("folds repeats into one step", () => {
    assert.deepEqual(
      foldedSteps(run(["search", "search", "read"])).map((s) => [s.step, s.count]),
      [
        ["search", 2],
        ["read", 1],
      ],
    );
  });
});

describe("pathDiff", () => {
  const line = (l: ReturnType<typeof pathDiff>[number]) =>
    `${l.sign}${l.text}${l.old === l.new ? "" : ` ${l.old}/${l.new}`}`;
  it("lists shared steps once and marks the ones only one side took", () => {
    assert.deepEqual(pathDiff(["profile", "policy", "search", "hold"], ["search", "hold", "charge"]).map(line), [
      "-profile 1/0",
      "-policy 1/0",
      " search",
      " hold",
      "+charge 0/1",
    ]);
  });
  it("folds repeats and shows a count that moved on a shared step", () => {
    assert.deepEqual(
      pathDiff(["search", "search", "rules", "rules", "rules"], ["search", "search", "search"]).map(line),
      [" search 2/3", "-rules 3/0"],
    );
  });
  it("keeps a check's answer, so a flipped answer reads as one out and one in", () => {
    assert.deepEqual(pathDiff(["?gate=yes", "reply_tool"], ["?gate=no", "reply_tool"]).map(line), [
      "-gate: yes 1/0",
      "+gate: no 0/1",
      " reply_tool",
    ]);
  });
  it("leaves out the no-reply ending", () => {
    assert.deepEqual(pathDiff(["triage", "(no reply)"], ["triage"]).map(line), [" triage"]);
  });
});

describe("shiftGroups", () => {
  const optOut = (probability: number) => ({
    id: "opt_out",
    type: "boolean" as const,
    instructions: "opt_out",
    source: "guardrail" as const,
    answer: { type: "boolean" as const, probability },
    after: 0,
  });
  const asked = {
    opt_out: {
      type: "boolean" as const,
      source: "guardrail" as const,
      instructions: "opt_out",
      runs: 5,
      runsAsking: 5,
      asks: 5,
      yes: 5,
    },
  };
  const silentThenReplies = (name: string) =>
    test({
      test: name,
      old: side({}, { replied: { runs: 0, of: 5 }, decisions: asked }),
      new: side({}, { replied: { runs: 5, of: 5 } }),
    });
  const c = comparison({
    oldSnapshot: snapshot({
      instructions: "Keep it short.\nCall send only after a YES.",
      settings: { inputGuardrails: ["opt_out"] },
    }),
    newSnapshot: snapshot({
      instructions: "Reply to every message.\nSend right away.",
      settings: { inputGuardrails: [] },
    }),
    tests: [
      silentThenReplies("STOP"),
      silentThenReplies("thanks"),
      test({ test: "no yes", mustNotCallTools: ["send"], old: side({ send: 0 }), new: side({ send: 5 }) }),
      test({ test: "same" }),
    ],
  });
  const traces = {
    old: [
      run([], { test: "STOP", version: "old", final_response: null, decisions: [optOut(1)] }),
      run([], { test: "thanks", version: "old", final_response: null, decisions: [optOut(0)] }),
    ],
    new: [],
  };
  const groups = shiftGroups(c, traces);
  it("lists a broken test rule first and puts tests that moved the same way under one shift", () => {
    assert.deepEqual(
      groups.map((g) => [g.title, g.rows.map((r) => r.test.test), g.rate]),
      [
        ["Calls send, which the test forbids", ["no yes"], { old: "0/5", new: "5/5" }],
        ["Replies where it used to send nothing", ["STOP", "thanks"], { old: "0/5", new: "5/5" }],
      ],
    );
  });
  it("names the removed guardrail that stopped the old runs, and the edits that mention it", () => {
    const replies = groups[1];
    assert.deepEqual(replies.rows[0].tripped, [{ id: "opt_out", side: "old", runs: 1, of: 1 }]);
    assert.deepEqual(replies.rows[1].tripped, [], "a guardrail that passed didn't stop anything");
    assert.deepEqual(replies.related.lines, [{ sign: "+", text: "Reply to every message." }]);
    assert.deepEqual(replies.related.other, ['inputGuardrails: ["opt_out"] → []']);
  });
  it("lists every test flat for the table: changed tests in shift order with their edits, then the rest", () => {
    const rows = tableRows(c, traces);
    assert.deepEqual(
      rows.map((r) => [r.test.test, r.kind, r.shift?.title ?? null]),
      [
        ["no yes", "rule", "Calls send, which the test forbids"],
        ["STOP", "different", "Replies where it used to send nothing"],
        ["thanks", "different", "Replies where it used to send nothing"],
        ["same", "same", null],
      ],
    );
    assert.deepEqual(rows[1].related, groups[1].related, "each row carries its group's edits");
  });
});

describe("promptChanges", () => {
  it("groups a team's changed lines under the agent they belong to", () => {
    const c = comparison({
      oldSnapshot: snapshot({
        instructions: "## concierge\nCheck policy.\nBe kind.\n\n## payments\nCharge once everything is held.",
      }),
      newSnapshot: snapshot({ instructions: "## concierge\nBe kind.\n\n## payments\nCharge each hold right away." }),
    });
    assert.deepEqual(promptChanges(c), [
      { agent: "concierge", lines: [{ sign: "-", text: "Check policy." }] },
      {
        agent: "payments",
        lines: [
          { sign: "-", text: "Charge once everything is held." },
          { sign: "+", text: "Charge each hold right away." },
        ],
      },
    ]);
  });
});

describe("facts and the verdict", () => {
  it("leads with the biggest drop, and says how many tests broke a rule", () => {
    const t = test({
      mustCallTools: ["a", "b"],
      old: side({ a: 3, b: 3 }, { runs: 3 }),
      new: side({ a: 2, b: 0 }, { runs: 3 }),
    });
    const c = comparison({ tests: [t, test({ test: "same" })] });
    assert.equal(factsOf(c, t)[0], "skips b: called in 3/3 → 0/3 runs");
    assert.equal(verdict(c), "Your new agent broke a rule in 1 of 2 tests.");
  });
});

describe("discoveryFindings", () => {
  const optOut = (version: "old" | "new", tools: string[], over: Partial<RunRecord> = {}): RunRecord =>
    run(tools, {
      version,
      ...(version === "old"
        ? {
            decisions: [
              {
                id: "opt_out",
                type: "boolean",
                instructions: "opt_out",
                source: "guardrail",
                answer: { type: "boolean", probability: 0 },
                after: 0,
              },
            ],
          }
        : {}),
      ...over,
    });
  const silent = { final_response: null };
  const kase = (
    input: string,
    context: Record<string, unknown>,
    old: RunRecord[],
    neu: RunRecord[],
    expected = "",
  ) => ({ input, context, expected, old, new: neu, difference: null });
  const finding = (name: string, cases: unknown[]) => ({
    id: name,
    experimentId: "e1",
    originalExperimentId: "e1",
    probe: { name },
    cases,
    reproducedCases: [0, 1],
    shortened: false,
    kinds: ["worse", "better"],
  });
  // The new agent no longer runs opt_out, in the suite as here.
  const tests = [test({ old: side({}, { decisions: { opt_out: { runsAsking: 5 } } } as never), new: side({}) })];
  const c = comparison({
    tests,
    discovery: {
      status: "complete",
      findings: [
        finding("late reminder", [
          kase(
            "Remind me",
            { now: "19:59", do_not_contact: false },
            [optOut("old", ["schedule"])],
            [optOut("new", ["schedule"])],
          ),
          kase(
            "Remind me",
            { now: "20:00", do_not_contact: false },
            [optOut("old", ["schedule"])],
            [optOut("new", ["schedule"])],
          ),
        ]),
        finding("thanks", [
          kase("thanks!", {}, [optOut("old", [], silent)], [optOut("new", ["triage"])], "Send nothing."),
          kase("thank you", {}, [optOut("old", [], silent)], [optOut("new", ["triage"])]),
        ]),
      ],
      experiments: [],
      notices: [],
      agentRuns: 8,
      plannerCalls: 1,
      changes: [],
    } as never,
  });
  it("leaves out checks only one agent runs, so a finding made of them alone doesn't count", () => {
    const [late, thanks] = discoveryFindings(c);
    assert.equal(late.differs, false, "same tool calls and reply; only the removed opt_out check differs");
    assert.equal(late.cases[0].old.path, late.cases[0].new.path);
    assert.equal(thanks.differs, true);
    assert.deepEqual([thanks.cases[0].old.path, thanks.cases[0].new.path], ["no reply", "triage → reply"]);
    assert.deepEqual([thanks.cases[0].kind, thanks.cases[0].expected], ["worse", "Send nothing."]);
  });
  it("names the one detail the two cases differ in", () => {
    const [late, thanks] = discoveryFindings(c);
    assert.equal(late.sameMessage, true);
    assert.deepEqual(
      late.cases.map((cs) => cs.context),
      [["now: 19:59"], ["now: 20:00"]],
      "do_not_contact is the same in both, so it isn't shown",
    );
    assert.equal(thanks.sameMessage, false);
  });
});
