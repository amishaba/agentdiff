import { createHash } from "node:crypto";
import type { ReplayResponse, TestFile, Turn } from "../../types.ts";
import type { Span } from "./client.ts";
import { strictCanonical } from "../../lib/canonical.ts";

export interface Incident {
  id: string;
  projectId: string;
  rootSpanId: string;
  name: string;
  created: string;
  reason: string;
  input: string;
  spanCount: number;
  scores?: { name: string; value: number; spanId: string }[];
  errorCount?: number;
  reviewed?: boolean;
  reviewRevision?: string;
  /** The test file this incident was saved as, and the review it was saved from. */
  savedFile?: string;
  savedRevision?: string;
}
export interface Scenario {
  incident: Incident;
  input: string;
  /** Earlier turns from a multi-message recording. */
  conversation?: Turn[];
  /** Other fields recorded alongside the prompt (application state), passed as the test's context. */
  context?: Record<string, unknown>;
  responses: ReplayResponse[];
  blockers: string[];
  suggestedExpectation: string;
  expectation: string;
  mustCallTools: string[];
  reviewed: boolean;
}

export function reviewRevision(scenario: Scenario): string {
  return createHash("sha256")
    .update(
      strictCanonical({
        input: scenario.input,
        conversation: scenario.conversation ?? null,
        context: scenario.context ?? null,
        expectation: scenario.expectation,
        mustCallTools: scenario.mustCallTools,
        responses: scenario.responses,
      }),
    )
    .digest("hex");
}

export function incidentId(projectId: string, root: string): string {
  return createHash("sha256").update(`${projectId}:${root}`).digest("hex").slice(0, 24);
}

export interface RecordedInput {
  input: string;
  conversation?: Turn[];
  context?: Record<string, unknown>;
}

/** User and assistant messages, oldest first, ending with the user's: the last is the input, the rest the conversation. System prompts are the agent's own and are left out. */
function fromMessages(value: unknown): RecordedInput | null {
  if (!Array.isArray(value)) return null;
  if (value.some((m) => !m || !["user", "assistant", "system"].includes(m.role) || typeof m.content !== "string"))
    return null;
  const turns = value
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as Turn["role"], content: m.content as string }));
  const last = turns.at(-1);
  if (!last || last.role !== "user") return null;
  const conversation = turns.slice(0, -1);
  return { input: last.content, ...(conversation.length ? { conversation } : {}) };
}

/**
 * A recorded root input as a test: a message; a list of messages (the last
 * user message, with the turns before it); or an object with a prompt or
 * messages, whose other fields are application state passed as the context.
 * Null when it is none of those.
 */
export function recordedInput(input: unknown): RecordedInput | null {
  if (typeof input === "string") return { input };
  if (Array.isArray(input)) return fromMessages(input);
  if (input && typeof input === "object") {
    const { prompt, messages, ...rest } = input as Record<string, unknown>;
    const base =
      typeof prompt === "string" ? { input: prompt } : messages !== undefined ? fromMessages(messages) : null;
    if (!base) return null;
    return Object.keys(rest).length ? { ...base, context: rest } : base;
  }
  return null;
}

const hasError = (s: Span) => s.error != null && s.error !== "";
export function incidentsFromSpans(projectId: string, spans: Span[], threshold = 0.5): Incident[] {
  const groups = new Map<string, Span[]>();
  for (const span of spans) {
    const group = groups.get(span.root_span_id) ?? [];
    group.push(span);
    groups.set(span.root_span_id, group);
  }
  const incidents: Incident[] = [];
  for (const [rootId, group] of groups) {
    const root = group.find((s) => s.span_id === rootId);
    if (!root) continue;
    const scores = group.flatMap((s) =>
      Object.entries(s.scores ?? {}).flatMap(([name, value]) =>
        value !== null && Number.isFinite(value) ? [{ name, value, spanId: s.span_id }] : [],
      ),
    );
    const badScores = scores.filter((s) => s.value < threshold);
    const errors = group.filter(hasError);
    if (!errors.length && !badScores.length) continue;
    incidents.push({
      id: incidentId(projectId, rootId),
      projectId,
      rootSpanId: rootId,
      name: root.span_attributes?.name ?? "recorded incident",
      created: root.created ?? "",
      reason: errors.length
        ? `${errors.length} recorded error${errors.length === 1 ? "" : "s"}`
        : badScores.map((s) => `${s.name}: ${s.value}`).join(" · "),
      scores,
      errorCount: errors.length,
      input: recordedInput(root.input)?.input ?? "unsupported recorded input",
      spanCount: group.length,
    });
  }
  return incidents.sort((a, b) => b.created.localeCompare(a.created));
}

