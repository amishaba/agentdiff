// Authored, deterministic sample data. No agents, providers, or private files are read.
// Reuse production aggregation/reporting so the displayed counts agree with the traces.
import { writeFile } from "node:fs/promises";
import { boundaryExample as example } from "../web/src/data/boundary-example.ts";
import { computeVersionStats } from "../src/compare/stats.ts";
import { diffSnapshots } from "../src/compare/snapshot-diff.ts";
import { behaviorDifference } from "../src/discovery/behavior.ts";
import { buildReport } from "../src/report/markdown.ts";
import { DiscoveryConfigSchema, type CaseResult, type Experiment, type Probe } from "../src/discovery/types.ts";
import { confirmedChange } from "../src/compare/signals.ts";
import type { RunRecord, Snapshot, ToolCall, Version } from "../src/types.ts";
import type { Incident, Scenario } from "../src/dashboard/braintrust/scenario.ts";
import type { DemoFixture, SampleDataset } from "../web/src/demo/types.ts";

const createdAt = "2026-09-24T14:30:00.000Z";
const tools = example.tools.map((t) => t.name);
const revision = "a".repeat(64);
const discoveryConfig = DiscoveryConfigSchema.parse({
  fixtures: "agentdiff/fixtures.ts",
  context: "Only return invoices from the user’s verified workspace.",
});
function snapshot(version: Version): Snapshot {
  return {
    name: "billingAssistant",
    model: "gpt-4o-mini",
    workflows: [],
    tools,
    settings: { temperature: 0 },
    instructions: `You are a billing assistant. Check the user’s workspace access before reading invoices.\n${version === "old" ? example.prompt.before : example.prompt.after}\n${version === "old" ? "Always check access, search, then read." : "For direct invoice links, read first and check access before replying."}\nReply with the amount and payment status.`,
    toolDefinitions: Object.fromEntries(
      example.tools.map((tool) => [
        tool.name,
        {
          description:
            tool.description +
            (tool.name === "search_invoices" && version === "new"
              ? " Prefer the highest relevance match when the workspace is not specified."
              : ""),
          inputSchema: {
            type: "object",
            properties: Object.fromEntries(
              (tool.name === "search_invoices"
                ? ["query", "workspace_id"]
                : tool.name === "read_invoice"
                  ? ["invoice_id"]
                  : ["user_id", "workspace_id"]
              ).map((name) => [name, { type: "string" }]),
            ),
            required:
              tool.name === "search_invoices"
                ? ["query"]
                : tool.name === "read_invoice"
                  ? ["invoice_id"]
                  : ["user_id", "workspace_id"],
          },
          outputSchema: {
            type: "object",
            properties:
              tool.name === "check_workspace_access"
                ? { allowed: { type: "boolean" }, workspace_id: { type: "string" } }
                : { invoice_id: { type: "string" }, workspace_id: { type: "string" }, company: { type: "string" } },
          },
        },
      ]),
    ),
  };
}
function record(
  test: string,
  input: string,
  version: Version,
  run: number,
  calls: ToolCall[],
  response: string,
): RunRecord {
  return {
    test,
    input,
    version,
    run,
    tool_calls: structuredClone(calls),
    final_response: response,
    steps: calls.length + 1,
    tokens: { input: 500 + calls.length * 180 + run * 10, output: 45 + run * 5 },
    latency_ms: 500 + calls.length * 400 + run * 30,
    error: null,
  };
}
const oldLane = example.traces[0],
  newLane = example.traces[1];
