import { zodSchema } from "ai";
import type { Snapshot } from "../types.ts";
import { isAdapter } from "./adapters/adapter.ts";
import type { AnyAgent } from "./load.ts";

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
    return entries.map((t) => (typeof t === "string" ? t : (t?.id ?? t?.name ?? "unknown")));
  }
  if (typeof entries === "object") return Object.keys(entries as object);
  return [];
}

const SETTING_KEYS = ["temperature", "maxSteps", "maxTokens", "topP", "topK", "presencePenalty", "frequencyPenalty"];

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
  if (isAdapter(agent)) return agent.snapshot();
  const name =
    typeof agent.name === "string" ? agent.name : normalizeInstructions(await resolveMaybe(agent.name)) || "agent";

  const instructions = normalizeInstructions(
    (await callGetter(agent, "getInstructions")) ?? (await resolveMaybe(agent.instructions)),
  );

  const model = modelIdOf((await callGetter(agent, "getModel")) ?? (await resolveMaybe(agent.model)));

  // Mastra renamed these getters across versions: v5 exposes listTools/
  // listWorkflows, older builds getTools/getWorkflows, and some just hold the
  // config on .tools/.workflows. Try them in that order so the snapshot's tool
  // inventory isn't silently empty (which also mis-informs discovery's planner).
  const toolEntries =
    (await callGetter(agent, "listTools")) ??
    (await callGetter(agent, "getTools")) ??
    (await resolveMaybe(agent.tools));
  const tools = namesOf(toolEntries);
  const toolDefinitions: NonNullable<Snapshot["toolDefinitions"]> = {};
  if (toolEntries && typeof toolEntries === "object" && !Array.isArray(toolEntries)) {
    for (const [name, tool] of Object.entries(toolEntries) as Array<[string, any]>) {
      toolDefinitions[name] = {
        description: typeof tool?.description === "string" ? tool.description : "",
        inputSchema: describeSchema(tool?.inputSchema ?? tool?.parameters),
        outputSchema: describeSchema(tool?.outputSchema),
      };
    }
  }

  const workflows = namesOf(
    (await callGetter(agent, "listWorkflows")) ??
      (await callGetter(agent, "getWorkflows")) ??
      (await resolveMaybe(agent.workflows)),
  );

  return {
    name: name || "agent",
    instructions,
    model,
    tools,
    workflows,
    settings: extractSettings(agent),
    toolDefinitions,
  };
}

function describeSchema(schema: any): unknown {
  if (!schema) return undefined;
  try {
    if (schema.jsonSchema) return schema.jsonSchema;
    if (typeof schema.toJSONSchema === "function") return schema.toJSONSchema();
    if (schema._def) return zodSchema(schema).jsonSchema;
    if (typeof schema.type === "string" || schema.properties) return schema;
  } catch {
    /* Unsupported schemas are omitted, never invented. */
  }
  return undefined;
}
