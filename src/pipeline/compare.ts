import path from "node:path";
import { loadConfig } from "../config/load.ts";
import type { AnyAgent } from "../agent/load.ts";
import { fail } from "../lib/errors.ts";
import { missingTools, missingToolsMessage } from "../suite/lint.ts";
import { loadTests } from "../suite/load.ts";
import { whyStop } from "../health/early-stop.ts";
import { savedBaseline } from "../health/baseline.ts";
import { stillToJudge, stillValid } from "../grade/basis.ts";
import { importAgent } from "../agent/load.ts";
import { extractSnapshot } from "../agent/snapshot.ts";
import { RunsStopped, runTests } from "./run-tests.ts";
import { Stages } from "./stages.ts";
import type { JobProgress } from "./progress.ts";
import { silentReporter, type Reporter } from "./reporter.ts";
import { diffSnapshots, snapshotUnchanged } from "../compare/snapshot-diff.ts";
import { gradeRecords } from "../grade/grader.ts";
import { evaluateChecks } from "../grade/checks.ts";
import { explainComparison } from "../explain/explain.ts";
import { graderKind, hasApiKey, missingKeys, offline, type GraderKind } from "../lib/llm.ts";
import { buildReport } from "../report/markdown.ts";
import { failedSides } from "../compare/signals.ts";
import { changeKind } from "../compare/change-kind.ts";
import { compareSides, compareTests, confirmationSummary, type Verdicts } from "../compare/confirm.ts";
import { addWorktree, fileExistsAtRef, isGitRepo, refExists, repoRoot, type Worktree } from "../lib/git.ts";
import { runDiscovery } from "../discovery/index.ts";
import { DiscoveryConfigSchema, type DiscoveryConfig, type DiscoveryResult } from "../discovery/types.ts";
import { writeJson, writeText } from "../storage/fs.ts";
import { COMPARE_FILES, runRecordPath } from "../storage/workspace.ts";
import { type Comparison, type Config, type RunRecord, type StageResult, type TestFile } from "../types.ts";

export interface CompareOptions {
  /** Used by a reviewed incident replay; never mixed with unrelated live-tool tests. */
  tests?: TestFile[];
  config?: string;
  /** Skip the runs when the agent snapshot matches the other side. */
  ifChanged?: boolean;
  /** Overrides the config's discovery settings for this run. */
  discovery?: DiscoveryConfig;
  /** A finished check-* folder of versions.old: its runs and grades are the old side, so it isn't run again. Files mode only. */
  baseline?: string;
  /** Where progress and log lines go; silent by default. */
  reporter?: Reporter;
}

export type CompareResult =
  { skipped: true; reason: string } | { skipped: false; dir: string; reportPath: string; comparison: Comparison };

function resolveNewPath(config: Config, ref?: string): string {
  if (ref) {
    if (!config.agentPath) {
      fail(`Git compare needs "agentPath" in the config — the single agent file to diff against ${ref}.`);
    }
    return config.agentPath;
  }
  if (!config.versions) {
    fail(
      `Pass a git ref to compare against (e.g. "agentdiff compare main"), or set versions: { old, new } in the config.`,
    );
  }
  return config.versions.new;
}

/**
 * One comparison, always the same seven stages: collect the tests, snapshot
 * both agents, run every test on both, discover new cases aimed at the change,
 * judge every run, explain the difference, save the result. The old side is a
 * git ref or `versions.old`, run fresh every time.
 */
