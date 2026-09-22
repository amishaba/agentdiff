// Bake a saved comparison into the website's examples, with no model calls.
//
//   node --import tsx scripts/bake-example.ts <compare dir | baked .json> <name> "<title>" "<what changed>" [--headline "<finding>"] [--without "<test>"]...
//
// The source is a folder `agentdiff compare` wrote, or an example baked
// before (the same shape), to rebuild it with the current code.
// Writes web/fixtures/examples/<name>.json (the same shape `agentdiff view`
// serves, so the page and the local dashboard share one loader) and updates
// web/fixtures/examples/index.json, the small summary the landing page reads.
// Stats, confirmation and labels are rebuilt with the current code, as
// `agentdiff report` does; --without leaves a test out of the example.
// --headline is the one finding the homepage card leads with. Write it from
// the runs, and keep it when rebaking (it's read back from index.json).
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareTests } from "../src/compare/confirm.ts";
import { confirmedChange } from "../src/compare/signals.ts";
import type { CheckResult, Comparison, RunRecord, TestComparison, TestFile } from "../src/types.ts";
import { isBuiltInCheck, type CheckDefinition } from "../src/types.ts";
import type { GradeResult } from "../src/grade/grader.ts";
import {
  discoveryFindings,
  factsOf,
  KIND_LABEL,
  kindCounts,
  mostly,
  otherChanges,
  promptChanges,
  runsOf,
  totals,
  verdict,
} from "../web/src/review/model.ts";
import { changeKind, sortedTests } from "../src/compare/change-kind.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "web/fixtures/examples");
// Same clip as the view server, so a runaway tool output can't bloat the bundle.
const LIMIT = 8000;

const args = process.argv.slice(2);
const OPTIONS = ["--without", "--headline"];
const values = (flag: string) => args.flatMap((a, i) => (args[i - 1] === flag ? [a] : []));
const without = values("--without");
const [dirArg, name, title, change] = args.filter((a, i) => !OPTIONS.includes(a) && !OPTIONS.includes(args[i - 1]));
if (!dirArg || !name || !title || !change) {
  console.error(
    'usage: node --import tsx scripts/bake-example.ts <compare dir> <name> "<title>" "<what changed>" [--headline "<finding>"] [--without "<test>"]',
  );
  process.exit(1);
}
const dir = path.resolve(dirArg);
const read = async <T>(file: string, fallback?: T): Promise<T> => {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, file), "utf8"));
  } catch (error) {
    if (fallback !== undefined) return fallback;
    throw error;
  }
};
const readRuns = async (sub: string): Promise<RunRecord[]> =>
  Promise.all(
    (await fs.readdir(path.join(dir, sub)))
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => read<RunRecord>(path.join(sub, f))),
  );

const clip = (value: unknown) => {
  if (value == null) return value;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length <= LIMIT ? value : `${text.slice(0, LIMIT)}… (${text.length - LIMIT} more chars)`;
};
// Keep who made each call and when; paths and team views need them.
const slim = (r: RunRecord): RunRecord => ({
  ...r,
  final_response: typeof r.final_response === "string" ? (clip(r.final_response) as string) : r.final_response,
  tool_calls: r.tool_calls.map((c) => ({ ...c, input: clip(c.input), output: clip(c.output) })),
});
const testOf = (t: TestComparison): TestFile => {
  const checks: Record<string, CheckDefinition> = {};
  for (const [id, s] of Object.entries({ ...t.old.checks, ...t.new.checks }))
    if (!isBuiltInCheck(id))
      checks[id] = s.kind === "yes_no" ? s.question : { question: s.question, options: s.options };
  return {
    name: t.test,
    input: t.input ?? "",
    must_call_tools: t.mustCallTools,
    ...(t.mustNotCallTools?.length ? { must_not_call_tools: t.mustNotCallTools } : {}),
    ...(t.gradingCriteria ? { grading_criteria: t.gradingCriteria } : {}),
    ...(Object.keys(checks).length ? { checks } : {}),
  };
};

const keep = <T extends { test: string }>(rows: T[]) => rows.filter((r) => !without.includes(r.test));
type Baked = {
  comparison: Comparison;
  grades: GradeResult[];
  traces: { old: RunRecord[]; new: RunRecord[] };
  checks?: CheckResult[];
};
const baked = dir.endsWith(".json") ? (JSON.parse(await fs.readFile(dir, "utf8")) as Baked) : null;
const c = baked ? baked.comparison : await read<Comparison>("comparison.json");
const old = keep(baked ? baked.traces.old : await readRuns("old-runs")),
  neu = keep(baked ? baked.traces.new : await readRuns("runs"));
const grades = keep(baked ? baked.grades : await read<GradeResult[]>("grades.json", []));
const checks = keep(baked ? (baked.checks ?? []) : await read<CheckResult[]>("checks.json", []));
const kept = c.tests.filter((t) => !without.includes(t.test));
const rebuilt = compareTests(
  kept.map(testOf),
  { records: old, model: c.oldSnapshot.model },
  { records: neu, model: c.newSnapshot.model },
  { grades, checks },
  c.runsPerTest,
);
c.tests = rebuilt.map((t, i) => ({ ...t, input: kept[i].input }));

