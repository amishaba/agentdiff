import path from "node:path";
import { promises as fs } from "node:fs";
import { TestFileSchema, type TestFile } from "./types.ts";
import { exists } from "./storage.ts";
import { fail } from "./config.ts";

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
      fail(`Invalid test file ${entry}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    }
    tests.push(parsed.data);
  }
  return tests;
}
