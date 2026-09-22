import path from "node:path";
import { loadConfig } from "../config/load.ts";
import { importAgent } from "../agent/load.ts";
import { extractSnapshot } from "../agent/snapshot.ts";
import { stillToJudge, stillValid } from "../grade/basis.ts";
import { evaluateChecks } from "../grade/checks.ts";
import { gradeRecords } from "../grade/grader.ts";
import { savedVerdicts } from "../health/baseline.ts";
import { whyStop } from "../health/early-stop.ts";
import { testHealth } from "../health/health.ts";
import { healthReport } from "../health/report.ts";
import type { HealthResult } from "../health/types.ts";
import { fail } from "../lib/errors.ts";
import { graderKind, missingKeys, offline } from "../lib/llm.ts";
import { missingTools, missingToolsMessage } from "../suite/lint.ts";
import { loadTests } from "../suite/load.ts";
import { readJsonDir, writeJson, writeText } from "../storage/fs.ts";
import { CheckDirNameSchema, type RunRecord } from "../types.ts";
import { RunsStopped, runTests } from "./run-tests.ts";
import { silentReporter, type Reporter } from "./reporter.ts";

export interface CheckOptions {
  config?: string;
  /** The agent file to check. Default: agentPath, else versions.new; check versions.old to use it as compare --baseline. */
  file?: string;
  /** Runs per test. Default: the config's runsPerTest. At least 2, so the halves can be compared. */
  runs?: number;
  /** A check-* folder that stopped partway, or a trial: keep the runs it saved, run the rest, then grade them all. */
  resume?: string;
  /** Every test once, not graded: the tool rules only, to find tests that expect the wrong thing before a full check. */
  trial?: boolean;
  reporter?: Reporter;
}

/**
 * How one version of the agent behaves, with nothing to compare it to: run
 * every test several times, grade the runs and answer their checks, and give
 * each test a verdict: errors, breaks a test rule, scores low, unpredictable
 * (its runs disagree with each other), or steady.
 */