const fixture = {
  source: {
    dir: path.basename(dir),
    bakedAt: new Date().toISOString(),
    origin: name,
    ...(without.length ? { without } : {}),
  },
  comparison: c,
  grades,
  traces: { old: old.map(slim), new: neu.map(slim) },
  explanation: (c.explanation ?? "").trim(),
  // Each run's check answers. The page doesn't read them, but a rebake from
  // this file needs them: without them every check statistic, and the labels
  // built on failure_type, would change.
  ...(checks.length ? { checks } : {}),
};
await fs.mkdir(OUT, { recursive: true });
const file = path.join(OUT, `${name}.json`);
await fs.writeFile(file, JSON.stringify(fixture) + "\n");

// The landing page's summary: one line per example, no traces.
const indexFile = path.join(OUT, "index.json");
const index: Record<string, unknown>[] = JSON.parse(await fs.readFile(indexFile, "utf8").catch(() => "[]"));
const n = kindCounts(c),
  t = totals(c);
// One test's trip through the loop, for the homepage's moving pipeline: the
// most serious change, with what each stage saw. All of it is read from the
// recording; nothing here is written by hand.
function storyOf() {
  const t = sortedTests(c)[0];
  if (!t || changeKind(t, c.writeTools) === "same") return undefined;
  const hide = t.oneSidedChecks ?? [];
  const traces = { old, new: neu };
  const runs = (v: "old" | "new") => traces[v].filter((r) => r.test === t.test);
  // Tool calls and the reply only; the agent's own checks make the line too long to follow.
  const toolsOnly = (path: string) =>
    path
      .split(" → ")
      .filter((step) => !step.includes(": "))
      .join(" → ");
  const statuses = (v: "old" | "new") => runsOf(c, traces, grades as never, t, v).map((r) => r.status);
  const [cause, fix] = (c.explanation ?? "").split(/\n?\s*Fix to try:\s*/);
  // The prompt lines the explanation quotes, or else the first removed and added lines.
  const quotes = [...(c.explanation ?? "").matchAll(/["“]([^"”]{12,})["”]/g)].map((m) => m[1]);
  const lines = promptChanges(c).flatMap((g) => g.lines);
  const quoted = lines.filter((l) => quotes.some((q) => l.text.includes(q) || q.includes(l.text)));
  const prompt = (
    quoted.length ? quoted : [lines.find((l) => l.sign === "-"), lines.find((l) => l.sign === "+")].filter((l) => !!l)
  ).slice(0, 3);
  const key = t.confirmation?.confirmed[0];
  const found = discoveryFindings(c).find((f) => f.differs);
  const shown = found?.cases.find((cs) => cs.old.path !== cs.new.path);
  return {
    test: t.test,
    input: t.input ?? "",
    prompt,
    other: otherChanges(c).slice(0, 3),
    old: { path: toolsOnly(mostly(runs("old"), hide).path), runs: statuses("old") },
    new: { path: toolsOnly(mostly(runs("new"), hide).path), runs: statuses("new") },
    halves: key
      ? {
          signal: key,
          first: t.confirmation!.first.includes(key),
          second: t.confirmation!.second.includes(key),
          noise: t.confirmation!.noise.includes(key),
        }
      : undefined,
    label: KIND_LABEL[changeKind(t, c.writeTools)],
    fact: factsOf(c, t)[0] ?? "",
    ...(shown
      ? {
          discovery: {
            message: shown.message,
            old: toolsOnly(shown.old.path),
            new: toolsOnly(shown.new.path),
            label: shown.kind ? KIND_LABEL[shown.kind] : undefined,
          },
        }
      : {}),
    cause: cause?.trim() ?? "",
    fix: fix?.trim() ?? "",
  };
}
const story = storyOf();
const at = index.findIndex((e) => e.name === name);
const headline = values("--headline")[0] ?? (at >= 0 ? index[at].headline : undefined);
const d = c.discovery;
const entry = {
  name,
  title,
  change,
  ...(headline ? { headline } : {}),
  verdict: verdict(c),
  tests: c.tests.length,
  runsPerTest: c.runsPerTest,
  changed: c.tests.filter(confirmedChange).length,
  rule: n.rule,
  worse: n.worse,
  better: n.better,
  cost: t.cost,
  recorded: c.createdAt ?? null,
  // The homepage's pipeline: how long each stage took, and what discovery did.
  ...(c.stages?.length ? { stages: c.stages.map((s) => ({ stage: s.stage, status: s.status, ms: s.ms })) } : {}),
  ...(d ? { discovery: { experiments: d.experiments.length, findings: d.findings.length, runs: d.agentRuns } } : {}),
  ...(story ? { story } : {}),
};
if (at >= 0) index[at] = entry;
else index.push(entry);
await fs.writeFile(indexFile, JSON.stringify(index, null, 2) + "\n");
console.log(
  `baked ${path.basename(dir)} → ${path.relative(ROOT, file)} (${Math.round((await fs.stat(file)).size / 1024)} KB, ${old.length + neu.length} runs${without.length ? `, without ${without.join(", ")}` : ""}) · ${entry.verdict}`,
);
