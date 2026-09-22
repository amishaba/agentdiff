import type { RunRecord, TestFile, ToolCall, Version } from "../types.ts";
import { errMessage, fail } from "../lib/errors.ts";
import { isNormalized, isRunnable, type RunInput } from "./adapters/adapter.ts";
import { markToolStart, startsSoFar } from "./decisions.ts";
import type { AnyAgent } from "./load.ts";
import { answeredCalls, ReplaySession, replayAgent, type ToolSession } from "./replay.ts";
import { ScriptedSession } from "./scripted.ts";

// Tool-call/result entries differ across Mastra + AI SDK versions: v4 puts the
// fields on the object (`{ toolName, args }`), while Mastra's v5 stream parts
// nest them under `payload` (`{ payload: { toolName, args } }`). Read from both.
function readField(obj: any, keys: string[]): any {
  for (const k of keys) {
    if (obj?.[k] !== undefined) return obj[k];
    if (obj?.payload?.[k] !== undefined) return obj.payload[k];
  }
  return undefined;
}

function extractToolCalls(result: Record<string, any>): ToolCall[] {
  const rawCalls: any[] = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
  const rawResults: any[] = Array.isArray(result?.toolResults) ? result.toolResults : [];

  // Gather from steps too, in case top-level arrays are absent. AI SDK v5 steps
  // expose typed parts under `content` ({ type: "tool-call" | "tool-result" }),
  // older ones expose `toolCalls`/`toolResults` arrays — read whichever exists.
  if (rawCalls.length === 0 && Array.isArray(result?.steps)) {
    for (const step of result.steps) {
      if (Array.isArray(step?.toolCalls)) rawCalls.push(...step.toolCalls);
      if (Array.isArray(step?.toolResults)) rawResults.push(...step.toolResults);
      if (Array.isArray(step?.content)) {
        for (const part of step.content) {
          if (part?.type === "tool-call") rawCalls.push(part);
          else if (part?.type === "tool-result") rawResults.push(part);
        }
      }
    }
  }

  const resultById = new Map<string, unknown>();
  for (const r of rawResults) {
    const id = readField(r, ["toolCallId", "id"]);
    const output = readField(r, ["result", "output"]) ?? null;
    if (id != null) resultById.set(String(id), output);
  }

  return rawCalls.map((tc) => {
    const id = readField(tc, ["toolCallId", "id"]);
    return {
      tool: readField(tc, ["toolName", "tool", "name"]) ?? "unknown",
      input: readField(tc, ["args", "input"]) ?? null,
      output:
        id != null && resultById.has(String(id))
          ? resultById.get(String(id))!
          : (readField(tc, ["result", "output"]) ?? null),
      ...(id != null ? { id: String(id) } : {}),
    };
  });
}

function extractTokens(result: Record<string, any>): RunRecord["tokens"] {
  const usage = result?.usage;
  if (!usage || typeof usage !== "object") return null;
  const input = usage.inputTokens ?? usage.promptTokens ?? null;
  const output = usage.outputTokens ?? usage.completionTokens ?? null;
  if (input == null && output == null) return null;
  return { input: input ?? null, output: output ?? null };
}

function extractSteps(result: Record<string, any>): number | null {
  if (Array.isArray(result?.steps)) return result.steps.length;
  if (typeof result?.steps === "number") return result.steps;
  return null;
}

/**
 * A Mastra agent's generate() arguments: the earlier turns plus the new message
 * (or just the message), the test's context as a RequestContext, and an
 * onChunk hook that puts each tool call's start on the run's clock.
 */
function mastraArgs(agent: AnyAgent, input: string, run: RunInput): [unknown, Record<string, unknown>] {
  const messages = run.conversation?.length
    ? [...run.conversation.map((t) => ({ role: t.role, content: t.content })), { role: "user", content: input }]
    : input;
  const options: Record<string, unknown> = {
    onChunk: (chunk: any) => {
      if (chunk?.type === "tool-call") markToolStart(chunk.payload?.toolCallId ?? chunk.toolCallId);
    },
  };
  if (run.context) {
    const RequestContext = agent.__agentdiffRequestContext;
    if (!RequestContext)
      fail("This test has a context, but the installed @mastra/core has no RequestContext to pass it in.");
    options.requestContext = new RequestContext(Object.entries(run.context));
  }
  return [messages, options];
}

/** Stamp Mastra tool calls with when they started, from the onChunk hook. */
function timed(calls: ToolCall[]): ToolCall[] {
  const starts = startsSoFar();
  return calls.map((c) => {
    const at_ms = c.id != null ? starts?.tools.get(c.id) : undefined;
    return at_ms != null ? { ...c, at_ms } : c;
  });
}

/** Run the agent once against a test and return a Run Record. Never throws. */
export async function runOnce(agent: AnyAgent, test: TestFile, version: Version, run: number): Promise<RunRecord> {
  const started = Date.now();
  const replay = test.replay ? new ReplaySession(test.replay.responses) : undefined;
  // What answers the tools when the agent's own must not run: a recording, or the test's written responses.
  const session: ToolSession | undefined =
    replay ?? (test.tool_responses ? new ScriptedSession(test.tool_responses) : undefined);
  const replayInfo = (error: boolean): RunRecord["replay"] =>
    replay
      ? {
          incidentId: test.replay!.incidentId,
          status: replay.missing.length ? "blocked" : error ? "error" : "complete",
          missing: replay.missing,
        }
      : undefined;
  const runInput: RunInput = {
    ...(test.conversation?.length ? { conversation: test.conversation } : {}),
    ...(test.context ? { context: test.context } : {}),
  };
  try {
    const executable = session ? await replayAgent(agent, session) : agent;
    const result = (
      isRunnable(executable)
        ? await executable.generate(test.input, runInput)
        : await executable.generate(...mastraArgs(agent, test.input, runInput))
    ) as Record<string, any>;
    if (session?.failure) throw new Error(session.failure);
    if (replay?.missing.length)
      throw new Error("Replay blocked: supply the missing test response in the incident review.");
    const latency = Date.now() - started;
    // Adapters return one shape; Mastra results are read across its versions.
    const normalized = isNormalized(result) ? result : null;
    return {
      test: test.name,
      version,
      run,
      input: test.input,
      tool_calls: session
        ? answeredCalls(normalized ? normalized.toolCalls : timed(extractToolCalls(result)), session.calls)
        : normalized
          ? normalized.toolCalls
          : timed(extractToolCalls(result)),
      final_response:
        typeof result?.text === "string" ? result.text : result?.text != null ? String(result.text) : null,
      steps: normalized ? normalized.steps : extractSteps(result),
      tokens: normalized ? normalized.tokens : extractTokens(result),
      latency_ms: latency,
      error: null,
      ...(normalized?.checks?.length ? { decisions: normalized.checks } : {}),
      ...(replay ? { replay: replayInfo(false) } : {}),
    };
  } catch (err) {
    return {
      test: test.name,
      version,
      run,
      input: test.input,
      tool_calls: session?.calls ?? [],
      final_response: null,
      steps: null,
      tokens: null,
      latency_ms: Date.now() - started,
      error: errMessage(err),
      ...(replay ? { replay: replayInfo(true) } : {}),
    };
  }
}
