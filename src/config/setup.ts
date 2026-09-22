// What first-run setup writes into a project: the config, keys in .env, and
// .gitignore lines. Never overwrites a value the project already has.
import path from "node:path";
import { promises as fs } from "node:fs";
import { exists } from "../storage/fs.ts";

export interface StarterConfig {
  agent: string;
  agentPath: string;
  tests: string;
}

/** The config file first-run setup writes, with a comment per field so it can be edited by hand. */
export function configSource(c: StarterConfig): string {
  return `// Written by agentdiff. Every option: https://github.com/amishaba/agentdiff/blob/main/docs/setup.md
export default {
  agent: ${JSON.stringify(c.agent)}, // the name your file exports the agent as
  agentPath: ${JSON.stringify(c.agentPath)}, // the file the agent is in
  tests: ${JSON.stringify(c.tests)}, // one JSON file per test
};
`;
}

/** Write agentdiff.config.ts into `rootDir`. Refuses to replace one that exists. */
export async function writeConfig(rootDir: string, c: StarterConfig): Promise<string> {
  const file = path.join(rootDir, "agentdiff.config.ts");
  await fs.writeFile(file, configSource(c), { flag: "wx" });
  return file;
}

/**
 * Put keys in `.env`: fill a `KEY=` line left empty (as in .env.example), else add a line.
 * A key that already has a value is left as it is. Returns the keys saved.
 */
export async function saveEnv(rootDir: string, values: Record<string, string>): Promise<string[]> {
  const file = path.join(rootDir, ".env");
  let text = (await exists(file)) ? await fs.readFile(file, "utf8") : "";
  const saved: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (!value) continue;
    const line = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=(.*)$`, "m");
    const current = line.exec(text);
    if (current?.[1].trim()) continue;
    text = current
      ? text.replace(line, `${key}=${value}`)
      : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${key}=${value}\n`;
    saved.push(key);
  }
  if (saved.length) await fs.writeFile(file, text, { mode: 0o600 });
  return saved;
}

/** Add `entries` to `.gitignore` unless a line already covers them. Returns the entries added. */
export async function ignoreInGit(rootDir: string, entries: string[]): Promise<string[]> {
  const file = path.join(rootDir, ".gitignore");
  const current = (await exists(file)) ? await fs.readFile(file, "utf8") : "";
  const lines = new Set(current.split("\n").map((l) => l.trim().replace(/^\/|\/$/g, "")));
  const missing = entries.filter((e) => !lines.has(e.replace(/^\/|\/$/g, "")));
  if (!missing.length) return [];
  await fs.writeFile(file, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
  return missing;
}

/**
 * Where starter tests go: `tests/` if it's free or already holds agentdiff tests,
 * else `agentdiff-tests/` so a project's own unit tests are left alone.
 */
export async function starterTestsDir(rootDir: string): Promise<{ dir: string; existing: number }> {
  const tests = path.join(rootDir, "tests");
  if (!(await exists(tests))) return { dir: "./tests", existing: 0 };
  const entries = await fs.readdir(tests, { withFileTypes: true });
  const json = entries.filter((e) => e.isFile() && e.name.endsWith(".json"));
  const ours = await Promise.all(
    json.map(async (e) => {
      try {
        const t = JSON.parse(await fs.readFile(path.join(tests, e.name), "utf8"));
        return typeof t?.name === "string" && typeof t?.input === "string";
      } catch {
        return false;
      }
    }),
  );
  const count = ours.filter(Boolean).length;
  if (count && count === entries.filter((e) => !e.name.startsWith(".")).length)
    return { dir: "./tests", existing: count };
  if (!entries.some((e) => !e.name.startsWith("."))) return { dir: "./tests", existing: 0 };
  const other = path.join(rootDir, "agentdiff-tests");
  const existing = (await exists(other)) ? (await fs.readdir(other)).filter((f) => f.endsWith(".json")).length : 0;
  return { dir: "./agentdiff-tests", existing };
}
