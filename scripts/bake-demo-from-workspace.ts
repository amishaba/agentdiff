// Turn a real agentdiff workspace into the hosted demo's fixtures. It starts the
// real dashboard server against the workspace and records what each route the
// demo serves (web/src/demo/api.ts) returns, so the demo shows exactly what
// agentdiff saved: no authored data. No model or service is called.
//
//   npm run bake-workspace-demo -- <workspace-dir> [--out <dir>]
//
// The workspace needs an agentdiff.config.* and a .agentdiff/ folder with at
// least one comparison. Writes dashboard.json, scenarios.json and check.json to
// --out (default web/fixtures).
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { createViewServer } from "../src/dashboard/server.ts";
import { JobManager } from "../src/dashboard/jobs/manager.ts";
import type { RunSetup } from "../src/dashboard/jobs/types.ts";
import type { DraftList, ProjectState } from "../src/dashboard/project/types.ts";
import type { ScenarioRun } from "../src/dashboard/scenarios/types.ts";
import type { CheckRun, CheckRunSummary } from "../src/dashboard/check/types.ts";
import type { DemoFixture, SampleDataset } from "../web/src/demo/types.ts";
import type { Comparison, GradeRecord, RunRecord, RunSummary } from "../web/src/data/types.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: "string", default: "web/fixtures" } },
});
if (positionals.length !== 1) {
  console.error("Usage: npm run bake-workspace-demo -- <workspace-dir> [--out <dir>]");
  process.exit(1);
}
const workspace = path.resolve(positionals[0]);
const out = path.resolve(values.out!);
if (!readdirSync(workspace).some((f) => /^agentdiff\.config\.[cm]?[jt]s$/.test(f)))
  throw new Error(`${workspace} has no agentdiff.config file.`);
if (!existsSync(path.join(workspace, ".agentdiff")))
  throw new Error(`${workspace} has no .agentdiff folder of saved runs.`);

// The worker processes the server forks inherit this, so nothing it loads can reach a model.
process.env.AGENTDIFF_OFFLINE = "1";
const server = createViewServer(new JobManager(workspace));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

async function request(route: string): Promise<Response> {
  const res = await fetch(base + route, { headers: { "x-agentdiff": "local" } });
  if (!res.ok) throw new Error(`${route} returned ${res.status}: ${await res.text()}`);
  return res;
}
const get = async <T>(route: string): Promise<T> => (await request(route)).json() as Promise<T>;
/** Report and detailed explanation are optional files; a missing one is an empty page, as the app treats it. */
async function text(route: string): Promise<string> {
  const res = await fetch(base + route, { headers: { "x-agentdiff": "local" } });
  return res.status === 404 ? "" : res.ok ? res.text() : Promise.reject(new Error(`${route} returned ${res.status}`));
}
const dirQuery = (dir: string) => `?dir=${encodeURIComponent(dir)}`;

let fixture: DemoFixture, scenarioRuns: ScenarioRun[], checkRuns: CheckRun[];
try {
  const runs = await get<RunSummary[]>("/api/runs");
  if (!runs.length) throw new Error(`${workspace} has no saved comparison. Run \`agentdiff compare\` there first.`);
  const datasets: Record<string, SampleDataset> = {};
  for (const { dir } of runs) {
    const [comparison, traces, grades, short, detailed, report] = await Promise.all([
      get<Comparison>(`/api/comparison${dirQuery(dir)}`),
      get<{ old: RunRecord[]; new: RunRecord[] }>(`/api/traces${dirQuery(dir)}`),
      get<GradeRecord[]>(`/api/grades${dirQuery(dir)}`),
      get<{ text: string }>(`/api/explanation${dirQuery(dir)}&kind=short`),
      get<{ text: string }>(`/api/explanation${dirQuery(dir)}&kind=detailed`),
      text(`/api/report${dirQuery(dir)}`),
    ]);
    datasets[dir] = {
      mode: "demo",
      dir,
      comparison,
      traces,
      grades,
      explanation: short.text ?? "",
      detailed: detailed.text ?? "",
      report,
    };
  }

  const [project, setup, drafts] = await Promise.all([
    get<ProjectState>("/api/project"),
    get<RunSetup>("/api/jobs/setup"),
    get<DraftList>("/api/project/drafts"),
  ]);
  // A real workspace has no Braintrust incidents; the demo's incidents page shows its empty state.
  fixture = { datasets, runs, project, setup, drafts, incidents: [], reviews: {}, replayDirs: {} };

  const scenarioList = await get<{ dir: string }[]>("/api/scenarios");
  scenarioRuns = await Promise.all(scenarioList.map((r) => get<ScenarioRun>(`/api/scenarios/run${dirQuery(r.dir)}`)));
  const checkList = await get<CheckRunSummary[]>("/api/checks");
  checkRuns = await Promise.all(checkList.map((r) => get<CheckRun>(`/api/checks/run${dirQuery(r.dir)}`)));
} finally {
  server.close();
}

// The demo's "run a check" and "write scenarios" buttons open the first saved run of each kind.
for (const [kind, list] of [
  ["check", checkRuns],
  ["scenarios", scenarioRuns],
] as const)
  if (!list.length) console.warn(`Warning: no saved ${kind} run, so the demo's ${kind} page will be empty.`);

/** Make workspace paths relative, then refuse to write anything that still names this machine. */
function scrub(name: string, value: unknown): string {
  let json = JSON.stringify(value, null, 2) + "\n";
  for (const root of new Set([realpathSync(workspace), workspace])) {
    json = json.replaceAll(root + path.sep, "").replaceAll(root, ".");
  }
  const leaks = [
    /(?:\/Users|\/home|\/private|\/var\/folders|\/tmp)\/[^"\s]*/g,
    // A drive letter on its own, then a folder name: "C:\\Users\\…", not the "k:\n" at the end of "link:" before a newline.
    /(?<![A-Za-z0-9])[A-Za-z]:\\\\[A-Za-z0-9 ._-]{2,}[^"\s]*/g,
    new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '[^"\\s]*', "g"),
    /\b(?:sk|sk-proj|sk-ant)-[A-Za-z0-9_-]{20,}/g,
  ].flatMap((re) => json.match(re) ?? []);
  if (leaks.length)
    throw new Error(`${name} still holds machine paths or keys:\n  ${[...new Set(leaks)].slice(0, 10).join("\n  ")}`);
  return json;
}
const files = {
  "dashboard.json": scrub("dashboard.json", fixture),
  "scenarios.json": scrub("scenarios.json", scenarioRuns),
  "check.json": scrub("check.json", checkRuns),
};
await mkdir(out, { recursive: true });
for (const [name, json] of Object.entries(files)) await writeFile(path.join(out, name), json);
console.log(
  `Baked ${path.basename(workspace)} into ${out}: ` +
    `${fixture.runs.length} comparison(s), ${checkRuns.length} check(s), ${scenarioRuns.length} scenarios run(s), ` +
    `${fixture.drafts.drafts.length} discovery draft(s).`,
);
