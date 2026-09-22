import chalk from "chalk";
import type { LogTone, Reporter } from "../pipeline/reporter.ts";

const STYLE: Record<LogTone, (text: string) => string> = {
  heading: (text) => chalk.bold(text),
  section: (text) => chalk.dim(`  ${text}`),
  detail: (text) => chalk.dim(`    ${text}`),
  warning: (text) => chalk.yellow(`    ${text}`),
  success: (text) => chalk.green(`  ${text}`),
};

/** Renders pipeline output for a person at a terminal: styled lines and a live run counter. */
export class TerminalReporter implements Reporter {
  /** True while the `\r` run counter owns the current line. */
  private counterOpen = false;

  progress(): void {
    // The terminal shows log lines and the run counter instead.
  }

  log(text: string, tone: LogTone = "section"): void {
    this.closeCounter();
    if (tone === "warning") console.warn(STYLE.warning(text));
    else console.log(STYLE[tone](text));
  }

  runSaved(label: string, done: number, total: number, failed: boolean, noun = "runs saved"): void {
    const count = `${failed ? chalk.red("x") : chalk.green("✓")} ${done}/${total} ${noun}`;
    if (!process.stdout.isTTY) {
      // A log file or a CI step: no live line to rewrite, so a line for each failure and every tenth of the way.
      const step = Math.max(1, Math.ceil(total / 10));
      if (failed || done % step === 0 || done === total) console.log(`    ${count} · ${clip(label, 100)}`);
      return;
    }
    // Clear the line first and keep it to one row, so a long label can't wrap and leave pieces behind.
    const width = (process.stdout.columns || 100) - 4;
    process.stdout.write(`\x1b[2K\r    ${count} · ${clip(label, Math.max(20, width - count.length - 3))}`);
    this.counterOpen = true;
    if (done === total) this.closeCounter();
  }

  private closeCounter(): void {
    if (!this.counterOpen) return;
    process.stdout.write("\n");
    this.counterOpen = false;
  }
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
