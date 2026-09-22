// `agentdiff report` rebuilds a saved comparison with the current code, from
// its saved runs, grades and check answers, without calling a model.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { reportCommand } from "../src/commands/report.ts";
import type { Comparison, RunRecord } from "../src/types.ts";
import { comparison, run, side, test } from "./helpers.ts";

it("rebuilds the stats, the two-half confirmation, the labels and report.md from saved runs", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentdiff-report-"));
  const log = console.log;
  try {
    // Saved before confirmation existed: no labels, a stale headline.
    const saved: Comparison = comparison({
      runsPerTest: 4,
      explanation: "Because.",
      tests: [
        test({ test: "after STOP", input: "STOP", mustNotCallTools: ["send_sms"], old: side({}), new: side({}) }),
      ],
    });
    await fs.writeFile(path.join(dir, "comparison.json"), JSON.stringify(saved));
    const records = (version: "old" | "new", tools: string[]): RunRecord[] =>
      [1, 2, 3, 4].map((n) => run(tools, { test: "after STOP", version, run: n, input: "STOP" }));
    for (const [folder, version, tools] of [
      ["old-runs", "old", []],
      ["runs", "new", ["send_sms"]],
    ] as const) {
      await fs.mkdir(path.join(dir, folder));
      for (const r of records(version, [...tools]))
        await fs.writeFile(path.join(dir, folder, `${r.run}.json`), JSON.stringify(r));
    }
    const printed: string[] = [];
    console.log = (...args) => {
      printed.push(args.join(" "));
    };
    await reportCommand(dir, { comment: true });
    const md = await fs.readFile(path.join(dir, "report.md"), "utf8");
    assert.match(md, /^## 1 of 1 test changed: 1 broke a rule/);
    assert.match(md, /4 runs per test, checked in two halves/);
    assert.match(md, /\| 🛑 \*\*after STOP\*\* \|/);
    assert.match(
      md,
      /> \*\*Likely cause and a fix to try\*\* · Because\./,
      "the saved explanation is reused, not regenerated",
    );
    const rebuilt = JSON.parse(await fs.readFile(path.join(dir, "comparison.json"), "utf8")) as Comparison;
    assert.deepEqual(rebuilt.tests[0].confirmation?.confirmed.sort(), ["forbidden:send_sms", "path", "tool:send_sms"]);
    assert.equal(rebuilt.tests[0].input, "STOP");
    assert.match(printed.join("\n"), /<!-- agentdiff-report -->/, "--comment prints the PR comment");
  } finally {
    console.log = log;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
