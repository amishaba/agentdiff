// How check results read, in words: the headline, a test's detail line, the
// order tests are listed in. Pure and browser-safe, so the page says the same.
import { HEALTH_STATUSES, LOW_SCORE, type HealthResult, type TestHealth } from "./types.ts";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Tests worst first, keeping the suite's order within a status. */
export const byStatus = (tests: TestHealth[]) =>
  [...tests].sort((a, b) => HEALTH_STATUSES.indexOf(a.status) - HEALTH_STATUSES.indexOf(b.status));

/** A change key (see changeSignals) as plain words: "tool:send_sms" → "whether it calls send_sms". */
export function describeMovement(signal: string): string {
  const at = signal.indexOf(":");
  const [kind, id] = at < 0 ? [signal, ""] : [signal.slice(0, at), signal.slice(at + 1)];
  if (kind === "required" || kind === "forbidden" || kind === "tool") return `whether it calls ${id}`;
  if (kind === "check" || kind === "decision") return `the answer to ${id}`;
  if (signal === "path") return "the steps it takes";
  if (signal === "reply") return "whether it replies";
  if (signal === "grade") return "its score";
  return signal;
}

/** "11 of 16 tests steady · 2 break a test rule · 1 scores low · 2 unpredictable" */
export function healthHeadline(result: HealthResult): string {
  const n = (status: TestHealth["status"]) => result.tests.filter((t) => t.status === status).length;
  // A trial runs each test once, ungraded: only whether it kept its tool rules is known.
  if (result.trial)
    return [
      `${result.tests.length - n("rule") - n("error")} of ${plural(result.tests.length, "test")} kept their tool rules`,
      n("rule") && `${n("rule")} broke one`,
      n("error") && `${n("error")} with errors`,
    ]
      .filter(Boolean)
      .join(" · ");
  return [
    `${n("steady")} of ${plural(result.tests.length, "test")} steady`,
    n("rule") && `${n("rule")} break${n("rule") === 1 ? "s" : ""} a test rule`,
    n("low") && `${n("low")} score${n("low") === 1 ? "s" : ""} low`,
    n("unsteady") && `${n("unsteady")} unpredictable`,
    n("error") && `${n("error")} with errors`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** What went wrong in one test, in a line: the rules it broke, errors, a low score, then where its runs disagree. */
export function healthDetail(t: TestHealth): string {
  const broken = t.rules
    .filter((r) => r.kept < r.of)
    .map((r) => `${r.kind === "required" ? "skipped" : "called"} ${r.tool} in ${r.of - r.kept}/${r.of} runs`);
  const moved = t.unsteady.length
    ? [`runs differ in ${[...new Set(t.unsteady.map(describeMovement))].join(", ")}`]
    : [];
  const errors = t.errors ? [`${t.errors}/${t.runs} runs errored`] : [];
  const low = t.score != null && t.score < LOW_SCORE ? [`scored ${t.score.toFixed(1)} of 5 on average`] : [];
  return [...broken, ...errors, ...low, ...moved].join("; ");
}

export interface BrokenRule {
  tool: string;
  kind: "required" | "forbidden";
  /** Tests where at least one run broke it. */
  tests: string[];
}

/**
 * Each rule broken somewhere, with the tests that broke it, most first. One
 * rule broken across many tests usually means the tests expect the wrong
 * thing of the agent, not that the agent is wrong in each of them.
 */
export function brokenRules(tests: TestHealth[]): BrokenRule[] {
  const byRule = new Map<string, BrokenRule>();
  for (const t of tests)
    for (const r of t.rules.filter((r) => r.kept < r.of)) {
      const key = `${r.kind}:${r.tool}`;
      if (!byRule.has(key)) byRule.set(key, { tool: r.tool, kind: r.kind, tests: [] });
      byRule.get(key)!.tests.push(t.test);
    }
  return [...byRule.values()].sort((a, b) => b.tests.length - a.tests.length);
}

/** "lookup_order, forbidden: called in 14 tests" */
export const describeBrokenRule = (b: BrokenRule) =>
  `${b.tool}, ${b.kind}: ${b.kind === "required" ? "skipped" : "called"} in ${plural(b.tests.length, "test")}`;
