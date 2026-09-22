import { createOpenAI } from "@ai-sdk/openai";
import { defaultSettingsMiddleware, wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";

const DEFAULT_OPENAI_MODEL = "gpt-5.4";

function trimEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

function openaiKey(): string | undefined {
  return trimEnv("OPENAI_API_KEY");
}

export const NO_KEY_HINT = "no API key found — set OPENAI_API_KEY in a .env file to enable grading + explanation";

export function hasApiKey(): boolean {
  return openaiKey() != null;
}

/**
 * Which model grades each run and answers the checks: Jev, TypeSafe's
 * decision model through Vercel AI Gateway, or OpenAI. AGENTDIFF_GRADER wins,
 * then the config's `grader`, then Jev. The explanation and discovery planning
 * always use OpenAI.
 */
export type GraderKind = "openai" | "jev";
export function graderKind(configured?: GraderKind): GraderKind {
  const env = trimEnv("AGENTDIFF_GRADER")?.toLowerCase();
  if (env === "jev" || env === "openai") return env;
  return configured ?? "jev";
}

/** AGENTDIFF_OFFLINE=1: agentdiff makes no model calls of its own; judging, discovery and the explanation are marked blocked. */
export function offline(): boolean {
  return trimEnv("AGENTDIFF_OFFLINE") === "1";
}

/** Keys a full comparison needs with this grader and doesn't have, with what each one is for. */
export function missingKeys(grader: GraderKind): { key: string; for: string }[] {
  const out: { key: string; for: string }[] = [];
  if (!hasApiKey())
    out.push({
      key: "OPENAI_API_KEY",
      for:
        grader === "openai"
          ? "grading, checks, discovery planning and the explanation"
          : "discovery planning and the explanation",
    });
  if (grader === "jev" && !hasGatewayKey()) out.push({ key: "AI_GATEWAY_API_KEY", for: "grading and checks with Jev" });
  return out;
}

export const JEV_MODEL = "typesafe-ai/jev";

/** AI Gateway reads AI_GATEWAY_API_KEY, or a Vercel OIDC token when running on Vercel. */
export function hasGatewayKey(): boolean {
  return trimEnv("AI_GATEWAY_API_KEY") != null || trimEnv("VERCEL_OIDC_TOKEN") != null;
}

export const NO_GATEWAY_KEY_HINT = "no AI Gateway key found — set AI_GATEWAY_API_KEY to grade with Jev";

/**
 * How hard agentdiff's own OpenAI calls think: grading, checks, scenarios,
 * explanations. "low" by default, because these calls are many and the wait
 * adds up; AGENTDIFF_REASONING sets another level, or "default" to leave it to
 * the model. Models that don't reason ignore it.
 */
function reasoningEffort(): string | undefined {
  const value = trimEnv("AGENTDIFF_REASONING")?.toLowerCase();
  return value === "default" ? undefined : (value ?? "low");
}

/** How many of agentdiff's own OpenAI calls run at once. Override with AGENTDIFF_MODEL_CONCURRENCY. */
export function modelConcurrency(): number {
  const n = Number(trimEnv("AGENTDIFF_MODEL_CONCURRENCY"));
  return Number.isInteger(n) && n > 0 ? n : 12;
}

/** The OpenAI model: the explanation, discovery planning, scenarios, and grading when the grader is "openai". Override with AGENTDIFF_MODEL. */
export function openaiModel(): LanguageModel {
  const apiKey = openaiKey();
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const id = trimEnv("AGENTDIFF_MODEL") ?? DEFAULT_OPENAI_MODEL;
  // `.chat` keeps Chat Completions; since @ai-sdk/openai v2 the default is the Responses API.
  const model = createOpenAI({ apiKey }).chat(id);
  const effort = reasoningEffort();
  const middleware: LanguageModelMiddleware[] = [];
  if (effort)
    middleware.push(
      defaultSettingsMiddleware({ settings: { providerOptions: { openai: { reasoningEffort: effort } } } }),
    );
  // Reasoning models take no temperature: the SDK drops it and warns on every call, so don't send one.
  if (REASONING_MODEL.test(id))
    middleware.push({ transformParams: async ({ params }) => ({ ...params, temperature: undefined }) });
  return middleware.length ? wrapLanguageModel({ model, middleware }) : model;
}

/** OpenAI models that reason before answering: gpt-5 and later, and the o-series. */
const REASONING_MODEL = /^(gpt-[5-9]|o\d)/;

/**
 * Why no call to the model can succeed now, or null: the account is out of
 * credits, or the key is wrong or not allowed. Retrying doesn't help and every
 * later call fails the same way, so the caller stops instead of recording one
 * failure per run. Reads through the SDK's retry and cause wrappers.
 */
export function accountError(err: unknown): string | null {
  const seen = new Set<unknown>();
  for (let e: unknown = err; e && typeof e === "object" && !seen.has(e);) {
    seen.add(e);
    const { statusCode, responseBody, message } = e as { statusCode?: number; responseBody?: string; message?: string };
    const text = `${message ?? ""} ${responseBody ?? ""}`;
    if (statusCode === 401 || statusCode === 403)
      return `The model provider refused the API key (${statusCode}): ${firstLine(message)}`;
    if (statusCode === 429 && /insufficient_quota|credits|billing|spend limit|exceeded your current quota/i.test(text))
      return `The model provider's account can't spend more (no credits left, or a spend limit reached): ${firstLine(message)}`;
    e = (e as { lastError?: unknown }).lastError ?? (e as { cause?: unknown }).cause;
  }
  return null;
}

const firstLine = (text = "") => text.split("\n")[0];
