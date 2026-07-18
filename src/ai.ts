import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

// AgentDiff grades and explains with Gemini. This is the ONLY LLM provider the
// tool itself needs — the agent under test brings its own model (e.g. OpenAI),
// which lives in the user's project, not here.
const DEFAULT_MODEL = "gemini-2.5-flash";

function geminiKey(): string | undefined {
  for (const name of ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"]) {
    const v = process.env[name];
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

export const NO_KEY_HINT =
  "no API key found — set GEMINI_API_KEY in a .env file to enable grading + explanation";

export function hasApiKey(): boolean {
  return geminiKey() != null;
}

/** Model used for grading and explanation. Override the model id with AGENTDIFF_MODEL. */
export function graderModel(): LanguageModel {
  const apiKey = geminiKey();
  if (!apiKey) throw new Error(NO_KEY_HINT);
  const modelId = process.env.AGENTDIFF_MODEL ?? DEFAULT_MODEL;
  return createGoogleGenerativeAI({ apiKey })(modelId);
}

/** Run async tasks with a fixed concurrency limit, preserving input order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}