export async function runComparison(ref?: string, opts: CompareOptions = {}): Promise<CompareResult> {
  const reporter = opts.reporter ?? silentReporter;
  const { config, rootDir, workspace } = await loadConfig(opts.config);
  const stages = new Stages(reporter);
  if (opts.baseline && ref)
    fail("--baseline works with versions: { old, new }, not a git ref: a check is of the file as it is now.");
  const newPath = resolveNewPath(config, ref);
  const grader = graderKind(config.grader);
  // Every stage runs, so every key it needs has to be there before any agent does.
  const missing = offline() ? [] : missingKeys(grader);
  if (missing.length) {
    fail(
      `A comparison runs every stage, and these keys are missing:\n` +
        missing.map((m) => `  ${m.key} — ${m.for}`).join("\n") +
        `\nSet them in .env, or set AGENTDIFF_OFFLINE=1 to run only the agents and the exact comparison.`,
    );
  }
  reporter.log(`AgentDiff compare — ${config.agent}`, "heading");
  reporter.log(
    `judged by ${grader === "jev" ? "Jev" : "OpenAI"}${offline() ? " · offline: no model calls from agentdiff" : ""}`,
  );

  stages.begin("collect", "Loading the tests");
  const tests = opts.tests ?? (await loadTests(rootDir, config.tests));
  // Incident tests answer their tools from one recording, so discovery plans only from the others.
  const discoverable = tests.filter((t) => !t.replay);
  const discovery = DiscoveryConfigSchema.parse(opts.discovery ?? config.discovery ?? {});
  if (ref) {
    const git = await assertGitRef(ref, rootDir, newPath);
    if (!git.fileAtRef) {
      if (opts.ifChanged) {
        const reason = `Agent file "${newPath}" does not exist at ${ref} — nothing to compare.`;
        reporter.log(reason);
        return { skipped: true, reason };
      }
      const root = await repoRoot(rootDir);
      fail(`Agent file "${path.relative(root, path.resolve(rootDir, newPath))}" does not exist at ref "${ref}".`);
    }
  }
  stages.end("done", `${tests.length} test${tests.length === 1 ? "" : "s"}`);

  stages.begin("snapshot", "Loading both agents");
  let worktree: Worktree | undefined;
  try {
    const newAgent = await importAgent(rootDir, newPath, config.agent, { maxTurns: config.maxTurns });
    const newSnapshot = await extractSnapshot(newAgent);
    let oldAgent: AnyAgent;
    let oldLabel: string;
    if (ref) {
      const root = await repoRoot(rootDir);
      worktree = await addWorktree(ref, rootDir);
      oldAgent = await importAgent(worktree.dir, path.relative(root, path.resolve(rootDir, newPath)), config.agent, {
        maxTurns: config.maxTurns,
      });
      oldLabel = `${newPath} @ ${ref}`;
    } else {
      oldAgent = await importAgent(rootDir, config.versions!.old, config.agent, { maxTurns: config.maxTurns });
      oldLabel = config.versions!.old;
    }
    const oldSnapshot = await extractSnapshot(oldAgent);
    // A tool either version has is fair to require; one neither has makes the test fail on both.
    const agentTools = [...new Set([...oldSnapshot.tools, ...newSnapshot.tools])];
    const lacking = missingTools(tests, agentTools);
    if (lacking.length) fail(missingToolsMessage(lacking, agentTools));
    stages.log(`old agent: ${oldLabel}`);
    stages.log(`new agent: ${newPath}${ref ? " (working tree)" : ""}`);
    if (opts.ifChanged && snapshotUnchanged(oldSnapshot, newSnapshot)) {
      const reason = `Agent snapshot unchanged vs ${ref ?? oldLabel} — nothing to compare.`;
      reporter.log(reason);
      return { skipped: true, reason };
    }
    const dir = workspace.newCompareDir();
    stages.withDir(dir);
    await writeJson(path.join(dir, COMPARE_FILES.newSnapshot), newSnapshot);
    await writeJson(path.join(dir, COMPARE_FILES.oldSnapshot), oldSnapshot);
    stages.end(
      "done",
      snapshotUnchanged(oldSnapshot, newSnapshot)
        ? "the two agents are identical"
        : describeDiff(diffSnapshots(oldSnapshot, newSnapshot)),
    );

    stages.begin("run", `Running ${tests.length} tests on both agents`);
    const total = tests.length * config.runsPerTest * 2;
    // A finished check of the old file is its side already: copy its runs in and reuse its grades.
    let baseline: Awaited<ReturnType<typeof savedBaseline>> | undefined;
    if (opts.baseline) {
      baseline = await savedBaseline(workspace.dir, opts.baseline, config.versions!.old, tests, config.runsPerTest);
      // Its run times were measured at another time, under another load: comparing them with the new side's would measure the provider.
      baseline.records = baseline.records.map((r) => ({ ...r, latency_ms: null }));
      for (const r of baseline.records)
        await writeJson(runRecordPath(path.join(dir, COMPARE_FILES.oldRuns), r.test, r.run), r);
      stages.log(`old agent: ${baseline.records.length} runs and their grades from ${opts.baseline}`);
    }
    const { old: oldRecords, new: newRecords } = await runTests({
      tests,
      reuse: baseline?.records,
      shouldStop: (done) => whyStop(tests, done),
      runsPerTest: config.runsPerTest,
      concurrency: config.concurrency,
      report: stages,
      sides: [
        {
          agent: oldAgent,
          version: "old",
          runsDir: path.join(dir, COMPARE_FILES.oldRuns),
          label: ref ? `Original agent (${ref})` : "Original agent",
        },
        {
          agent: newAgent,
          version: "new",
          runsDir: path.join(dir, COMPARE_FILES.newRuns),
          label: ref ? "Updated agent (working tree)" : "Updated agent",
        },
      ],
    }).catch((err: unknown) => {
      if (!(err instanceof RunsStopped)) throw err;
      stages.end("error", `stopped after ${err.saved} runs`);
      return fail(`Stopped after ${err.saved} runs: ${err.reason}`);
    });
    const errored = [...oldRecords, ...newRecords].filter((r) => r.error).length;
    stages.end(
      errored === total ? "error" : "done",
      `${total - errored} of ${total} runs finished${errored ? `, ${errored} errored` : ""}`,
    );

    stages.begin("discover", "Planning new inputs aimed at the change");
    let discoveryResult: DiscoveryResult | undefined;
    if (!discoverable.length) {
      stages.end("skipped", "every test is a recorded incident, which new cases can't be built from");
    } else if (offline()) {
      stages.end("blocked", "offline");
    } else {
      discoveryResult = await runDiscovery({
        agents: { old: oldAgent, new: newAgent },
        oldSnapshot,
        newSnapshot,
        tests: discoverable,
        config: discovery,
        concurrency: config.concurrency,
        rootDir,
        dir,
        onProgress: (message) => {
          stages.log(`discovery: ${message}`);
          stages.progress({ message });
        },
        onCheckpoint: (result) => stages.progress(discoveryProgress(result)),
      });
      stages.end(...discoveryStage(discoveryResult));
    }

    return await finishComparison({
      dir,
      ref,
      newPath,
      tests,
      stages,
      runsPerTest: config.runsPerTest,
      writeTools: config.writeTools,
      grader,
      old: { snapshot: oldSnapshot, records: oldRecords, label: oldLabel },
      newSnapshot,
      newRecords,
      discovery: discoveryResult,
      baseline: opts.baseline,
      kept: baseline && stillValid(baseline.verdicts, tests, judgeTools(oldSnapshot, newSnapshot), config.writeTools),
    });
  } finally {
    await worktree?.cleanup();
  }
}

