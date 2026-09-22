// The markdown report is also the PR comment, so its shape is a contract:
// one headline with the numbers, the chart, one table (worst test first), a
// two-line legend, the cause as a quote, and everything else folded away.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { comparedLabel, formatPrComment } from "../src/github/pull-request.ts";
import { buildReport } from "../src/report/markdown.ts";
import type { Comparison } from "../src/types.ts";
import { comparison, side, snapshot, test } from "./helpers.ts";

const demo: Comparison = JSON.parse(
  readFileSync(new URL("./fixtures/support-demo.json", import.meta.url), "utf8"),
).comparison;

const lines = (md: string) => md.split("\n");
const tableRows = (md: string) => lines(md).filter((l) => l.startsWith("| ") && !l.startsWith("| test"));

describe("buildReport", () => {
  const md = buildReport(demo, "Because.");

  it("leads with the numbers that matter", () => {
    assert.equal(lines(md)[0], "## 7 of 7 tests changed: 5 broke a rule · 10 required tool calls skipped · cost -63%");
    assert.match(lines(md)[2], /^support-agent · gpt-5\.4 · `.+` → `.+` · 5 runs per test$/);
  });

  it("puts the chart right under the headline", () => {
    const img = lines(md).findIndex((l) => l.startsWith("![") && l.includes("quickchart.io"));
    assert.ok(img > 0 && img < 6, `chart at line ${img}`);
  });

  it("lists every test once, worst first, with regressions in bold", () => {
    const rows = tableRows(md);
    // Two tables: the visible one and the folded numbers one.
    assert.equal(rows.length, demo.tests.length * 2);
    assert.match(
      rows[0],
      /^\| 🛑 \*\*refund with verification\*\* \| `lookup_customer` 5\/5 → \*\*1\/5\*\*<br>`check_fraud_signals` 5\/5 → \*\*0\/5\*\*/,
    );
    assert.match(rows[0], /↳ \*\*refund_customer \(4\/5\)\*\*/);
    assert.match(rows[0], /\| 5\.0 → \*\*2\.0\*\* \|$/);
    assert.match(rows[demo.tests.length - 1], /^\| • angry customer tone \| – \|/);
  });

  it("does not bold a grade move inside the noise band", () => {
    const row = tableRows(md).find((l) => l.includes("chargeback extortion"))!;
    assert.match(row, /\| 5\.0 → 4\.8 \|$/);
  });

  it("says nothing it used to say in prose", () => {
    for (const phrase of ["(observed)", "possibly noise", "## Summary", "# AgentDiff Report", "REGRESSION"]) {
      assert.ok(!md.includes(phrase), phrase);
    }
  });

  it("quotes the cause and folds the diff and the numbers", () => {
    assert.ok(md.includes("> **Likely cause and a fix to try** · Because."));
    assert.ok(md.includes("<summary>Prompt diff · 10 lines</summary>"));
    assert.ok(md.includes("<summary>Cost · steps · latency per test</summary>"));
    assert.ok(md.includes("| refund with verification | $0.01 → $0.0038 | 4.0 → 2.0 | 5.9s → 2.3s |"));
  });

  it("keeps a multi-paragraph cause inside the quote", () => {
    const two = buildReport(demo, "One.\n\nTwo.");
    assert.ok(two.includes("> **Likely cause and a fix to try** · One.\n> \n> Two."));
  });

  it("drops the grade and path columns when there is nothing to show", () => {
    const c = comparison({
      tests: [
        test({
          mustCallTools: ["lookup_customer"],
          old: side({ lookup_customer: 5 }),
          new: side({ lookup_customer: 5 }),
        }),
      ],
    });
    const md = buildReport(c, "");
    assert.ok(md.includes("| test | required tools called |\n|---|---|\n| refund | `lookup_customer` 5/5 → 5/5 |"));
    assert.ok(md.startsWith("## 0 of 1 test changed\n"));
    assert.ok(md.includes("Prompt unchanged."));
  });

  it("names model and setting changes on the meta line", () => {
    const c = comparison({
      oldSnapshot: snapshot(),
      newSnapshot: snapshot({ model: "gpt-5.3", settings: { maxSteps: 8 } }),
    });
    const meta = lines(buildReport(c, "")).slice(2, 4).join("\n");
    assert.equal(
      meta,
      "support-agent · `./agents/support-v1.ts` → `./agents/support-v2.ts` · 5 runs per test\n<br>model `gpt-5.4` → `gpt-5.3` · maxSteps 5 → 8",
    );
  });

  it("never calls an all-errored run 'nothing changed'", () => {
    const dead = side({}, { errors: 5, avgLatencyMs: 4500, sampleError: "You have no credits remaining.\n  at fetch" });
    const c = comparison({
      tests: [
        test({ test: "refund", mustCallTools: ["lookup_customer"], old: side({ lookup_customer: 5 }), new: dead }),
        test({ test: "cancel", mustCallTools: ["lookup_customer"], old: side({ lookup_customer: 5 }), new: dead }),
      ],
    });
    const md = buildReport(c, "");
    assert.ok(md.startsWith("## all 10 new runs errored — nothing to compare\n"), md.split("\n")[0]);
    assert.ok(md.includes("> **new side** · You have no credits remaining."));
    for (const phrase of ["0 of 2", "| test |", "quickchart", "Likely cause", "steps · latency"]) {
      assert.ok(!md.includes(phrase), phrase);
    }
    assert.ok(md.includes("Prompt unchanged."));
  });

  it("shortens a git sha in the file label", () => {
    const c = comparison({
      oldFile: "./agents/support.ts @ 25008dcf0e3c1f2b4a5d6e7f8091a2b3c4d5e6f7",
      newFile: "./agents/support.ts (working tree)",
    });
    assert.ok(buildReport(c, "").includes("`./agents/support.ts @ 25008dc` → `./agents/support.ts (working tree)`"));
  });
});