const specs = [
  {
    name: "Workspace stays scoped",
    input: example.request,
    old: oldLane.calls,
    new: newLane.calls,
    before: oldLane.response,
    after: newLane.response,
    score: 1,
  },
  {
    name: "Access checked before reading",
    input: "Open invoice inv_1042 for me.",
    old: [oldLane.calls[0], oldLane.calls[2]],
    new: [oldLane.calls[2], oldLane.calls[0]],
    before: oldLane.response,
    after: oldLane.response,
    score: 2,
  },
  {
    name: "Explicit workspace request",
    input: "Find the latest renewal invoice in AmiCorp’s workspace.",
    old: oldLane.calls,
    new: oldLane.calls,
    before: oldLane.response,
    after: oldLane.response,
    score: 5,
  },
];
function dataset(
  dir: string,
  specsToUse = specs,
  replay?: { incidentId: string; projectId: string; rootSpanId: string },
): SampleDataset {
  const traces: SampleDataset["traces"] = { old: [], new: [] };
  const grades: SampleDataset["grades"] = [];
  const tests = specsToUse.map((spec) => {
    const mustCallTools = [...new Set(spec.old.map((c) => c.tool))];
    for (const version of ["old", "new"] as const)
      for (let run = 1; run <= 3; run++) {
        const r = record(
          spec.name,
          spec.input,
          version,
          run,
          spec[version],
          version === "old" ? spec.before : spec.after,
        );
        if (replay) r.replay = { incidentId: replay.incidentId, status: "complete", missing: [] };
        traces[version].push(r);
        grades.push({
          test: spec.name,
          version,
          run,
          score: version === "old" ? 5 : spec.score,
          reason:
            version === "old" || spec.score === 5
              ? "Sample: the answer stays within the verified workspace and follows the required order."
              : "Sample: a workspace or tool-order requirement was missed.",
        });
      }
    return {
      test: spec.name,
      input: spec.input,
      mustCallTools,
      gradingCriteria: "Check workspace access before reading. Only use invoices from the verified workspace.",
      ...Object.fromEntries(
        (["old", "new"] as const).map((v) => [
          v,
          computeVersionStats(
            traces[v].filter((r) => r.test === spec.name),
            "gpt-4o-mini",
            mustCallTools,
            grades.filter((g) => g.test === spec.name && g.version === v).map((g) => g.score),
          ),
        ]),
      ),
    } as SampleDataset["comparison"]["tests"][number];
  });
  const oldSnapshot = snapshot("old"),
    newSnapshot = snapshot("new");
  const explanation =
    "The updated instructions replace an explicit workspace filter with “session context.” In this sample, the agent calls the same tools but searches without workspace_id, then returns RoyCo’s invoice to an AmiCorp user. The direct-link instruction also moves read_invoice before the access check.\n\nKeep the workspace filter explicit and require access checks before reading. Lower latency does not establish that the new behaviour is correct.";
  const comparison = {
    agentName: "billingAssistant",
    oldFile: "agents/billing.ts @ main",
    newFile: "agents/billing.ts @ working tree",
    runsPerTest: 3,
    createdAt,
    oldSnapshot,
    newSnapshot,
    snapshotDiff: diffSnapshots(oldSnapshot, newSnapshot),
    tests,
  };
  return {
    mode: "demo",
    dir,
    comparison,
    grades,
    traces,
    explanation,
    report: "",
    detailed:
      explanation +
      "\n\nThe workspace test drops from 5/5 to 1/5 in this authored example, even though its tool names and order stay the same. Inspecting arguments reveals the missing workspace filter. Discovery checks a shorter phrasing on fresh sample trials to illustrate repeatability; it does not prove coverage of every possible input.",
  };
}
const main = dataset("compare-sample-workspace");
const probe: Probe = {
  name: "Workspace filter omitted on implicit requests",
  strategy: "boundary",
  changeId: "instructions",
  hypothesis:
    "Replacing an explicit workspace rule with session context may broaden searches when the user says “our invoice.”",
  control: "Find the latest renewal invoice for AmiCorp.",
  variant: "Could you please find our most recent renewal invoice and tell me whether it is paid?",
  targetTools: ["search_invoices", "read_invoice"],
};
function experiment(id: string, phase: Experiment["phase"], parentId?: string): Experiment {
  const p = { ...probe, ...(phase === "screen" ? {} : { variant: "Find our invoice." }) };
  const cases = [p.control, p.variant].map((input, i) => {
    const name = `discovery-${id}-${i}`;
    const count = phase === "confirm" ? 3 : 2;
    const old = Array.from({ length: count }, (_, r) =>
      record(name, input, "old", r + 1, oldLane.calls, oldLane.response),
    );
    const neu = Array.from({ length: count }, (_, r) =>
      record(name, input, "new", r + 1, i ? newLane.calls : oldLane.calls, i ? newLane.response : oldLane.response),
    );
    return { input, old, new: neu, difference: behaviorDifference(old, neu) };
  }) as [CaseResult, CaseResult];
  return { id, phase, parentId, probe: p, cases, status: "observed" };
}
const experiments = [
  experiment("e001", "screen"),
  experiment("e002", "shrink", "e001"),
  experiment("e003", "confirm", "e002"),
];
main.comparison.discovery = {
  status: "complete",
  config: discoveryConfig,
  changes: [{ id: "instructions", before: example.prompt.before, after: example.prompt.after }],
  agentRuns: experiments.reduce((n, e) => n + e.cases.reduce((n, c) => n + c.old.length + c.new.length, 0), 0),
  plannerCalls: 2,
  experiments,
  findings: [
    {
      id: "f001",
      experimentId: "e003",
      originalExperimentId: "e001",
      probe: experiments[2].probe,
      cases: experiments[2].cases,
      reproducedCases: [1],
      shortened: true,
    },
  ],
  notices: [],
};
const incidents: Incident[] = [
  {
    id: "sample-scope",
    name: "Cross-workspace invoice",
    input: example.request,
    reason: "workspace_accuracy: 0.1",
    scores: [{ name: "workspace_accuracy", value: 0.1, spanId: "trace-scope" }],
  },
  {
    id: "sample-order",
    name: "Invoice read before access check",
    input: specs[1].input,
    reason: "tool_order: 0.25",
    scores: [{ name: "tool_order", value: 0.25, spanId: "trace-order" }],
  },
  {
    id: "sample-missing",
    name: "Missing invoice response",
    input: "Check whether our renewal invoice has been paid.",
    reason: "1 recorded error",
    scores: [],
    errorCount: 1,
  },
  {
    id: "sample-older",
    name: "Earlier workspace mismatch",
    input: "What is our latest invoice amount?",
    reason: "workspace_accuracy: 0.2",
    scores: [{ name: "workspace_accuracy", value: 0.2, spanId: "trace-older" }],
  },
].map((i, index) => ({
  ...i,
  projectId: "sample-billing",
  rootSpanId: `trace-${i.id}`,
  created: new Date(Date.parse(createdAt) - index * 3_600_000).toISOString(),
  spanCount: 4,
  reviewed: index > 0,
  ...(index > 0 ? { reviewRevision: revision } : {}),
}));
const reviews: Record<string, Scenario> = Object.fromEntries(
  incidents.map((i) => [
    i.id,
    {
      incident: i,
      input: i.input,
      responses: (i.id === "sample-missing" ? oldLane.calls.slice(0, 2) : oldLane.calls).map((c) => ({
        ...c,
        occurrence: 1,
        source: "recording" as const,
      })),
      blockers: [],
      suggestedExpectation: "Verify access before reading, and return only the verified workspace’s invoice.",
      expectation: i.reviewed ? "Verify access before reading, and return only the verified workspace’s invoice." : "",
      mustCallTools: tools,
      reviewed: !!i.reviewed,
    },
  ]),
);
const datasets: DemoFixture["datasets"] = { [main.dir]: main };
const replayDirs: Record<string, string> = {};
for (const incident of incidents) {
  const dir = `compare-replay-${incident.id}`;
  const result = dataset(
    dir,
    [
      {
        ...specs[0],
        name: incident.name,
        input: incident.input,
        old: incident.id === "sample-order" ? specs[1].new : newLane.calls,
        new: oldLane.calls,
        before: newLane.response,
        after: oldLane.response,
        score: 5,
      },
    ],
    { incidentId: incident.id, projectId: incident.projectId, rootSpanId: incident.rootSpanId },
  );
  for (const g of result.grades)
    if (g.version === "old") {
      g.score = 1;
      g.reason = "Sample: the original version did not meet the workspace or ordering requirement.";
    }
  result.comparison.tests[0].old.avgGrade = 1;
  result.comparison.oldSnapshot = snapshot("new");
  result.comparison.newSnapshot = snapshot("old");
  result.comparison.snapshotDiff = diffSnapshots(result.comparison.oldSnapshot, result.comparison.newSnapshot);
  result.explanation =
    "In this predefined replay example, the original version misses a workspace or ordering check. The updated version checks access first, scopes the search to AmiCorp, and reads only AmiCorp’s invoice. Edits in the sample review do not execute or grade a new agent.";
  result.detailed = result.explanation;
  datasets[dir] = result;
  replayDirs[incident.id] = dir;
}
const failure = structuredClone(main);
failure.dir = "compare-sample-failure";
delete failure.comparison.discovery;
for (const r of failure.traces.new) {
  r.error = "Sample provider error: the configured model could not be reached.";
  r.tool_calls = [];
  r.final_response = null;
  r.tokens = null;
  r.steps = null;
  r.latency_ms = null;
}
failure.grades = failure.grades.filter((g) => g.version === "old");
for (const t of failure.comparison.tests)
  t.new = computeVersionStats(
    failure.traces.new.filter((r) => r.test === t.test),
    "gpt-4o-mini",
    t.mustCallTools,
  );
