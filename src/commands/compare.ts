import path from "node:path";
import chalk from "chalk";
import { loadConfig, fail } from "../config.ts";
import { loadTests } from "../tests.ts";
import { importAgent, extractSnapshot } from "../agent.ts";
import { runVersion } from "../runner.ts";
import { computeVersionStats, diffSnapshots, recordsFor } from "../compare.ts";
import { gradeRecords, scoresByTestVersion } from "../grader.ts";
import { explainComparison } from "../explainer.ts";
import { buildReport, printSummary } from "../report.ts";
import { addWorktree, fileExistsAtRef, isGitRepo, refExists, repoRoot } from "../git.ts";
import {
  BASELINE_DIR,
  baselineRunsDir,
  compareDir,
  compareRunsDir,
  exists,
  readJson,
  readJsonDir,
  timestamp,
  writeJson,
  writeText,
} from "../storage.ts";
import {
  SnapshotSchema,
  type Comparison,
  type Config,
  type RunRecord,
  type Snapshot,
  type TestComparison,
  type TestFile,
  type Version,
} from "../types.ts";

/** The "old" half of a comparison — from a git ref or the saved baseline. */
interface OldSide {
  snapshot: Snapshot;
  records: RunRecord[];
  label: string;
}

export async function compareCommand(
  ref?: string,
  opts: { config?: string } = {},
): Promise<void> {
  const { config, rootDir } = await loadConfig(opts.config);
  const tests = await loadTests(rootDir, config.tests);

  const newPath = config.versions?.new ?? config.agentPath;
  if (!newPath) {
    fail(`Config needs "versions.new" or "agentPath" to know which agent to run.`);
  }

  // Validate git preconditions before spending API calls on the new-agent runs.
  if (ref) await assertGitRef(ref, rootDir, newPath);

  console.log(chalk.bold(`AgentDiff compare — ${config.agent}`));

  const dir = compareDir(timestamp());

  // NEW side is always the working-tree agent.
  console.log(chalk.dim(`  new agent: ${newPath}${ref ? " (working tree)" : ""}`));
  const newAgent = await importAgent(rootDir, newPath, config.agent);
  const newSnapshot = await extractSnapshot(newAgent);
  await writeJson(path.join(dir, "snapshot.json"), newSnapshot);
  const newRecords = await runAll(newAgent, tests, "new", config.runsPerTest, compareRunsDir(dir), "new");

  // OLD side comes from a git ref (via a throwaway worktree) or the saved baseline.
  const old = ref
    ? await oldFromGit(ref, rootDir, newPath, config, tests, dir)
    : await oldFromBaseline(config);

  console.log(chalk.dim("  grading responses..."));
  const grades = await gradeRecords([...old.records, ...newRecords], tests);
  if (grades.length) await writeJson(path.join(dir, "grades.json"), grades);
  const scores = scoresByTestVersion(grades);

  const testComparisons: TestComparison[] = tests.map((t) => {
    const oldRuns = recordsFor(old.records, t.name, "old");
    const newRuns = recordsFor(newRecords, t.name, "new");
    const mustCall = t.must_call_tools ?? [];
    return {
      test: t.name,
      gradingCriteria: t.grading_criteria,
      mustCallTools: mustCall,
      old: computeVersionStats(oldRuns, old.snapshot.model, mustCall, scores.get(`${t.name}::old`)),
      new: computeVersionStats(newRuns, newSnapshot.model, mustCall, scores.get(`${t.name}::new`)),
    };
  });

  const comparison: Comparison = {
    agentName: newSnapshot.name || old.snapshot.name,
    oldFile: old.label,
    newFile: ref ? `${newPath} (working tree)` : newPath,
    runsPerTest: config.runsPerTest,
    oldSnapshot: old.snapshot,
    newSnapshot,
    snapshotDiff: diffSnapshots(old.snapshot, newSnapshot),
    tests: testComparisons,
  };
  await writeJson(path.join(dir, "comparison.json"), comparison);

  console.log(chalk.dim("  writing explanation..."));
  const explanation = await explainComparison(comparison, false);

  const report = buildReport(comparison, explanation);
  const reportPath = path.join(dir, "report.md");
  await writeText(reportPath, report);

  printSummary(comparison, explanation, reportPath);
}

/** Run every test N times for one agent version, streaming progress. */
async function runAll(
  agent: Record<string, any>,
  tests: TestFile[],
  version: Version,
  runsPerTest: number,
  runsDir: string,
  label: string,
): Promise<RunRecord[]> {
  const total = tests.length * runsPerTest;
  let done = 0;
  console.log(chalk.dim(`  ${label}: ${tests.length} test(s) × ${runsPerTest} = ${total} runs...`));
  const records = await runVersion({
    agent,
    tests,
    version,
    runsPerTest,
    runsDir,
    onRun: (r) => {
      done++;
      const mark = r.error ? chalk.red("x") : chalk.green("✓");
      process.stdout.write(`\r  ${label} ${mark} ${done}/${total} runs saved`);
    },
  });
  process.stdout.write("\n");
  return records;
}

/** Fail early (before running the new agent) if the ref can't be compared. */
async function assertGitRef(ref: string, rootDir: string, newPath: string): Promise<void> {
  if (!(await isGitRepo(rootDir))) {
    fail(`"agentdiff compare ${ref}" needs a git repository, but ${rootDir} isn't one.`);
  }
  if (!(await refExists(ref, rootDir))) {
    fail(`Git ref "${ref}" not found. Use a branch, tag, or commit (e.g. HEAD~1, main).`);
  }
  const root = await repoRoot(rootDir);
  const relFromRoot = path.relative(root, path.resolve(rootDir, newPath));
  if (!(await fileExistsAtRef(ref, relFromRoot, rootDir))) {
    fail(`Agent file "${relFromRoot}" does not exist at ref "${ref}".`);
  }
}

/** Old agent = the working-tree file checked out at `ref` in a temp worktree. */
async function oldFromGit(
  ref: string,
  rootDir: string,
  newPath: string,
  config: Config,
  tests: TestFile[],
  dir: string,
): Promise<OldSide> {
  const root = await repoRoot(rootDir);
  const relFromRoot = path.relative(root, path.resolve(rootDir, newPath));

  console.log(chalk.dim(`  old agent: ${newPath} @ ${ref}`));
  const worktree = await addWorktree(ref, rootDir);
  try {
    const oldAgent = await importAgent(worktree.dir, relFromRoot, config.agent);
    const snapshot = await extractSnapshot(oldAgent);
    await writeJson(path.join(dir, "old-snapshot.json"), snapshot);
    const records = await runAll(
      oldAgent,
      tests,
      "old",
      config.runsPerTest,
      path.join(dir, "old-runs"),
      "old",
    );
    return { snapshot, records, label: `${newPath} @ ${ref}` };
  } finally {
    await worktree.cleanup();
  }
}

/** Old agent = the snapshot + runs saved by `agentdiff baseline`. */
async function oldFromBaseline(config: Config): Promise<OldSide> {
  const baselineSnapPath = path.join(BASELINE_DIR, "snapshot.json");
  if (!(await exists(baselineSnapPath))) {
    fail(
      `No baseline found. Run "agentdiff baseline" first, ` +
        `or compare against a git ref (e.g. "agentdiff compare main").`,
    );
  }
  const snapshot = SnapshotSchema.parse(await readJson<Snapshot>(baselineSnapPath));
  const records = await readJsonDir<RunRecord>(baselineRunsDir());
  return { snapshot, records, label: config.versions?.old ?? "baseline" };
}