export function prepareScenario(incident: Incident, spans: Span[]): Scenario {
  const group = spans.filter((s) => s.root_span_id === incident.rootSpanId);
  const root = group.find((s) => s.span_id === incident.rootSpanId);
  if (!root) throw new Error("The root span is missing. Refresh this incident.");
  const blockers: string[] = [];
  const recorded = recordedInput(root.input);
  if (recorded === null)
    blockers.push(
      "This recording's input isn't a message, a list of user and assistant messages, or an object with a prompt or messages, so it can't become a test yet.",
    );
  const ids = new Set(group.map((s) => s.span_id));
  if (group.some((s) => s.span_parents?.some((p) => !ids.has(p))))
    blockers.push(
      "Some parent spans are missing from the recording. Refresh or restore the missing spans in Braintrust.",
    );
  if (root.metrics?.end == null)
    blockers.push("The recording is still running or has no completion timestamp. Refresh after it finishes.");
  const tools = group.filter((s) => s.span_attributes?.type === "tool" || s.metadata?.entity_type === "tool");
  const counts = new Map<string, number>();
  const responses: ReplayResponse[] = [];
  tools.sort((a, b) => (a.metrics?.start ?? 0) - (b.metrics?.start ?? 0));
  for (const span of tools) {
    const name = span.metadata?.entity_name ?? span.span_attributes?.name;
    const tool = typeof name === "string" ? name.replace(/^tool(?: call)?:\s*/i, "") : "";
    if (!tool || !Object.hasOwn(span, "input")) {
      blockers.push("A tool span has no name or arguments; it cannot be matched safely.");
      continue;
    }
    const key = `${tool}:${strictCanonical(span.input)}`;
    const occurrence = (counts.get(key) ?? 0) + 1;
    counts.set(key, occurrence);
    // A failure is evidence, never a fabricated successful tool result. Missing results
    // are requested with exact arguments if the replay reaches that call.
    if (!hasError(span) && Object.hasOwn(span, "output"))
      responses.push({ tool, input: span.input, output: span.output, occurrence, source: "recording" });
  }
  // Repeated identical calls with uncertain order cannot use an arbitrary timestamp tie.
  for (let i = 0; i < tools.length; i++)
    for (let j = i + 1; j < tools.length; j++) {
      const a = tools[i],
        b = tools[j];
      if (
        (a.metadata?.entity_name ?? a.span_attributes?.name) === (b.metadata?.entity_name ?? b.span_attributes?.name) &&
        a.input !== undefined &&
        b.input !== undefined &&
        strictCanonical(a.input) === strictCanonical(b.input) &&
        (a.metrics?.end == null || b.metrics?.start == null || a.metrics.end > b.metrics.start)
      ) {
        blockers.push(
          "Repeated calls with identical arguments overlap or lack timing. Their response order needs a richer adapter.",
        );
      }
    }
  return {
    incident,
    input: recorded?.input ?? "",
    ...(recorded?.conversation ? { conversation: recorded.conversation } : {}),
    ...(recorded?.context ? { context: recorded.context } : {}),
    responses,
    blockers: [...new Set(blockers)],
    suggestedExpectation:
      root.expected == null
        ? ""
        : typeof root.expected === "string"
          ? root.expected
          : JSON.stringify(root.expected, null, 2),
    expectation: "",
    mustCallTools: [],
    reviewed: false,
  };
}

/** Where a reviewed incident's test is saved in the tests directory. */
export function incidentTestFile(scenario: Scenario): string {
  return `incident-${scenario.incident.id.slice(0, 12)}.json`;
}

/**
 * A reviewed incident as an ordinary test: the recorded message, conversation
 * and context, the reviewed expectation and required tools, and the recorded
 * or supplied tool responses its runs are answered with.
 */
export function incidentTest(scenario: Scenario): TestFile {
  return {
    name: `incident: ${scenario.incident.name} (${scenario.incident.id.slice(0, 8)})`,
    input: scenario.input,
    ...(scenario.conversation?.length ? { conversation: scenario.conversation } : {}),
    ...(scenario.context ? { context: scenario.context } : {}),
    ...(scenario.mustCallTools.length ? { must_call_tools: scenario.mustCallTools } : {}),
    ...(scenario.expectation.trim() ? { grading_criteria: scenario.expectation.trim() } : {}),
    replay: {
      incidentId: scenario.incident.id,
      projectId: scenario.incident.projectId,
      rootSpanId: scenario.incident.rootSpanId,
      responses: scenario.responses,
      reviewed: true,
    },
  };
}
