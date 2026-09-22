import path from "node:path";
import { loadConfig } from "../config/load.ts";
import { importAgent, type AnyAgent } from "../agent/load.ts";
import { extractSnapshot } from "../agent/snapshot.ts";
import { snapshotUnchanged } from "../compare/snapshot-diff.ts";
import { compareTests, type Verdicts } from "../compare/confirm.ts";
import { changeKind, type ChangeKind } from "../compare/change-kind.ts";
import { gradeRecords } from "../grade/grader.ts";
import { evaluateChecks } from "../grade/checks.ts";
import { graderKind, missingKeys, offline } from "../lib/llm.ts";
import { errMessage, fail } from "../lib/errors.ts";
import { runTests } from "../pipeline/run-tests.ts";
import { silentReporter, type Reporter } from "../pipeline/reporter.ts";
import { loadTests } from "../suite/load.ts";
import { rm, writeJson, writeText } from "../storage/fs.ts";
import { timestamp } from "../storage/workspace.ts";
import type { RunRecord, TestFile } from "../types.ts";
import { savedBaseline } from "../health/baseline.ts";
import { testHealth } from "../health/health.ts";
import { stillToJudge, stillValid } from "../grade/basis.ts";
import { byRelevance, mutants, pick, type Mutant } from "./mutants.ts";
import { promptSources, writeChain } from "./sources.ts";
import { mutationReport } from "./report.ts";

/** A test's label against one seeded regression. */
export interface Flag {
  test: string;
  kind: ChangeKind;
}

export interface MutantResult {
  id: string;
  kind: Mutant["kind"];
  removed: string;
  /** A test broke a rule or got worse: the suite caught it. */
  caught: boolean;
  /** Tests labelled `rule` or `worse`. */
  caughtBy: Flag[];
  /** Tests that moved some other way: different, better, or not in both halves. */
  moved: Flag[];
  /** Tests run on this copy: the most related first, stopping at the first batch that catches it. */
  testsRun: number;
  /** The file the removed sentence was in, when it isn't the agent file. */
  file?: string;
}

export interface MutationResult {
  file: string;
  agentName: string;
  createdAt: string;
  runsPerTest: number;
  tests: number;
  /** Rule sentences and guardrails found, before `max` picked some. */
  found: number;
  /** The check-* folder whose runs and grades stood in for the agent's own, if any. */
  baseline?: string;
  /** Copies that weren't run: they failed to load, or loaded identical to the agent. */
  skipped: { id: string; removed: string; reason: string }[];
  mutants: MutantResult[];
}

export interface MutateOptions {
  config?: string;
  /** The agent file to seed regressions into. Default: agentPath, else versions.old. */
  file?: string;
  /** Runs per test, on the agent and on each copy. At least 2, so a change has to repeat in both halves. */
  runs?: number;
  /** Most copies to run. */
  max?: number;
  /** A check-* folder of this agent file, every test run at least `runs` times: its runs and grades are the agent's side, so the agent isn't run again. */
  baseline?: string;
  reporter?: Reporter;
}

/**
 * Mutation testing for an agent's tests: copy the agent with one rule
 * sentence or one guardrail removed, run the suite on each copy and on the
 * agent, and count the copies the suite catches (a test that breaks a rule or
 * gets worse). A copy nothing catches points at a rule no test covers.
 *
 * Each copy runs the tests most related to what it lost first, a batch at a
 * time, and stops at the first batch that catches it: only a copy nothing
 * catches runs the whole suite.
 */
