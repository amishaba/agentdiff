// What a judge (the grader, or Jev answering checks) sees of one run. An agent
// acts through its tool calls as much as through the text it ends with: an SMS
// sent with a send tool, a record it updated, a hand-off. So every judge sees
// both, with each call's input and output.
import { NO_FINAL_TEXT, NO_REPLY_TEXT, type RunRecord } from "../types.ts";

/** Longest input or output a judge sees of one call, as JSON text. */
const MAX_CALL_CHARS = 1500;

function clipped(value: unknown): string {
  const text = JSON.stringify(value ?? null);
  return text.length > MAX_CALL_CHARS ? `${text.slice(0, MAX_CALL_CHARS)}…` : text;
}

/** The run's tool calls in order, each input and output clipped. */
export function judgedCalls(r: RunRecord): { tool: string; input: string; output: string }[] {
  return r.tool_calls.map((c) => ({ tool: c.tool, input: clipped(c.input), output: clipped(c.output) }));
}

/** The run's final text; without one, whether it acted through its tools or did nothing at all. */
export function finalText(r: RunRecord): string {
  if (r.final_response?.trim()) return r.final_response;
  return r.tool_calls.length ? NO_FINAL_TEXT : NO_REPLY_TEXT;
}
