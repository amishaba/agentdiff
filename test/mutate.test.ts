// Mutation testing: seed regressions into the agent's source, one rule sentence
// or guardrail at a time, and count the ones the tests catch.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { byRelevance, mutants, pick } from "../src/mutate/mutants.ts";
import { runCheck } from "../src/pipeline/check.ts";
import { ruleSentences } from "../src/agent/rules.ts";
import { runMutation } from "../src/mutate/run.ts";
import { mutationReport } from "../src/mutate/report.ts";

const SOURCE = `export const desk = new Agent({
  instructions: [
    "Be brief.",
    "Never refund before lookup_customer.",
    "REFUNDS: call lookup_customer first. Then refund the order.",
  ].join("\\n"),
  inputGuardrails: [optOut, ownsThread],
});
`;
const INSTRUCTIONS = [
  "Be brief.",
  "Never refund before lookup_customer.",
  "REFUNDS: call lookup_customer first. Then refund the order.",
].join("\n");

describe("seeded regressions", () => {
  it("finds rule sentences, not their topic labels or plain sentences", () => {
    assert.deepEqual(ruleSentences("REFUNDS: call lookup_customer first. Then refund the order."), [
      "call lookup_customer first.",
    ]);
    assert.deepEqual(ruleSentences("Be brief."), []);
    assert.deepEqual(ruleSentences("## payments_agent"), []);
  });

  it("removes one guardrail or one rule sentence per copy, and keeps the source valid", () => {
    const found = mutants(SOURCE, INSTRUCTIONS);
    assert.deepEqual(
      found.map((m) => [m.kind, m.removed]),
      [
        ["guardrail", "optOut (inputGuardrails)"],
        ["guardrail", "ownsThread (inputGuardrails)"],
        ["rule", "Never refund before lookup_customer."],
        ["rule", "call lookup_customer first."],
      ],
    );
    assert.match(found[0].source, /inputGuardrails: \[ownsThread\]/);
    // A whole array element goes, comma and line included.
    assert.equal(found[2].source, SOURCE.replace('    "Never refund before lookup_customer.",\n', ""));
    // A sentence inside a longer string goes with one space.
    assert.match(found[3].source, /"REFUNDS: Then refund the order\.",/);
  });

  it("leaves an empty string, not a syntax error, when the whole prompt is one sentence", () => {
    const [m] = mutants('const prompt = "Never refund twice.";\n', "Never refund twice.");
    assert.equal(m.source, 'const prompt = "";\n');
  });

  it("skips a sentence the source doesn't hold word for word", () => {
    assert.deepEqual(
      mutants('const a = { instructions: "x" };', "Never do it.").map((m) => m.removed),
      [],
    );
  });

  it("spreads a capped pick across the list", () => {
    assert.deepEqual(pick([1, 2, 3, 4, 5, 6], 3), [1, 3, 5]);
    assert.deepEqual(pick([1, 2], 3), [1, 2]);
  });
});

