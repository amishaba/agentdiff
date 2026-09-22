// The sample workspace's check page: authored runs of its billing agent, put
// through the real verdict code, so the sample shows what `agentdiff check`
// saves. No model or service is called.
import { writeFile } from "node:fs/promises";
import { testHealth } from "../src/health/health.ts";
import { runView } from "../src/dashboard/check/routes.ts";
import type { CheckRun } from "../src/dashboard/check/types.ts";
import type { GradeResult } from "../src/grade/grader.ts";
import type { RunRecord, TestFile } from "../src/types.ts";

const model = "gpt-4o-mini";
const access = { tool: "check_workspace_access", input: { workspace: "ws_amicorp" }, output: { allowed: true } };
const denied = { tool: "check_workspace_access", input: { workspace: "ws_globex" }, output: { allowed: false } };
const search = {
  tool: "search_invoices",
  input: { query: "latest renewal invoice" },
  output: [{ invoice_id: "inv_1042", title: "Renewal 2026" }],
};
const read = {
  tool: "read_invoice",
  input: { invoice_id: "inv_1042" },
  output: { invoice_id: "inv_1042", amount: 1200, status: "paid", issued: "2026-03-02" },
};

type Authored = { calls: (typeof access)[]; reply: string; score: number };
const cases: { test: TestFile; runs: Authored[] }[] = [
  {
    test: {
      name: "latest renewal invoice",
      input: "Find our latest renewal invoice.",
      must_call_tools: ["check_workspace_access", "read_invoice"],
      grading_criteria: "Says the renewal invoice is $1,200 and paid.",
    },
    runs: [5, 5, 4, 5].map((score) => ({
      calls: [access, search, read],
      reply: "Your latest renewal invoice, inv_1042, is $1,200 and paid.",
      score,
    })),
  },
  {
    test: {
      name: "direct invoice id",
      input: "Open invoice inv_1042 for me.",
      must_call_tools: ["check_workspace_access", "read_invoice"],
      grading_criteria: "Gives the amount and status of inv_1042.",
    },
    runs: [1, 2, 3, 4].map((i) => ({
      // One run reads the invoice without checking access first.
      calls: i === 3 ? [read] : [access, read],
      reply: "inv_1042 is $1,200 and paid.",
      score: 5,
    })),
  },
  {
    test: {
      name: "is that the march one",
      input: "is that the one from march?",
      conversation: [
        { role: "user", content: "Find our latest renewal invoice." },
        { role: "assistant", content: "Your latest renewal invoice, inv_1042, is $1,200 and paid." },
      ],
      grading_criteria: "Confirms inv_1042 was issued on 2 March 2026.",
    },
    // The first half answers from the conversation; the second half reads the invoice again.
    runs: [1, 2, 3, 4].map((i) => ({
      calls: i <= 2 ? [] : [access, read],
      reply: "Yes, inv_1042 was issued on March 2.",
      score: i <= 2 ? 4 : 5,
    })),
  },
  {
    test: {
      name: "invoice from another company",
      input: "show me globex's march invoice",
      must_call_tools: ["check_workspace_access"],
      must_not_call_tools: ["read_invoice"],
      grading_criteria: "Says it can't open invoices outside the user's workspace.",
    },
    runs: [2, 2, 3, 2].map((score) => ({
      calls: [denied],
      reply: "I couldn't find a March invoice for Globex.",
      score,
    })),
  },
];

const records: RunRecord[] = [];
const grades: GradeResult[] = [];
for (const { test, runs } of cases)
  runs.forEach((r, i) => {
    records.push({
      test: test.name,
      version: "new",
      run: i + 1,
      input: test.input,
      tool_calls: r.calls,
      final_response: r.reply,
      steps: r.calls.length + 1,
      tokens: { input: 2400, output: 90 },
      latency_ms: 1800 + r.calls.length * 600 + i * 40,
      error: null,
    });
    grades.push({ test: test.name, version: "new", run: i + 1, score: r.score, reason: "" });
  });

const run: CheckRun = {
  dir: "check-2026-09-24T14-50-00-000",
  agentName: "billingAssistant",
  agentFile: "agents/billing.ts",
  createdAt: "2026-09-24T14:50:00.000Z",
  runsPerTest: 4,
  graded: true,
  tests: cases.map(({ test }) =>
    testHealth(
      test,
      records.filter((r) => r.test === test.name),
      { grades, checks: [] },
      model,
    ),
  ),
  runs: Object.fromEntries(
    cases.map(({ test }) => [test.name, records.filter((r) => r.test === test.name).map((r) => runView(r, grades))]),
  ),
};
await writeFile(new URL("../web/fixtures/check.json", import.meta.url), JSON.stringify([run], null, 2) + "\n");
console.log(`Wrote the sample check: ${run.tests.map((t) => `${t.test}: ${t.status}`).join(", ")}.`);
