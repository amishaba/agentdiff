import type { JobProgress } from "./progress.ts";

/**
 * How a log line should read: a heading, a top-level line, a detail within the
 * current stage, a warning, or a success.
 */
export type LogTone = "heading" | "section" | "detail" | "warning" | "success";

/**
 * Where the pipeline says what it is doing. The pipeline never writes to the
 * terminal itself: the CLI passes a TerminalReporter, the dashboard worker
 * forwards structured progress to the page, and library callers get silence.
 */
export interface Reporter {
  /** Structured progress for machine consumers (the dashboard's progress bar). */
  progress(event: JobProgress): void;
  /** One human-readable line. */
  log(text: string, tone?: LogTone): void;
  /** One item of a batch finished (a run, unless `noun` says otherwise); `done` counts up to `total`. */
  runSaved(label: string, done: number, total: number, failed: boolean, noun?: string): void;
}

export const silentReporter: Reporter = {
  progress() {},
  log() {},
  runSaved() {},
};
