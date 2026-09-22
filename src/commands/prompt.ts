// Questions first-run setup asks in the terminal.
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Writable } from "node:stream";

/** True when someone is at the terminal to answer. */
export const interactive = (): boolean => !!stdin.isTTY && !!stdout.isTTY;

/** Ctrl+C at a question ends the program, as it would anywhere else. */
function exitOnInterrupt(rl: readline.Interface): void {
  rl.on("SIGINT", () => {
    stdout.write("\n");
    process.exit(130);
  });
}

export async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  exitOnInterrupt(rl);
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Like ask, but what's typed isn't shown: for API keys. */
export async function askSecret(question: string): Promise<string> {
  // readline echoes every keystroke to its output; give it one that discards everything.
  const silent = new Writable({ write: (_chunk, _encoding, done) => done() });
  const rl = readline.createInterface({ input: stdin, output: silent, terminal: true });
  exitOnInterrupt(rl);
  // Ask only once readline has the terminal in raw mode, or a fast paste is echoed by the terminal itself.
  stdout.write(question);
  try {
    return (await rl.question("")).trim();
  } finally {
    rl.close();
    stdout.write("\n");
  }
}

/** A numbered list; returns the index picked. Enter picks the first. */
export async function choose(question: string, options: string[]): Promise<number> {
  stdout.write(`${question}\n`);
  options.forEach((o, i) => stdout.write(`  ${i + 1}. ${o}\n`));
  for (;;) {
    const answer = await ask(`Number [1]: `);
    const n = answer ? Number.parseInt(answer, 10) : 1;
    if (n >= 1 && n <= options.length) return n - 1;
  }
}
