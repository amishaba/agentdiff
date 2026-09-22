// Where a prompt can live: the agent file, or a local file it imports (a
// prompt.ts next to the agent). A copy of the agent that loses a sentence from
// an imported file needs every file on the import chain copied, each importing
// the next copy instead of the original.
import { promises as fs } from "node:fs";
import path from "node:path";

export interface SourceFile {
  /** Absolute path. */
  file: string;
  source: string;
  /** The import chain from the agent file to this one, both included. */
  chain: string[];
}

/** A relative specifier in an import, an export-from or a dynamic import. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']+)\1/g;
const SUFFIXES = ["", ".ts", ".tsx", ".mts", ".js", ".mjs", "/index.ts", "/index.js"];

async function isFile(file: string): Promise<boolean> {
  return fs.stat(file).then(
    (s) => s.isFile(),
    () => false,
  );
}

/** The file a relative specifier points at, trying the extensions TypeScript and Node would. */
async function resolveLocal(from: string, specifier: string): Promise<string | null> {
  const base = path.resolve(path.dirname(from), specifier);
  // "./prompt.js" in TypeScript source means prompt.ts.
  const candidates = [...SUFFIXES.map((s) => base + s), base.replace(/\.js$/, ".ts"), base.replace(/\.mjs$/, ".mts")];
  for (const candidate of candidates) if (await isFile(candidate)) return candidate;
  return null;
}

/** A file's relative imports, each with the file it resolves to. */
async function localImports(file: string, source: string): Promise<{ specifier: string; file: string }[]> {
  const out: { specifier: string; file: string }[] = [];
  for (const m of source.matchAll(SPECIFIER)) {
    const resolved = await resolveLocal(file, m[2]);
    if (resolved && !resolved.includes(`${path.sep}node_modules${path.sep}`))
      out.push({ specifier: m[2], file: resolved });
  }
  return out;
}

/** The agent file and every local file reachable from it through relative imports, nearest first. */
export async function promptSources(agentFile: string, maxFiles = 50): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  const seen = new Set<string>([agentFile]);
  const queue: { file: string; chain: string[] }[] = [{ file: agentFile, chain: [agentFile] }];
  while (queue.length && out.length < maxFiles) {
    const { file, chain } = queue.shift()!;
    const source = await fs.readFile(file, "utf8");
    out.push({ file, source, chain });
    for (const next of await localImports(file, source))
      if (!seen.has(next.file)) {
        seen.add(next.file);
        queue.push({ file: next.file, chain: [...chain, next.file] });
      }
  }
  return out;
}

/** `.agentdiff-<tag>-<name>` next to the original, so the original's other relative imports still resolve. */
const copyOf = (file: string, tag: string) => path.join(path.dirname(file), `.agentdiff-${tag}-${path.basename(file)}`);

/**
 * Copies of each file on `chain`: the last holds `mutated`, and each earlier
 * one imports the next copy in place of the original. Returns the copy of the
 * agent file, to load, and every copy written, to remove afterwards.
 */
export async function writeChain(
  chain: string[],
  mutated: string,
  tag: string,
): Promise<{ entry: string; written: string[] }> {
  const written: string[] = [];
  for (let i = chain.length - 1; i >= 0; i--) {
    const file = chain[i];
    let text = mutated;
    if (i < chain.length - 1) {
      text = await fs.readFile(file, "utf8");
      const next = chain[i + 1];
      let target = path.relative(path.dirname(file), copyOf(next, tag)).split(path.sep).join("/");
      // The copies' names start with a dot, so check for a real "./" or "../".
      if (!/^\.\.?\//.test(target)) target = `./${target}`;
      for (const imp of await localImports(file, text))
        if (imp.file === next)
          text = text.split(`"${imp.specifier}"`).join(`"${target}"`).split(`'${imp.specifier}'`).join(`'${target}'`);
    }
    const copy = copyOf(file, tag);
    await fs.writeFile(copy, text);
    written.push(copy);
  }
  return { entry: copyOf(chain[0], tag), written };
}
