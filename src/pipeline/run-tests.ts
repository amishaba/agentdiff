import type { RunRecord, TestFile, Version } from "../types.ts";
import { runOnce } from "../agent/execute.ts";
import type { AnyAgent } from "../agent/load.ts";
import { placeDecisions, recordDecisions } from "../agent/decisions.ts";
import { mapLimit } from "../lib/async.ts";
import { writeJson } from "../storage/fs.ts";
import { runRecordPath } from "../storage/workspace.ts";
import type { Stages } from "./stages.ts";

/** One version to run: its agent, where its run records go, and its name in progress. */
export interface Side {
  agent: AnyAgent;
  version: Version;
  /** Each run record is saved here as `<test-slug>-<run>.json`. */
  runsDir: string;
  /** Names this side in progress, e.g. "Updated agent (working tree)". */
  label?: string;
}

export interface RunTestsOptions {
  sides: Side[];
  tests: TestFile[];
  runsPerTest: number;
  /** Runs in flight at once, across every side. */
  concurrency: number;
  /** Where progress goes; a compare passes its current stage. */
  report?: Pick<Stages, "progress" | "log" | "runSaved">;
  /** Runs already saved (a resumed check, or a compare --baseline's old side): used as they are, not run again. */
  reuse?: RunRecord[];
  /**
   * Asked after every run with the runs so far: a reason stops the batch, so a
   * suite that can't pass doesn't spend the rest of its runs. Runs not started
   * are skipped and runTests throws RunsStopped; the saved ones stay on disk.
   */
  shouldStop?: (records: RunRecord[]) => string | null;
}

/** A batch stopped early by shouldStop, with its reason and how many runs it saved. */
export class RunsStopped extends Error {
  constructor(
    readonly reason: string,
    readonly saved: number,
  ) {
    super(reason);
    this.name = "RunsStopped";
  }
}

/**
 * Run every test N times on each side, saving each run record as it finishes.
 * The sides' runs are interleaved (old 1, new 1, old 2, …), so a provider that
 * slows down partway through slows both versions alike.
 */
export async function runTests(opts: RunTestsOptions): Promise<Record<Version, RunRecord[]>> {
  const { sides, tests, runsPerTest, concurrency, report } = opts;
  const label = (s: Side) => s.label ?? `${s.version} agent`;
  const perSide = tests.length * runsPerTest;
  const total = perSide * sides.length;
  const jobs = tests.flatMap((test) =>
    Array.from({ length: runsPerTest }, (_, i) => sides.map((side) => ({ side, test, run: i + 1 }))).flat(),
  );
  const done = new Map<Side, number>(sides.map((s) => [s, 0]));
  let completed = 0;

  report?.progress({
    message: `running ${tests.length} test${tests.length === 1 ? "" : "s"} on ${sides.map(label).join(" and ")}`,
    completed: 0,
    total,
  });
  for (const s of sides) {
    const reused = (opts.reuse ?? []).filter((r) => r.version === s.version && r.run <= runsPerTest).length;
    report?.log(
      `${label(s)}: ${tests.length} test(s) × ${runsPerTest} = ${perSide} runs${reused ? `, ${reused} reused from a saved run` : ""}...`,
    );
  }

  const finished: RunRecord[] = [];
  let stopped: string | null = null;
  const records = await mapLimit(jobs, concurrency, async ({ side, test, run }): Promise<RunRecord | null> => {
    if (stopped) return null;
    const reused = opts.reuse?.find((r) => r.version === side.version && r.test === test.name && r.run === run);
    const record = reused ?? (await runAndSave(side, test, run));
    finished.push(record);
    stopped ??= opts.shouldStop?.(finished) ?? null;
    done.set(side, done.get(side)! + 1);
    completed++;
    report?.progress({
      message: `${label(side)} · saved ${record.test} (test ${tests.indexOf(test) + 1} of ${tests.length})`,
      completed,
      total,
    });
    report?.runSaved(label(side), done.get(side)!, perSide, record.error != null);
    return record;
  });
  if (stopped) throw new RunsStopped(stopped, finished.length);
  const out = { old: [], new: [] } as Record<Version, RunRecord[]>;
  jobs.forEach((job, i) => out[job.side.version].push(records[i]!));
  return out;
}

/** Run one test once, keep the checks it ran among its tool calls, and save the record. */
async function runAndSave(side: Side, test: TestFile, run: number): Promise<RunRecord> {
  // The run's checks (its Jev decisions, and any guardrails the framework
  // reported) are kept on the record, placed among its tool calls.
  const { result: record, decisions } = await recordDecisions(() => runOnce(side.agent, test, side.version, run));
  const checks = [...(record.decisions ?? []), ...decisions];
  if (checks.length) record.decisions = placeDecisions(checks, record.tool_calls);
  await writeJson(runRecordPath(side.runsDir, test.name, run), record);
  return record;
}
