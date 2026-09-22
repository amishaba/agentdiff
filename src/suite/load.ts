import path from "node:path";
import { promises as fs } from "node:fs";
import { TestFileSchema, type TestFile } from "../types.ts";
import { exists } from "../storage/fs.ts";
import { fail } from "../lib/errors.ts";
import { slug } from "../storage/workspace.ts";

/** Load and validate every tests/*.json file. */
export async function loadTests(rootDir: string, testsRel: string): Promise<TestFile[]> {
  const testsDir = path.resolve(rootDir, testsRel);
  if (!(await exists(testsDir))) {
    fail(`Tests folder not found: ${testsDir}`);
  }

  const entries = (await fs.readdir(testsDir)).filter((e) => e.endsWith(".json")).sort();
  if (entries.length === 0) {
    fail(`No test .json files found in ${testsDir}`);
  }

  const tests: TestFile[] = [];
  // Runs are matched to tests, and saved, by name: two tests with one name would share runs and overwrite each other's files.
  const byKey = new Map<string, string>();
  for (const entry of entries) {
    const file = path.join(testsDir, entry);
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (err) {
      fail(`Could not parse test file ${entry}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const parsed = TestFileSchema.safeParse(raw);
    if (!parsed.success) {
      fail(
        `Invalid test file ${entry}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
      );
    }
    if (parsed.data.replay && parsed.data.tool_responses)
      fail(
        `Invalid test file ${entry}: a test answers its tools from a recording (replay) or tool_responses, not both.`,
      );
    const key = slug(parsed.data.name);
    const other = byKey.get(key);
    if (other)
      fail(
        `${other} and ${entry} would save their runs under the same file name ("${key}"): their test names are the same once case and punctuation are dropped. Rename one.`,
      );
    byKey.set(key, entry);
    tests.push(parsed.data);
  }
  return tests;
}
