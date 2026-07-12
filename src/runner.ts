import path from "node:path";
import type { RunRecord, TestFile, Version } from "./types.ts";
import { runOnce } from "./agent.ts";
import { slug, writeJson } from "./storage.ts";

const CONCURRENCY = 3;

type AnyAgent = Record<string, any>;

interface RunJob {
  test: TestFile;
  run: number;
}

export interface RunVersionOptions {
  agent: AnyAgent;
  tests: TestFile[];
  version: Version;
  runsPerTest: number;
  runsDir: string;
  onRun?: (record: RunRecord) => void;
}

/** Run every test N times for one agent version, saving each run record to disk. */
export async function runVersion(opts: RunVersionOptions): Promise<RunRecord[]> {
  const { agent, tests, version, runsPerTest, runsDir, onRun } = opts;

  const jobs: RunJob[] = [];
  for (const test of tests) {
    for (let run = 1; run <= runsPerTest; run++) {
      jobs.push({ test, run });
    }
  }

  const records: RunRecord[] = [];
  let next = 0;

  async function worker(): Promise<void> {
    while (next < jobs.length) {
      const job = jobs[next++];
      const record = await runOnce(agent, job.test, version, job.run);
      records.push(record);
      const file = path.join(runsDir, `${slug(job.test.name)}-${job.run}.json`);
      await writeJson(file, record);
      onRun?.(record);
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, () => worker());
  await Promise.all(workers);

  return records;
}
