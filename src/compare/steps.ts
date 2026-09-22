import type { Decision, RunRecord } from "../types.ts";

/**
 * A run's path: its tool calls in order, each check placed where it ran, and
 * "no reply" at the end when the agent finished without saying anything. Two
 * runs share a path when they did the same things and the checks came out the
 * same way. Browser-safe; the dashboard uses it too.
 */
export const NO_REPLY = "(no reply)";
const CHECK = "?";

function answerOf(d: Decision): string {
  const a = d.answer;
  if (a.type === "choice") return a.choice;
  if (a.type === "score") return String(Math.round(a.score));
  if (d.source === "guardrail") return a.probability >= 0.5 ? "tripped" : "passed";
  return a.probability >= 0.5 ? "yes" : "no";
}

export function stepsOf(r: RunRecord): string[] {
  const calls = r.tool_calls ?? [];
  const placed = (r.decisions ?? []).filter((d) => d.after != null);
  const steps: string[] = [];
  for (let i = 0; i <= calls.length; i++) {
    for (const d of placed) if (d.after === i) steps.push(`${CHECK}${d.id}=${answerOf(d)}`);
    if (i < calls.length) steps.push(calls[i].tool);
  }
  if (r.error == null && !r.final_response?.trim()) steps.push(NO_REPLY);
  return steps;
}

export function isCheckStep(step: string): boolean {
  return step.startsWith(CHECK);
}

/** The check id of a check step, or null for a tool call or the ending. */
export function checkIdOf(step: string): string | null {
  return isCheckStep(step) ? step.slice(CHECK.length, step.indexOf("=")) : null;
}

/** "should_reply: no", "no reply", or the tool name. */
export function stepLabel(step: string): string {
  if (step === NO_REPLY) return "no reply";
  if (!isCheckStep(step)) return step;
  const body = step.slice(CHECK.length);
  const at = body.indexOf("=");
  return `${body.slice(0, at)}: ${body.slice(at + 1)}`;
}
