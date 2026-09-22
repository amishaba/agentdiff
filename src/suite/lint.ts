// Tests checked against the agent before anything runs. A test that requires a
// tool the agent doesn't have can never pass: running it only spends money to
// find that out.
import type { TestFile } from "../types.ts";

export interface MissingTool {
  tool: string;
  /** Tests that require it. */
  tests: string[];
}

/**
 * Tools the tests require (must_call_tools) that the agent doesn't have, each
 * with the tests that require it. Nothing when the agent declares no tools:
 * then there's nothing to check against.
 */
export function missingTools(tests: TestFile[], agentTools: string[]): MissingTool[] {
  if (!agentTools.length) return [];
  const byTool = new Map<string, string[]>();
  for (const t of tests)
    for (const tool of t.must_call_tools ?? [])
      if (!agentTools.includes(tool)) byTool.set(tool, [...(byTool.get(tool) ?? []), t.name]);
  return [...byTool].map(([tool, names]) => ({ tool, tests: names })).sort((a, b) => b.tests.length - a.tests.length);
}

/** The problem in a few lines, for stopping before a run. */
export function missingToolsMessage(missing: MissingTool[], agentTools: string[]): string {
  const lines = missing
    .slice(0, 5)
    .map(
      (m) =>
        `  ${m.tool}: required by ${m.tests.length} test${m.tests.length === 1 ? "" : "s"} (${m.tests.slice(0, 3).join(", ")}${m.tests.length > 3 ? ", …" : ""})`,
    );
  if (missing.length > 5) lines.push(`  and ${missing.length - 5} more tools`);
  return [
    "Some tests require tools this agent doesn't have, so they can't pass:",
    ...lines,
    `The agent's tools: ${agentTools.join(", ")}.`,
    "Fix those tests (or the agent's tools), then run again.",
  ].join("\n");
}
