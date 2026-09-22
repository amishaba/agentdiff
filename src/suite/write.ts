import path from "node:path";
import { promises as fs } from "node:fs";
import { ensureDir } from "../storage/fs.ts";
import { slug } from "../storage/workspace.ts";

/** A test to add to the suite: what a reviewed discovery draft becomes. */
export interface NewTest {
  name: string;
  input: string;
  must_call_tools: string[];
  grading_criteria: string;
}

/** A test file's body, any fields in their written order; `name` decides the file name. */
export type TestBody = { name: string } & Record<string, unknown>;

/**
 * Write tests into `testsDir` as JSON files, never overwriting an existing
 * file: a name already taken gets " (2)", " (3)", … and the file a matching
 * -2, -3 slug. All of them are written, or none. Returns the filenames written.
 */
export async function writeTestFiles(testsDir: string, tests: TestBody[]): Promise<string[]> {
  await ensureDir(testsDir);
  const entries = (await fs.readdir(testsDir)).filter((e) => e.endsWith(".json"));
  const names = new Set<string>();
  const slugs = new Set<string>();
  for (const file of entries) {
    const saved = JSON.parse(await fs.readFile(path.join(testsDir, file), "utf8"));
    if (typeof saved.name === "string") {
      names.add(saved.name);
      slugs.add(slug(saved.name));
    }
  }
  const staging = await fs.mkdtemp(path.join(testsDir, ".agentdiff-pending-"));
  const written: string[] = [];
  try {
    for (const [index, test] of tests.entries()) {
      const base = test.name.trim() || "test";
      for (let n = 1; ; n++) {
        const name = n === 1 ? base : `${base} (${n})`;
        const file = `${slug(name)}.json`;
        if (names.has(name) || slugs.has(slug(name))) continue;
        const temp = path.join(staging, `${index}.json`);
        await fs.writeFile(temp, JSON.stringify({ ...test, name }, null, 2) + "\n");
        try {
          await fs.link(temp, path.join(testsDir, file));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
          throw error;
        }
        names.add(name);
        slugs.add(slug(name));
        written.push(file);
        break;
      }
    }
    return written;
  } catch (error) {
    await Promise.all(written.map((file) => fs.rm(path.join(testsDir, file), { force: true })));
    throw error;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

/** Write reviewed drafts and starter tests (`metadata[i]` goes first in test i's file). See writeTestFiles. */
export function writeScenarios(
  testsDir: string,
  scenarios: NewTest[],
  metadata: Record<string, unknown>[] = [],
): Promise<string[]> {
  return writeTestFiles(
    testsDir,
    scenarios.map((s, i) => ({
      ...metadata[i],
      name: s.name.trim() || "scenario",
      input: s.input,
      ...(s.must_call_tools.length ? { must_call_tools: s.must_call_tools } : {}),
      grading_criteria: s.grading_criteria,
    })),
  );
}
