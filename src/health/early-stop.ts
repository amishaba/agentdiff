// When a check should stop before spending the rest of its runs: the suite is
// failing in a way that says the tests or the setup are wrong, not the agent.
import type { RunRecord, TestFile } from "../types.ts";

/** Runs to see before judging, and the different tests they have to come from. */
const MIN_RUNS = 20;
const MIN_TESTS = 5;
/** A required tool called in at most this share of runs is being skipped everywhere, not by chance. */
const MISS_RATE = 0.05;

/**
 * Why to stop now, or null to keep going:
 * - almost every run so far errored (a missing key, a model the account can't use, an agent that won't load);
 * - a tool many tests require is almost never called, across many tests: those tests likely
 *   expect something this agent doesn't do (it may reply in its final text, not through that tool).
 */
export function whyStop(tests: TestFile[], records: RunRecord[]): string | null {
  if (records.length < MIN_RUNS) return null;
  const done = records.filter((r) => !r.error);
  if (done.length <= records.length * 0.1) {
    const first = records.find((r) => r.error)?.error ?? "";
    return `${records.length - done.length} of the first ${records.length} runs errored (${first.split("\n")[0]}). Fix that, then run again.`;
  }
  const required = [...new Set(tests.flatMap((t) => t.must_call_tools ?? []))];
  for (const tool of required) {
    const requiring = new Set(tests.filter((t) => t.must_call_tools?.includes(tool)).map((t) => t.name));
    const runs = done.filter((r) => requiring.has(r.test));
    if (runs.length < MIN_RUNS || new Set(runs.map((r) => r.test)).size < MIN_TESTS) continue;
    const called = runs.filter((r) => r.tool_calls.some((c) => c.tool === tool)).length;
    if (called <= runs.length * MISS_RATE)
      return (
        `${requiring.size} tests require ${tool}, but ${called} of their first ${runs.length} runs called it. ` +
        `If this agent doesn't use ${tool} that way (it may answer in its final text instead), those tests expect the wrong thing: fix them, then run again.`
      );
  }
  return null;
}