function describeDiff(d: Comparison["snapshotDiff"]): string {
  const parts = [
    d.instructionsDiff ? "instructions" : "",
    d.toolsAdded.length || d.toolsRemoved.length ? "tools" : "",
    d.toolDefinitionsChanged?.length ? "tool definitions" : "",
    d.workflowsAdded.length || d.workflowsRemoved.length ? "workflows" : "",
    ...d.settingsChanged.map((s) => s.key),
  ].filter(Boolean);
  return `changed: ${[...new Set(parts)].join(", ")}`;
}

/** Dashboard progress for a discovery checkpoint: the latest experiment and the agent runs used so far. */
function discoveryProgress(result: DiscoveryResult): Omit<JobProgress, "phase" | "stage"> {
  const latest = result.experiments.at(-1);
  const agentRuns = result.experiments.reduce(
    (n, e) => n + e.cases.reduce((sum, c) => sum + c.old.length + c.new.length, 0),
    0,
  );
  return {
    message: latest ? `${latest.phase}: ${latest.probe.name}` : "Planning new inputs",
    completed: agentRuns,
    limit: result.config.maxAgentRuns,
  };
}

function discoveryStage(d: DiscoveryResult): [StageResult["status"], string] {
  const found = `${d.findings.length} finding${d.findings.length === 1 ? "" : "s"} from ${d.experiments.length} experiment${d.experiments.length === 1 ? "" : "s"}, ${d.agentRuns} runs`;
  if (d.status === "complete")
    return d.experiments.length ? ["done", found] : ["skipped", d.reason ?? "nothing to investigate"];
  if (d.status === "limited") return ["done", `${found}; stopped at the run limit`];
  return [d.status === "blocked" ? "blocked" : "error", d.reason ?? "discovery could not run"];
}