describe("agentdiff mutate", () => {
  it("counts the copies a test catches and reports the ones nothing caught", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentdiff-mutate-"));
    await fs.mkdir(path.join(dir, "tests"));
    await fs.writeFile(
      path.join(dir, "tests/refund.json"),
      JSON.stringify({ name: "refund", input: "refund order 7", must_call_tools: ["lookup_customer", "refund"] }),
    );
    // The function agent reads its own prompt: drop the lookup rule and it refunds without looking up.
    await fs.writeFile(
      path.join(dir, "agent.mjs"),
      `const instructions = [
  "Call lookup_customer before refund.",
  "Never mention the weather.",
].join("\\n");
export const agent = {
  instructions,
  tools: ["lookup_customer", "refund"],
  run: async () => ({
    text: "Refunded.",
    toolCalls: instructions.includes("lookup_customer before") ? [{ tool: "lookup_customer" }, { tool: "refund" }] : [{ tool: "refund" }],
  }),
};
`,
    );
    await fs.writeFile(
      path.join(dir, "agentdiff.config.mjs"),
      `export default { agent: "agent", agentPath: "agent.mjs", tests: "tests", runsPerTest: 2 };\n`,
    );
    process.env.AGENTDIFF_OFFLINE = "1";
    try {
      const { dir: out, result } = await runMutation({ config: path.join(dir, "agentdiff.config.mjs"), runs: 2 });
      assert.deepEqual(
        result.mutants.map((m) => [m.removed, m.caught, m.caughtBy.map((f) => `${f.test}:${f.kind}`)]),
        [
          ["Call lookup_customer before refund.", true, ["refund:rule"]],
          ["Never mention the weather.", false, []],
        ],
      );
      const report = await fs.readFile(path.join(out, "report.md"), "utf8");
      assert.equal(report, mutationReport(result));
      assert.match(report, /^# 1 of 2 seeded regressions caught/);
      assert.ok(report.indexOf("Never mention the weather") < report.indexOf("Call lookup_customer"), "misses first");
      const left = (await fs.readdir(dir)).filter((f) => f.startsWith(".agentdiff-"));
      assert.deepEqual(left, [], "the copies are removed");
    } finally {
      delete process.env.AGENTDIFF_OFFLINE;
    }
  });
});

describe("agentdiff mutate, prompt in another file", () => {
  it("finds rules in an imported prompt file, reuses a check as the agent's side, and stops a copy once caught", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentdiff-mutate-import-"));
    await fs.mkdir(path.join(dir, "tests"));
    await fs.mkdir(path.join(dir, "agents"));
    // Ten tests; only "refund" is about the lookup rule, and it's last in the suite.
    for (let i = 0; i < 9; i++)
      await fs.writeFile(path.join(dir, `tests/hello-${i}.json`), JSON.stringify({ name: `hello ${i}`, input: "hi" }));
    await fs.writeFile(
      path.join(dir, "tests/zz-refund.json"),
      JSON.stringify({ name: "refund", input: "refund order 7", must_call_tools: ["lookup_customer", "refund"] }),
    );
    // The prompt lives in prompt.mjs, two imports away from the agent file.
    await fs.writeFile(
      path.join(dir, "prompt.mjs"),
      'export const PROMPT = "Call lookup_customer before refund. Never mention the weather.";\n',
    );
    await fs.writeFile(
      path.join(dir, "make.mjs"),
      `import { PROMPT } from "./prompt.mjs";
export const make = () => ({
  instructions: PROMPT,
  tools: ["lookup_customer", "refund"],
  run: async (input) => {
    globalThis.mutateRuns = (globalThis.mutateRuns ?? 0) + 1;
    if (!input.startsWith("refund")) return { text: "Hello!", toolCalls: [] };
    return { text: "Refunded.", toolCalls: PROMPT.includes("lookup_customer before") ? [{ tool: "lookup_customer" }, { tool: "refund" }] : [{ tool: "refund" }] };
  },
});
`,
    );
    await fs.writeFile(
      path.join(dir, "agents/v1.mjs"),
      'import { make } from "../make.mjs";\nexport const agent = make();\n',
    );
    const config = path.join(dir, "agentdiff.config.mjs");
    await fs.writeFile(
      config,
      `export default { agent: "agent", agentPath: "agents/v1.mjs", tests: "tests", runsPerTest: 2, concurrency: 2 };\n`,
    );
    process.env.AGENTDIFF_OFFLINE = "1";
    try {
      // The agent's side comes from a saved check, so the agent itself never runs again.
      const { dir: checked } = await runCheck({ config });
      const runs = () => (globalThis as { mutateRuns?: number }).mutateRuns ?? 0;
      (globalThis as { mutateRuns?: number }).mutateRuns = 0;
      const { result } = await runMutation({ config, runs: 2, baseline: path.basename(checked) });
      assert.equal(result.baseline, path.basename(checked));
      assert.deepEqual(result.skipped, []);
      const [lookup, weather] = result.mutants;
      assert.deepEqual(
        [lookup.removed, lookup.caught, lookup.file, lookup.caughtBy.map((f) => f.test)],
        ["Call lookup_customer before refund.", true, "prompt.mjs", ["refund"]],
      );
      // concurrency 2 × 2 / 2 runs = batches of 2 tests: "refund" names the removed sentence's tool, so it runs first.
      assert.equal(lookup.testsRun, 2, "stopped after the first batch caught it");
      assert.deepEqual([weather.caught, weather.testsRun], [false, 10], "nothing caught it, so it ran everything");
      assert.equal(runs(), 2 * 2 + 10 * 2, "only the copies ran");
      const left = (await fs.readdir(dir, { recursive: true })).filter((f) => String(f).includes(".agentdiff-m"));
      assert.deepEqual(left, [], "every copy on the import chain is removed");

      await assert.rejects(
        runMutation({ config, runs: 4, baseline: path.basename(checked) }),
        /fewer than 4 finished runs for 10 test/,
      );
    } finally {
      delete process.env.AGENTDIFF_OFFLINE;
    }
  });

  it("puts the tests most related to the removed sentence first", () => {
    const tests = [
      { name: "greeting", input: "hello there" },
      { name: "weather", input: "what's the weather like?" },
      { name: "refund", input: "refund please", must_call_tools: ["lookup_customer"] },
    ];
    assert.deepEqual(
      byRelevance(tests, "Call lookup_customer before refund.").map((t) => t.name),
      ["refund", "greeting", "weather"],
    );
    assert.deepEqual(
      byRelevance(tests, "Never mention the weather.").map((t) => t.name),
      ["weather", "greeting", "refund"],
    );
    // Tool names count as written: hyphens, digits and short names too.
    const sms = [
      { name: "hello", input: "hi" },
      { name: "texts back", input: "hi", must_call_tools: ["send-sms"] },
    ];
    assert.deepEqual(
      byRelevance(sms, "Reply only through send-sms.").map((t) => t.name),
      ["texts back", "hello"],
    );
  });
});

