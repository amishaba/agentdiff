import { AsyncLocalStorage } from "node:async_hooks";
import type { Decision, DecisionStats, RunRecord, ToolCall } from "../types.ts";

/**
 * Records the Jev decisions an agent makes while it runs, so they can be
 * diffed like tool calls. Jev is reached over HTTP, either through Vercel AI
 * Gateway (`…/evaluation-model`, what the AI SDK's `experimental_evaluate`
 * calls) or TypeSafe's API (`api.typesafe.ai/v1/systemone`), so wrapping
 * `fetch` sees them without touching the agent. Runs execute concurrently;
 * AsyncLocalStorage ties each request to the run that made it. Only the
 * questions and answers are kept, never the state sent with them.
 */
/**
 * One run's clock: the Jev decisions made so far, and when each tool call and
 * handoff started, in ms since the run began. Adapters report starts through
 * markToolStart / markHandoff from inside the run.
 */
interface RunTrace {
  start: number;
  decisions: Decision[];
  toolStarts: Map<string, number>;
  handoffStarts: number[];
}
const current = new AsyncLocalStorage<RunTrace>();

/** ms since the current run started, or undefined outside a run. */
export function runClock(): number | undefined {
  const t = current.getStore();
  return t ? Math.round((performance.now() - t.start) * 10) / 10 : undefined;
}

export function markToolStart(callId: string | undefined): void {
  const t = current.getStore();
  if (t && callId && !t.toolStarts.has(callId)) t.toolStarts.set(callId, runClock()!);
}

export function markHandoff(): void {
  current.getStore()?.handoffStarts.push(runClock()!);
}

/** When the current run's tool calls and handoffs started, so far. */
export function startsSoFar(): { tools: ReadonlyMap<string, number>; handoffs: readonly number[] } | undefined {
  const t = current.getStore();
  return t && { tools: t.toolStarts, handoffs: t.handoffStarts };
}

/**
 * Place each decision among the run's tool calls: `after` is how many calls
 * started before it. Decisions already placed (guardrails) keep their place;
 * the rest are placed only when every call has a start time, or there were no
 * calls at all.
 */
export function placeDecisions(decisions: Decision[], calls: ToolCall[]): Decision[] {
  const timed = calls.every((c) => c.at_ms != null);
  return decisions.map((d) => {
    if (d.after != null) return d;
    if (!calls.length) return { ...d, after: 0 };
    if (!timed || d.at_ms == null) return d;
    return { ...d, after: calls.filter((c) => c.at_ms! <= d.at_ms!).length };
  });
}

type Source = "gateway" | "typesafe";

function sourceOf(url: string): Source | null {
  try {
    const u = new URL(url);
    if (/\/evaluation-model\/?$/.test(u.pathname)) return "gateway";
    if (u.hostname === "api.typesafe.ai" && u.pathname.startsWith("/v1/systemone")) return "typesafe";
  } catch {
    /* not a URL we care about */
  }
  return null;
}

const text = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/** Pair the questions sent with the answers returned, in either API's shape. */
export function toDecisions(source: Source, questions: Record<string, any>, answers: Record<string, any>): Decision[] {
  const out: Decision[] = [];
  for (const [id, q] of Object.entries(questions ?? {})) {
    const a = answers?.[id];
    if (!q || !a) continue;
    const type = q.type === "noul" ? "boolean" : q.type;
    if (type !== "boolean" && type !== "choice" && type !== "score") continue;
    const base = {
      id,
      type,
      instructions: text(q.instructions),
      ...(type === "choice" && q.criteria && typeof q.criteria === "object"
        ? { options: Object.keys(q.criteria) }
        : {}),
    } as const;
    if (type === "boolean") {
      const p = source === "typesafe" ? a.noul : a.probability;
      if (typeof p === "number") out.push({ ...base, answer: { type, probability: p } });
    } else if (type === "choice" && typeof a.choice === "string") {
      out.push({ ...base, answer: { type, choice: a.choice } });
    } else if (type === "score" && typeof a.score === "number") {
      out.push({ ...base, answer: { type, score: a.score } });
    }
  }
  return out;
}

let original: typeof fetch = globalThis.fetch;

const recordingFetch = async function recordingFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const trace = current.getStore();
  const decisions = trace?.decisions;
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const source = decisions ? sourceOf(url) : null;
  const at_ms = source ? runClock() : undefined;
  const response = await original(input, init);
  if (!decisions || !source || !response.ok || typeof init?.body !== "string") return response;
  try {
    const sent = JSON.parse(init.body) as { questions?: Record<string, unknown> };
    const received = (await response.clone().json()) as { answers?: Record<string, unknown> };
    decisions.push(...toDecisions(source, sent.questions ?? {}, received.answers ?? {}).map((d) => ({ ...d, at_ms })));
  } catch {
    /* never let recording break the agent's own call */
  }
  return response;
} as typeof fetch;

/** Wrap whatever fetch is current, again if something replaced the wrapper since. */
function install(): void {
  if (globalThis.fetch === recordingFetch) return;
  original = globalThis.fetch;
  globalThis.fetch = recordingFetch;
}

/** Run `fn` on its own clock and collect every Jev decision made inside it. */
export async function recordDecisions<T>(fn: () => Promise<T>): Promise<{ result: T; decisions: Decision[] }> {
  install();
  const trace: RunTrace = { start: performance.now(), decisions: [], toolStarts: new Map(), handoffStarts: [] };
  const result = await current.run(trace, fn);
  return { result, decisions: trace.decisions };
}

/** Tally one version's decisions by question id, over the runs that finished. */
export function decisionStats(runs: RunRecord[]): Record<string, DecisionStats> | undefined {
  const done = runs.filter((r) => !r.error);
  const byId = new Map<string, { decisions: Decision[]; runs: Set<number> }>();
  for (const r of done) {
    for (const d of r.decisions ?? []) {
      const entry = byId.get(d.id) ?? { decisions: [], runs: new Set<number>() };
      entry.decisions.push(d);
      entry.runs.add(r.run);
      byId.set(d.id, entry);
    }
  }
  if (!byId.size) return undefined;
  const out: Record<string, DecisionStats> = {};
  for (const [id, { decisions, runs: asking }] of byId) {
    const wordings = new Map<string, number>();
    for (const d of decisions) wordings.set(d.instructions, (wordings.get(d.instructions) ?? 0) + 1);
    const instructions = [...wordings].sort((a, b) => b[1] - a[1])[0][0];
    const stats: DecisionStats = {
      type: decisions[0].type,
      instructions,
      runs: done.length,
      runsAsking: asking.size,
      asks: decisions.length,
    };
    if (decisions[0].source && decisions[0].source !== "jev") stats.source = decisions[0].source;
    const answers = decisions.map((d) => d.answer);
    if (stats.type === "boolean")
      stats.yes = answers.filter((a) => a.type === "boolean" && a.probability >= 0.5).length;
    if (stats.type === "choice") {
      stats.counts = {};
      for (const a of answers) if (a.type === "choice") stats.counts[a.choice] = (stats.counts[a.choice] ?? 0) + 1;
    }
    if (stats.type === "score") {
      const scores = answers.flatMap((a) => (a.type === "score" ? [a.score] : []));
      stats.meanScore = scores.reduce((s, x) => s + x, 0) / scores.length;
    }
    out[id] = stats;
  }
  return out;
}