async function finishComparison(args: {
  dir: string;
  ref?: string;
  newPath: string;
  tests: TestFile[];
  stages: Stages;
  runsPerTest: number;
  writeTools?: string[];
  grader: GraderKind;
  old: { snapshot: Comparison["oldSnapshot"]; records: RunRecord[]; label: string };
  newSnapshot: Comparison["newSnapshot"];
  newRecords: RunRecord[];
  discovery?: DiscoveryResult;
  /** The check-* folder the old side came from, if any. */
  baseline?: string;
  /** Grades and check answers already saved for some runs (a baseline check's): only the rest are judged. */
  kept?: Verdicts;
}): Promise<CompareResult> {
  const { dir, ref, newPath, tests, stages, runsPerTest, writeTools, grader, old, newSnapshot, newRecords } = args;
  const records = [...old.records, ...newRecords];

  stages.begin("judge", "Grading runs, answering checks and confirming what changed");
  const warn = (text: string) => stages.log(text);
  // What each tool is for, so the built-in checks can judge the calls.
  const tools = judgeTools(old.snapshot, newSnapshot);
  const kept = args.kept ?? { grades: [], checks: [] };
  if (kept.grades.length || kept.checks.length)
    stages.log(`Keeping ${kept.grades.length} saved grades and ${kept.checks.length} saved check answers`);
  const { ungraded, unchecked } = stillToJudge(kept, records);
  // Grades and check answers don't depend on each other: ask for both at once.
  const [newGrades, newChecks] = offline()
    ? [[], []]
    : await Promise.all([
        gradeRecords(ungraded, tests, { grader, warn }),
        evaluateChecks(unchecked, tests, { tools, writeTools, grader, warn }),
      ]);
  const grades = offline() ? [] : [...kept.grades, ...newGrades];
  const checks = offline() ? [] : [...kept.checks, ...newChecks];
  if (grades.length) await writeJson(path.join(dir, COMPARE_FILES.grades), grades);
  const failedChecks = checks.filter((c) => c.error);
  if (checks.length) {
    await writeJson(path.join(dir, COMPARE_FILES.checks), checks);
    if (failedChecks.length)
      stages.log(`(${failedChecks.length} of ${checks.length} outcome checks failed: ${failedChecks[0].error})`);
  }

  const testComparisons = compareTests(
    tests,
    { records: old.records, model: old.snapshot.model },
    { records: newRecords, model: newSnapshot.model },
    { grades, checks },
    runsPerTest,
  );
  const judgedFindings =
    args.discovery && !offline()
      ? await judgeFindings(args.discovery, {
          tools,
          writeTools,
          grader,
          oldModel: old.snapshot.model,
          newModel: newSnapshot.model,
        })
      : 0;
  const [judgeStatus, judgeDetail] = judgeStage(records, tests, grades.length, checks.length, failedChecks.length);
  stages.end(
    judgeStatus,
    `${offline() ? "offline; " : ""}${judgeDetail}; ${confirmationSummary(testComparisons)}${judgedFindings ? `; ${judgedFindings} discovery finding${judgedFindings === 1 ? "" : "s"} judged` : ""}`,
  );

  const comparison: Comparison = {
    ...(args.baseline ? { baseline: args.baseline } : {}),
    stages: stages.results,
    ...(args.discovery ? { discovery: args.discovery } : {}),
    agentName: newSnapshot.name || old.snapshot.name,
    oldFile: old.label,
    newFile: ref ? `${newPath} (working tree)` : newPath,
    runsPerTest,
    grader,
    createdAt: new Date().toISOString(),
    oldSnapshot: old.snapshot,
    newSnapshot,
    snapshotDiff: diffSnapshots(old.snapshot, newSnapshot),
    ...(writeTools?.length ? { writeTools } : {}),
    tests: testComparisons,
  };
  await writeJson(path.join(dir, COMPARE_FILES.comparison), comparison);

  stages.begin("explain", "Writing the explanation");
  let explanation = "";
  if (failedSides(comparison).length) {
    // Nothing to explain when a side never ran; don't spend a call on zeros.
    stages.end("skipped", "a side never finished a run");
  } else if (offline() || !hasApiKey()) {
    stages.end("blocked", offline() ? "offline" : "no OpenAI key to write the explanation");
  } else {
    explanation = await explainComparison(comparison, { detail: "short" });
    comparison.explanation = explanation;
    const failed = explanation.startsWith("(AI explanation failed");
    stages.end(failed ? "error" : "done", failed ? explanation.slice(1, -1) : "written");
  }

  stages.begin("save", "Saving the comparison and report");
  const reportPath = path.join(dir, COMPARE_FILES.report);
  await writeText(reportPath, buildReport(comparison, explanation));
  stages.end("done", reportPath);
  await writeJson(path.join(dir, COMPARE_FILES.comparison), comparison);

  return { skipped: false, dir, reportPath, comparison };
}