export async function runMutation(opts: MutateOptions = {}): Promise<{ dir: string; result: MutationResult }> {
  const reporter = opts.reporter ?? silentReporter;
  const { config, rootDir, workspace } = await loadConfig(opts.config);
  const file = opts.file ?? config.agentPath ?? config.versions!.old;
  const runs = opts.runs ?? 4;
  if (runs < 2) fail("--runs must be at least 2: a seeded regression has to show up in both halves of the runs.");
  const grader = graderKind(config.grader);
  const missing = offline() ? [] : missingKeys(grader);
  if (missing.length)
    fail(
      `Grading needs these keys:\n${missing.map((m) => `  ${m.key} — ${m.for}`).join("\n")}\n` +
        `Set them in .env, or set AGENTDIFF_OFFLINE=1 to count only broken rules.`,
    );

  const tests = (await loadTests(rootDir, config.tests)).filter((t) => !t.replay);
  if (!tests.length) fail(`No tests to run in ${config.tests} (recorded incidents can't run against changed prompts).`);
  const agentFile = path.resolve(rootDir, file);
  const load = (rel: string) => importAgent(rootDir, rel, config.agent, { maxTurns: config.maxTurns });
  const agent = await load(file);
  const snapshot = await extractSnapshot(agent);
  // The prompt may be in a file the agent imports: look there too, nearest first.
  const sources = await promptSources(agentFile);
  const seen = new Set<string>();
  const found = sources
    .flatMap((s) => mutants(s.source, snapshot.instructions).map((m) => ({ ...m, chain: s.chain })))
    .filter((m) => !seen.has(`${m.kind}:${m.removed}`) && seen.add(`${m.kind}:${m.removed}`))
    .map((m, i) => ({ ...m, id: `m${String(i + 1).padStart(2, "0")}` }));
  if (!found.length)
    fail(
      `Found no rule sentences or guardrail lists in ${file} or the files it imports. Mutation testing edits the ` +
        `agent's source, so its prompt has to be written there as text.`,
    );
  const chosen = pick(found, opts.max ?? 12);
  reporter.log(`agentdiff mutate — ${snapshot.name || config.agent}`, "heading");
  reporter.log(
    `${found.length} rules and guardrails found; seeding ${chosen.length}, ${tests.length} tests × ${runs} runs`,
  );

  // Each copy sits next to its original, so the other relative imports resolve the same way.
  const loaded: { mutant: (typeof chosen)[number]; agent: AnyAgent }[] = [];
  const skipped: MutationResult["skipped"] = [];
  const copies: string[] = [];
  try {
    for (const mutant of chosen) {
      const { entry, written } = await writeChain(mutant.chain, mutant.source, mutant.id);
      copies.push(...written);
      try {
        const m = await load(path.relative(rootDir, entry));
        if (snapshotUnchanged(snapshot, await extractSnapshot(m)))
          skipped.push({ id: mutant.id, removed: mutant.removed, reason: "loads identical to the agent" });
        else loaded.push({ mutant, agent: m });
      } catch (err) {
        skipped.push({ id: mutant.id, removed: mutant.removed, reason: errMessage(err).split("\n")[0] });
      }
    }
  } finally {
    // The copies are imported by now; nothing needs them on disk.
    await Promise.all(copies.map((c) => rm(c)));
  }

  const dir = path.join(workspace.dir, `mutate-${timestamp()}`);
  const report = { progress() {}, log: (t: string) => reporter.log(t, "detail"), runSaved: reporter.runSaved };
  const tools = Object.fromEntries(
    Object.entries(snapshot.toolDefinitions ?? {}).map(([name, d]) => [name, d.description]),
  );
  const judge = async (records: RunRecord[], judged: TestFile[]): Promise<Verdicts> =>
    offline()
      ? { grades: [], checks: [] }
      : await Promise.all([
          gradeRecords(records, judged, { grader }),
          evaluateChecks(records, judged, { tools, writeTools: config.writeTools, grader }),
        ]).then(([grades, checks]) => ({ grades, checks }));
  const run = async (a: AnyAgent, version: "old" | "new", runsDir: string, label: string, only: TestFile[]) =>
    (
      await runTests({
        sides: [{ agent: a, version, runsDir, label }],
        tests: only,
        runsPerTest: runs,
        concurrency: config.concurrency,
        report,
      })
    )[version];

  let base: RunRecord[];
  let baseVerdicts: Verdicts;
  if (opts.baseline) {
    const saved = await savedBaseline(workspace.dir, opts.baseline, file, tests, runs);
    base = saved.records;
    // Verdicts judged against an older wording of a test are redone; the rest are reused.
    const valid = offline() ? { grades: [], checks: [] } : stillValid(saved.verdicts, tests, tools, config.writeTools);
    const { ungraded, unchecked } = stillToJudge(valid, offline() ? [] : base);
    const [grades, checks] = await Promise.all([
      gradeRecords(ungraded, tests, { grader }),
      evaluateChecks(unchecked, tests, { tools, writeTools: config.writeTools, grader }),
    ]);
    baseVerdicts = { grades: [...valid.grades, ...grades], checks: [...valid.checks, ...checks] };
    reporter.log(
      `the agent: ${base.length} runs from ${opts.baseline}, ${valid.grades.length} saved grades and ${valid.checks.length} saved check answers kept`,
      "section",
    );
  } else {
    reporter.log("the agent as it is", "section");
    base = await run(agent, "old", path.join(dir, "agent"), "agent", tests);
    baseVerdicts = await judge(base, tests);
  }

  // Saved next to the copies' verdicts, so a "worse" catch can be checked against both sides.
  await writeJson(path.join(dir, "verdicts", "agent.json"), baseVerdicts);
  // Tests whose own runs disagree (check's "unpredictable"): a judge scoring them lower is no evidence a
  // rule is missing, so they catch a copy only by breaking a tool rule, which is read from the calls.
  const shaky = new Set(
    tests
      .filter(
        (t) =>
          testHealth(
            t,
            base.filter((r) => r.test === t.name),
            baseVerdicts,
            snapshot.model,
          ).unsteady.length,
      )
      .map((t) => t.name),
  );
  // Twice the run slots' worth of tests per batch: the next batch's runs are already queued while the
  // slowest runs of this one finish, and a copy caught in the first batch still stops early.
  const batchSize = Math.max(1, Math.ceil((config.concurrency * 2) / runs));
  const results: MutantResult[] = [];
  for (const [i, { mutant, agent: m }] of loaded.entries()) {
    reporter.log(`${i + 1}/${loaded.length} without: ${mutant.removed}`, "section");
    const order = byRelevance(tests, mutant.removed);
    const caughtBy: Flag[] = [];
    const moved: Flag[] = [];
    let testsRun = 0;
    const judged: Verdicts = { grades: [], checks: [] };
    for (let at = 0; at < order.length && !caughtBy.length; at += batchSize) {
      const batch = order.slice(at, at + batchSize);
      const records = await run(m, "new", path.join(dir, mutant.id), mutant.id, batch);
      const verdicts = await judge(records, batch);
      judged.grades.push(...verdicts.grades);
      judged.checks.push(...verdicts.checks);
      const compared = compareTests(
        batch,
        { records: base, model: snapshot.model },
        { records, model: snapshot.model },
        { grades: [...baseVerdicts.grades, ...verdicts.grades], checks: [...baseVerdicts.checks, ...verdicts.checks] },
        runs,
      );
      for (const t of compared) {
        const kind = changeKind(t, config.writeTools);
        const counts = kind === "rule" || (kind === "worse" && !shaky.has(t.test));
        if (counts) caughtBy.push({ test: t.test, kind });
        else if (kind !== "same") moved.push({ test: t.test, kind });
      }
      testsRun += batch.length;
    }
    // Saved next to the runs, so a catch can be checked later against the grades that made it.
    await writeJson(path.join(dir, "verdicts", `${mutant.id}.json`), judged);
    const sourceFile = mutant.chain.at(-1)!;
    const result: MutantResult = {
      id: mutant.id,
      kind: mutant.kind,
      removed: mutant.removed,
      caught: caughtBy.length > 0,
      caughtBy,
      moved,
      testsRun,
      ...(sourceFile !== agentFile ? { file: path.relative(rootDir, sourceFile) } : {}),
    };
    results.push(result);
    reporter.log(
      result.caught
        ? `caught by ${caughtBy.map((f) => f.test).join(", ")} (${testsRun} of ${tests.length} tests run)`
        : "not caught",
      result.caught ? "success" : "warning",
    );
  }

  const result: MutationResult = {
    file,
    agentName: snapshot.name || config.agent,
    createdAt: new Date().toISOString(),
    runsPerTest: runs,
    tests: tests.length,
    found: found.length,
    ...(opts.baseline ? { baseline: opts.baseline } : {}),
    skipped,
    mutants: results,
  };
  await writeJson(path.join(dir, "mutation.json"), result);
  await writeText(path.join(dir, "report.md"), mutationReport(result));
  return { dir, result };
}