failure.explanation = "";
failure.detailed = "";
datasets[failure.dir] = failure;
for (const d of Object.values(datasets))
  d.report =
    "# SAMPLE WORKSPACE — illustrative data, not a live agent run\n\n" + buildReport(d.comparison, d.explanation);
const config = {
  agent: "billingAssistant",
  agentPath: "agents/billing.ts",
  versions: { old: "agents/billing-v1.ts", new: "agents/billing-v2.ts" },
  tests: "agentdiff/tests",
  runsPerTest: 3,
  discovery: discoveryConfig,
};
const result: DemoFixture = {
  datasets,
  runs: [main, datasets[replayDirs[incidents[0].id]], failure].map((d, index) => ({
    dir: d.dir,
    label: ["Sample · Workspace regression", "Sample · Reviewed incident replay", "Sample · Failed comparison"][index],
    agentName: d.comparison.agentName,
    tests: d.comparison.tests.length,
    ...(index === 2 ? {} : { changed: d.comparison.tests.filter(confirmedChange).length }),
    createdAt,
  })),
  project: { config, configFile: "agentdiff.config.ts", revision, editable: true, testCount: 3 },
  setup: {
    config,
    testCount: 3,
    onlyIncidentTests: false,
    refs: ["main", "release/v1", "fix/workspace-filter"],
    defaultRef: "main",
  },
  drafts: {
    drafts: [
      {
        dir: main.dir,
        file: "f001-variant.json",
        revision,
        name: "Implicit workspace invoice",
        input: "Find our invoice.",
        findingId: "f001",
        experimentId: "e003",
        hypothesis: probe.hypothesis,
        tools,
      },
    ],
    issues: [],
  },
  incidents,
  reviews,
  replayDirs,
};
await writeFile(new URL("../web/fixtures/dashboard.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
console.log("Wrote authored dashboard samples (no model or service calls).");
