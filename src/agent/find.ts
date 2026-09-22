import path from "node:path";
import { promises as fs } from "node:fs";
import { projectFiles } from "../lib/git.ts";

/** An agent a project exports, found by reading its source. */
export interface FoundAgent {
  /** Relative to the project folder, with forward slashes. */
  file: string;
  exportName: string;
  /** "other" when someone named the file by hand. */
  framework: "mastra" | "openai-agents" | "other";
}

const SOURCE = /\.(ts|mts|js|mjs)$/;
const SKIP = /(^|\/)(node_modules|dist|build|\.agentdiff|\.next|coverage)\/|\.d\.ts$|\.(test|spec)\.[mc]?[jt]s$/;
const MAX_BYTES = 300_000;

const FRAMEWORKS: [Exclude<FoundAgent["framework"], "other">, RegExp][] = [
  ["mastra", /from\s+["']@mastra\/core(\/agent)?["']/],
  ["openai-agents", /from\s+["']@openai\/agents["']/],
];
const CREATES = String.raw`(?:new\s+Agent\s*[(<]|Agent\.create\s*\()`;

/** Exported names in one file whose value is a `new Agent(...)` (or `Agent.create(...)`). */
export function agentExports(source: string): string[] {
  const out: string[] = [];
  const direct = new RegExp(String.raw`export\s+const\s+(\w+)\s*(?::[^=]+)?=\s*${CREATES}`, "g");
  for (const m of source.matchAll(direct)) out.push(m[1]);
  if (new RegExp(String.raw`export\s+default\s+${CREATES}`).test(source)) out.push("default");
  // `const desk = new Agent(...)` exported later with `export { desk }` or `export { desk as support }`.
  const local = new RegExp(String.raw`(?:const|let)\s+(\w+)\s*(?::[^=]+)?=\s*${CREATES}`, "g");
  const declared = new Set([...source.matchAll(local)].map((m) => m[1]));
  for (const m of source.matchAll(/export\s*\{([^}]*)\}/g))
    for (const part of m[1].split(",")) {
      const [name, alias] = part.trim().split(/\s+as\s+/);
      if (name && declared.has(name)) out.push(alias ?? name);
    }
  return [...new Set(out)];
}

/**
 * Agents the project exports, by reading its source rather than importing it,
 * so nothing in the project runs. Finds Mastra and OpenAI Agents SDK agents;
 * a function agent has to be named by hand.
 */
export async function findAgents(rootDir: string): Promise<FoundAgent[]> {
  const files = (await projectFiles(rootDir)).filter((f) => SOURCE.test(f) && !SKIP.test(f)).sort();
  const found: FoundAgent[] = [];
  for (const file of files) {
    const full = path.join(rootDir, file);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat?.isFile() || stat.size > MAX_BYTES) continue;
    const source = await fs.readFile(full, "utf8");
    const framework = FRAMEWORKS.find(([, from]) => from.test(source))?.[0];
    if (!framework) continue;
    for (const exportName of agentExports(source)) found.push({ file, exportName, framework });
  }
  return found;
}
