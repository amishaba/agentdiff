import path from "node:path";
import { pathToFileURL } from "node:url";
import type { RunRecord, Snapshot, TestFile, ToolCall, Version } from "./types.ts";
import { exists } from "./storage.ts";
import { errMessage, fail } from "./config.ts";

// The Mastra Agent is a peer dependency and its surface differs across versions,
// so we duck-type everything here and never import @mastra/core.
type AnyAgent = Record<string, any>;

/** Import the user's agent file and return the exported agent object. */
export async function importAgent(
  rootDir: string,
  fileRel: string,
  exportName: string,
): Promise<AnyAgent> {
  const file = path.resolve(rootDir, fileRel);
  if (!(await exists(file))) {
    fail(`Agent file not found: ${file}`);
  }

  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } catch (err) {
    fail(`Could not import agent file ${fileRel}: ${errMessage(err)}`);
  }

  const agent = (mod![exportName] ?? mod!.default) as AnyAgent | undefined;
  if (!agent) {
    const names = Object.keys(mod!).filter((k) => k !== "default");
    fail(
      `Export "${exportName}" not found in ${fileRel}. ` +
        (names.length ? `Available exports: ${names.join(", ")}.` : "File has no named exports."),
    );
  }
  if (typeof agent.generate !== "function") {
    fail(`Export "${exportName}" in ${fileRel} is not a Mastra agent (no .generate method).`);
  }
  return agent;
}

async function resolveMaybe(value: unknown): Promise<unknown> {
  if (typeof value === "function") {
    try {
      return await (value as (...a: unknown[]) => unknown)({});
    } catch {
      return undefined;
    }
  }
  return value;
}

async function callGetter(agent: AnyAgent, getter: string): Promise<unknown> {
  if (typeof agent[getter] === "function") {
    try {
      return await agent[getter]({ runtimeContext: undefined });
    } catch {
      try {
        return await agent[getter]();
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function normalizeInstructions(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((m) => (typeof m === "string" ? m : typeof m?.content === "string" ? m.content : JSON.stringify(m)))
      .join("\n");
  }
  if (value == null) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function modelIdOf(model: unknown): string {
  if (typeof model === "string") return model;
  if (model && typeof model === "object") {
    const m = model as Record<string, unknown>;
    return (m.modelId as string) ?? (m.id as string) ?? (m.name as string) ?? "unknown";
  }
  return "unknown";
}

function namesOf(entries: unknown): string[] {
  if (!entries) return [];
  if (Array.isArray(entries)) {
    return entries.map((t) => (typeof t === "string" ? t : t?.id ?? t?.name ?? "unknown"));
  }
  if (typeof entries === "object") return Object.keys(entries as object);
  return [];
}

const SETTING_KEYS = [
  "temperature",
  "maxSteps",
  "maxTokens",
  "topP",
  "topK",
  "presencePenalty",
  "frequencyPenalty",
];

function extractSettings(agent: AnyAgent): Record<string, unknown> {
  const opts =
    (typeof agent.defaultGenerateOptions === "object" && agent.defaultGenerateOptions) ||
    (typeof agent.defaultOptions === "object" && agent.defaultOptions) ||
    {};
  const out: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    if (opts && (opts as Record<string, unknown>)[key] !== undefined) {
      out[key] = (opts as Record<string, unknown>)[key];
    } else if (agent[key] !== undefined && typeof agent[key] !== "function") {
      out[key] = agent[key];
    }
  }
  return out;
}

/** Read a version-independent snapshot off the agent object. */
export async function extractSnapshot(agent: AnyAgent): Promise<Snapshot> {
  const name =
    typeof agent.name === "string" ? agent.name : normalizeInstructions(await resolveMaybe(agent.name)) || "agent";

  const instructions = normalizeInstructions(
    (await callGetter(agent, "getInstructions")) ?? (await resolveMaybe(agent.instructions)),
  );

  const model = modelIdOf((await callGetter(agent, "getModel")) ?? (await resolveMaybe(agent.model)));

  const tools = namesOf((await callGetter(agent, "getTools")) ?? (await resolveMaybe(agent.tools)));

  const workflows = namesOf((await callGetter(agent, "getWorkflows")) ?? (await resolveMaybe(agent.workflows)));

  return {
    name: name || "agent",
    instructions,
    model,
    tools,
    workflows,
    settings: extractSettings(agent),
  };
}

function extractToolCalls(result: Record<string, any>): ToolCall[] {
  const rawCalls: any[] = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
  const rawResults: any[] = Array.isArray(result?.toolResults) ? result.toolResults : [];

  // Gather from steps too, in case top-level arrays are absent.
  if (rawCalls.length === 0 && Array.isArray(result?.steps)) {
    for (const step of result.steps) {
      if (Array.isArray(step?.toolCalls)) rawCalls.push(...step.toolCalls);
      if (Array.isArray(step?.toolResults)) rawResults.push(...step.toolResults);
    }
  }

  const resultById = new Map<string, unknown>();
  for (const r of rawResults) {
    const id = r?.toolCallId ?? r?.id;
    const output = r?.result ?? r?.output ?? null;
    if (id != null) resultById.set(String(id), output);
  }

  return rawCalls.map((tc) => {
    const id = tc?.toolCallId ?? tc?.id;
    return {
      tool: tc?.toolName ?? tc?.tool ?? "unknown",
      input: tc?.args ?? tc?.input ?? null,
      output: id != null && resultById.has(String(id)) ? resultById.get(String(id))! : tc?.result ?? tc?.output ?? null,
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

/** Run the agent once against a test and return a Run Record. Never throws. */
export async function runOnce(
  agent: AnyAgent,
  test: TestFile,
  version: Version,
  run: number,
): Promise<RunRecord> {
  const started = Date.now();
  try {
    const result = (await agent.generate(test.input)) as Record<string, any>;
    const latency = Date.now() - started;
    return {
      test: test.name,
      version,
      run,
      input: test.input,
      tool_calls: extractToolCalls(result),
      final_response: typeof result?.text === "string" ? result.text : result?.text != null ? String(result.text) : null,
      steps: extractSteps(result),
      tokens: extractTokens(result),
      latency_ms: latency,
      error: null,
    };
  } catch (err) {
    return {
      test: test.name,
      version,
      run,
      input: test.input,
      tool_calls: [],
      final_response: null,
      steps: null,
      tokens: null,
      latency_ms: Date.now() - started,
      error: errMessage(err),
    };
  }
}