/**
 * Judge each discovery finding's confirmation runs like suite runs: graded
 * against the case's own expected behaviour, with the built-in checks. Each
 * case then gets the same label a test would. Returns how many were judged.
 */
async function judgeFindings(
  discovery: DiscoveryResult,
  o: { tools: Record<string, string>; writeTools?: string[]; grader: GraderKind; oldModel: string; newModel: string },
): Promise<number> {
  for (const f of discovery.findings) {
    f.judged = [];
    f.kinds = [];
    for (const c of f.cases) {
      const t: TestFile = {
        name: c.old[0]?.test ?? c.new[0]?.test ?? f.id,
        input: c.input,
        ...(c.conversation?.length ? { conversation: c.conversation } : {}),
        ...(c.context ? { context: c.context } : {}),
        ...(c.expected ? { grading_criteria: c.expected } : {}),
      };
      const runs = [...c.old, ...c.new];
      const verdicts = {
        grades: await gradeRecords(runs, [t], { grader: o.grader }),
        checks: await evaluateChecks(runs, [t], { tools: o.tools, writeTools: o.writeTools, grader: o.grader }),
      };
      const judged = compareSides(t, { runs: c.old, model: o.oldModel }, { runs: c.new, model: o.newModel }, verdicts);
      f.judged.push({ old: judged.old, new: judged.new });
      f.kinds.push(changeKind(judged, o.writeTools));
    }
  }
  return discovery.findings.length;
}

/** Judging is blocked when a key it needs is missing, so the report can say which verdicts are absent. */
function judgeStage(
  records: RunRecord[],
  tests: TestFile[],
  grades: number,
  checks: number,
  failedChecks: number,
): [StageResult["status"], string] {
  const finished = records.filter((r) => !r.error);
  const criteria = new Set(tests.filter((t) => t.grading_criteria).map((t) => t.name));
  const missing = [
    finished.some((r) => criteria.has(r.test)) && !grades ? "grades" : "",
    finished.length && !checks ? "checks" : "",
  ].filter(Boolean);
  const judged = `${grades} grades, ${checks - failedChecks} runs checked`;
  if (missing.length) return ["blocked", `${judged}; missing ${missing.join(" and ")}`];
  if (failedChecks) return ["error", `${judged}; ${failedChecks} check calls failed`];
  return ["done", judged];
}

/** Fail early if the ref is unusable. `fileAtRef` is false when the agent is new at this ref. */
async function assertGitRef(ref: string, rootDir: string, newPath: string): Promise<{ fileAtRef: boolean }> {
  if (!(await isGitRepo(rootDir))) {
    fail(`"agentdiff compare ${ref}" needs a git repository, but ${rootDir} isn't one.`);
  }
  if (!(await refExists(ref, rootDir))) {
    fail(`Git ref "${ref}" not found. Use a branch, tag, or commit (e.g. HEAD~1, main).`);
  }
  const root = await repoRoot(rootDir);
  const relFromRoot = path.relative(root, path.resolve(rootDir, newPath));
  return { fileAtRef: await fileExistsAtRef(ref, relFromRoot, rootDir) };
}

/** What each tool is for, from both versions, as the checks are told: both sides are judged against the same list. */
function judgeTools(old: Comparison["oldSnapshot"], neu: Comparison["newSnapshot"]): Record<string, string> {
  return Object.fromEntries(
    Object.entries({ ...old.toolDefinitions, ...neu.toolDefinitions }).map(([name, d]) => [name, d.description]),
  );
}
