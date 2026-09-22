import path from "node:path";
import { STAGES, type StageName, type StageResult } from "../types.ts";
import type { JobProgress } from "./progress.ts";
import type { Reporter } from "./reporter.ts";

/** The job-progress phase each stage reports under. */
const PHASE: Record<StageName, JobProgress["phase"]> = {
  collect: "preparing",
  snapshot: "preparing",
  run: "runs",
  discover: "discovery",
  judge: "grading",
  explain: "explaining",
  save: "saving",
};

/** Records each compare stage's outcome as it finishes and reports progress under that stage. */
export class Stages {
  readonly results: StageResult[] = [];
  private current?: { stage: StageName; started: number };
  private dir?: string;

  constructor(private reporter: Reporter) {}

  begin(stage: StageName, message: string): void {
    this.current = { stage, started: Date.now() };
    this.reporter.log(`${STAGES.indexOf(stage) + 1}/${STAGES.length} ${stage}`);
    this.progress({ message });
  }

  /** Progress within the current stage. */
  progress(p: Omit<JobProgress, "phase" | "stage">): void {
    if (!this.current) return;
    this.reporter.progress({
      ...p,
      phase: PHASE[this.current.stage],
      stage: this.current.stage,
      ...(this.dir ? { dir: this.dir } : {}),
    });
  }

  /** A human-readable line within the current stage. */
  log(text: string): void {
    this.reporter.log(text, "detail");
  }

  runSaved(label: string, done: number, total: number, failed: boolean): void {
    this.reporter.runSaved(label, done, total, failed);
  }

  end(status: StageResult["status"], detail: string): void {
    if (!this.current) return;
    const { stage, started } = this.current;
    this.results.push({ stage, status, detail, ms: Date.now() - started });
    if (status !== "done") this.reporter.log(`${stage} ${status}: ${detail}`, "warning");
    this.current = undefined;
  }

  /** Tag progress with the comparison folder once there is one. */
  withDir(dir: string): void {
    this.dir = path.basename(dir);
  }
}