describe("agentdiff mutate, noisy tests", () => {
  it("lets a test whose own runs disagree catch a copy only by breaking a rule, and saves each copy's verdicts", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentdiff-mutate-shaky-"));
    await fs.mkdir(path.join(dir, "tests"));
    await fs.writeFile(path.join(dir, "tests/shaky.json"), JSON.stringify({ name: "shaky", input: "shaky" }));
    await fs.writeFile(path.join(dir, "tests/steady.json"), JSON.stringify({ name: "steady", input: "steady" }));
    // Without the rule, the agent fails every run of whichever tests it's given: "worse" everywhere.
    // The shaky test calls lookup on every other run, so its own runs disagree.
    await fs.writeFile(
      path.join(dir, "agent.mjs"),
      `const instructions = "Always answer politely.";
export const agent = {
  instructions,
  tools: ["lookup"],
  run: async (input) => {
    if (!instructions.includes("politely")) throw new Error("broken");
    globalThis.shakyCount = (globalThis.shakyCount ?? 0) + 1;
    return { text: "ok", toolCalls: input === "shaky" && globalThis.shakyCount % 2 ? [{ tool: "lookup" }] : [] };
  },
};
`,
    );
    const config = path.join(dir, "agentdiff.config.mjs");
    await fs.writeFile(
      config,
      `export default { agent: "agent", agentPath: "agent.mjs", tests: "tests", concurrency: 1 };\n`,
    );
    process.env.AGENTDIFF_OFFLINE = "1";
    try {
      const { dir: out, result } = await runMutation({ config, runs: 4 });
      assert.deepEqual(result.skipped, []);
      const [m] = result.mutants;
      assert.deepEqual(m.caughtBy, [{ test: "steady", kind: "worse" }], "the steady test catches it");
      assert.ok(
        m.moved.some((f) => f.test === "shaky" && f.kind === "worse"),
        "the shaky one only moved",
      );
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(out, "verdicts", `${m.id}.json`), "utf8")), {
        grades: [],
        checks: [],
      });
    } finally {
      delete process.env.AGENTDIFF_OFFLINE;
    }
  });
});