export async function runCheck(opts: CheckOptions = {}): Promise<{ dir: string; result: HealthResult }> {
  const reporter = opts.reporter ?? silentReporter;
  const tooFew = (n: number) => !Number.isInteger(n) || n < 2;
  const TOO_FEW = "must be a whole number, at least 2: the check compares the runs with each other.";
  if (opts.trial && (opts.runs != null || opts.resume))
    fail("--trial runs every test once: leave out --runs and --resume.");
  if (opts.runs != null && tooFew(opts.runs)) fail(`--runs ${TOO_FEW}`);
  const { config, rootDir, workspace } = await loadConfig(opts.config);
  const runs = opts.runs ?? config.runsPerTest;
  if (tooFew(runs)) fail(`runsPerTest ${TOO_FEW}`);
  const grader = graderKind(config.grader);
  const missing = offline() || opts.trial ? [] : missingKeys(grader);
  if (missing.length)
    fail(
      `Grading needs these keys:\n${missing.map((m) => `  ${m.key} — ${m.for}`).join("\n")}\n` +
        `Set them in .env, or set AGENTDIFF_OFFLINE=1 to check only the tool rules and paths.`,
    );
  const tests = await loadTests(rootDir, config.tests);
  const agentFile = opts.file ?? config.agentPath ?? config.versions!.new;
  const agent = await importAgent(rootDir, agentFile, config.agent, { maxTurns: config.maxTurns });
  const snapshot = await extractSnapshot(agent);

  const lacking = missingTools(tests, snapshot.tools);
  if (lacking.length) fail(missingToolsMessage(lacking, snapshot.tools));

  reporter.log(`agentdiff check — ${snapshot.name || config.agent}`, "heading");
  let dir: string;
  let saved: RunRecord[] = [];
  let runsPerTest = opts.trial ? 1 : runs;
  if (opts.resume) {
    // A check that stopped partway: keep the runs it saved (errored ones run again) and finish the rest.
    dir = path.join(workspace.dir, CheckDirNameSchema.parse(opts.resume));
    const all = (await readJsonDir<RunRecord>(path.join(dir, "runs"))).filter((r) =>
      tests.some((t) => t.name === r.test),
    );
    if (!all.length) fail(`No saved runs in ${opts.resume}.`);
    saved = all.filter((r) => !r.error);
    // Its runs per test, unless told otherwise (the first test's runs all start before any later test's); a trial's go up to the config's.
    const savedRuns = Math.max(...all.map((r) => r.run));
    runsPerTest = opts.runs ?? (savedRuns < 2 ? runs : savedRuns);
  } else dir = workspace.newCheckDir();
  const left = tests.length * runsPerTest - saved.filter((r) => r.run <= runsPerTest).length;
  reporter.log(
    `${tests.length} tests × ${runsPerTest} runs${opts.resume ? ` · ${saved.length} saved in ${opts.resume}, ${left} to run` : ""}`,
  );
  let records: RunRecord[];
  try {
    records = (
      await runTests({
        sides: [{ agent, version: "new", runsDir: path.join(dir, "runs"), label: "agent" }],
        tests,
        runsPerTest,
        concurrency: config.concurrency,
        report: { progress: reporter.progress, log: (t) => reporter.log(t, "detail"), runSaved: reporter.runSaved },
        reuse: saved,
        // A resumed check was asked to finish: it doesn't stop for a reason it already stopped for.
        // A trial is there to show every test that expects the wrong thing, so it runs them all.
        shouldStop: opts.resume || opts.trial ? undefined : (done) => whyStop(tests, done),
      })
    ).new;
  } catch (err) {
    if (!(err instanceof RunsStopped)) throw err;
    fail(
      `Stopped after ${err.saved} runs: ${err.reason}\n` +
        `To finish anyway, keeping the runs saved so far: npx agentdiff check --resume ${path.basename(dir)}`,
    );
  }

  const tools = Object.fromEntries(
    Object.entries(snapshot.toolDefinitions ?? {}).map(([name, d]) => [name, d.description]),
  );
  const graded = !offline() && !opts.trial;
  if (graded) {
    reporter.log("Grading the runs and answering their checks…");
    reporter.progress({ phase: "grading", message: "Grading the runs and answering their checks" });
  }
  // A resumed check keeps the grades and check answers it already has: only runs without one are sent.
  const resumed = new Set(records.map(runKey));
  // ...as long as they were judged against what the tests say now: an edited test is judged again.
  const kept =
    graded && opts.resume
      ? stillValid(await savedVerdicts(dir, (v) => resumed.has(runKey(v))), tests, tools, config.writeTools)
      : { grades: [], checks: [] };
  const { ungraded, unchecked } = stillToJudge(kept, records);
  if (kept.grades.length || kept.checks.length)
    reporter.log(`Keeping ${kept.grades.length} saved grades and ${kept.checks.length} saved check answers`);
  // Grades and check answers don't depend on each other: ask for both at once.
  const [grades, checks] = graded
    ? await Promise.all([
        gradeRecords(ungraded, tests, { grader }),
        evaluateChecks(unchecked, tests, { tools, writeTools: config.writeTools, grader }),
      ])
    : [[], []];
  const verdicts = { grades: [...kept.grades, ...grades], checks: [...kept.checks, ...checks] };

  const result: HealthResult = {
    agentName: snapshot.name || config.agent,
    agentFile,
    createdAt: new Date().toISOString(),
    runsPerTest,
    graded,
    ...(opts.trial ? { trial: true } : {}),
    tests: tests.map((t) =>
      testHealth(
        t,
        records.filter((r) => r.test === t.name),
        verdicts,
        snapshot.model,
      ),
    ),
  };
  await writeJson(path.join(dir, "check.json"), result);
  await writeJson(path.join(dir, "grades.json"), verdicts.grades);
  await writeJson(path.join(dir, "checks.json"), verdicts.checks);
  await writeText(path.join(dir, "report.md"), healthReport(result));
  return { dir, result };
}

const runKey = (r: { test: string; run: number }) => `${r.test}#${r.run}`;