describe("confirmation in the report", () => {
  const moved = () => test({ old: side({ refund: 0 }), new: side({ refund: 3 }) });
  it("counts only confirmed changes, marks the rest inconclusive, and says how noisy the old agent was", () => {
    const unsure = {
      ...moved(),
      test: "unsure",
      confirmation: { first: [], second: ["tool:refund"], noise: [], confirmed: [] },
    };
    const real = {
      ...moved(),
      test: "real",
      confirmation: { first: ["tool:refund"], second: ["tool:refund"], noise: [], confirmed: ["tool:refund"] },
    };
    const noisy = {
      ...test({ test: "noisy" }),
      confirmation: { first: [], second: [], noise: ["path"], confirmed: [] },
    };
    const md = buildReport(comparison({ tests: [unsure, real, noisy] }), "");
    assert.equal(lines(md)[0], "## 1 of 3 tests changed · 1 inconclusive");
    assert.match(md, /5 runs per test, checked in two halves/);
    assert.ok(md.includes("<br>noise · the old agent against itself moved in 1 of 3: noisy (path)"));
    const rows = tableRows(md);
    assert.ok(rows.some((r) => r.startsWith("| • real")));
    assert.ok(rows.some((r) => r.startsWith("| ❔ unsure")));
    assert.match(md, /❔ moved in only one half of the runs/);
  });

  it("says no test moved when the old agent was stable", () => {
    const md = buildReport(
      comparison({
        tests: [
          {
            ...moved(),
            confirmation: { first: ["tool:refund"], second: ["tool:refund"], noise: [], confirmed: ["tool:refund"] },
          },
        ],
      }),
      "",
    );
    assert.ok(md.includes("<br>noise · the old agent against itself: no test moved"));
  });
});

describe("stages in the report", () => {
  it("says which stages were blocked, under the headline, and drops an empty cause", () => {
    const c = comparison({
      stages: [
        { stage: "run", status: "done", detail: "12 of 12 runs finished", ms: 1 },
        {
          stage: "judge",
          status: "blocked",
          detail: "0 grades, 0 runs checked; missing checks (no AI Gateway key)",
          ms: 1,
        },
        { stage: "explain", status: "blocked", detail: "no OpenAI key to write the explanation", ms: 1 },
      ],
    });
    const md = buildReport(c, "");
    const note = lines(md).find((l) => l.startsWith("<br>⚠️ incomplete"));
    assert.equal(
      note,
      "<br>⚠️ incomplete · judge blocked: 0 grades, 0 runs checked; missing checks (no AI Gateway key) · explain blocked: no OpenAI key to write the explanation",
    );
    assert.ok(lines(md).indexOf(note!) < 5);
    assert.ok(!md.includes("Likely cause"));
  });

  it("adds nothing when every stage ran", () => {
    const md = buildReport(
      comparison({ stages: [{ stage: "judge", status: "done", detail: "6 grades", ms: 1 }] }),
      "Because.",
    );
    assert.ok(!md.includes("incomplete"));
    assert.ok(md.includes("> **Likely cause and a fix to try** · Because."));
  });
});

describe("formatPrComment", () => {
  it("wraps the report in the marker and a one-line footer, with the PR as the new side", () => {
    const md = formatPrComment(buildReport(demo, "Because.", { compared: comparedLabel("main") }));
    const L = lines(md);
    assert.equal(L[0], "<!-- agentdiff-report -->");
    assert.equal(L[1], "## 7 of 7 tests changed: 5 broke a rule · 10 required tool calls skipped · cost -63%");
    assert.equal(L[3], "support-agent · gpt-5.4 · `main` → this PR · 5 runs per test");
    assert.ok(!md.includes("Compared `main`"));
    assert.match(L[L.length - 2], /^<sub>\[agentdiff\]\(.+\) re-runs this on every push/);
  });
});
