import { generateText } from "ai";
import type { Comparison } from "../types.ts";
import { openaiModel, hasApiKey, NO_KEY_HINT } from "../lib/llm.ts";
import { buildExplainerContext } from "./context.ts";

const UNAVAILABLE = `(AI explanation unavailable — ${NO_KEY_HINT}.)`;

export interface ExplainOptions {
  /** "short": two sentences for the report and PR comment. "detailed": the longer `agentdiff explain` analysis. */
  detail: "short" | "detailed";
  /** Throw on a missing key or failed call instead of returning a placeholder sentence. */
  throwOnError?: boolean;
}

/** One AI call that explains what changed and the likely cause. */
export async function explainComparison(c: Comparison, opts: ExplainOptions): Promise<string> {
  if (!hasApiKey()) {
    if (opts.throwOnError)
      throw new Error("Set OPENAI_API_KEY in your project’s .env file before generating an explanation.");
    return UNAVAILABLE;
  }

  const context = buildExplainerContext(c);

  // The short form lands in a PR comment under a table that already shows the
  // numbers, so it has to be two plain sentences: the likely cause, then a fix
  // to try. The numbers show what changed; they don't prove why, so neither
  // sentence claims more than that.
  const shortInstructions =
    `Write exactly two sentences, 60 words or fewer in total, no preamble. ` +
    `Sentence 1: the most likely cause, worded as likely ("likely", "probably") — quote the specific prompt line, tool, or setting that changed — and the biggest confirmed effect, with its numbers. ` +
    `If a rule is now broken (a forbidden tool, a skipped required tool, a write before its check), that is the effect to name. ` +
    `Sentence 2: start with "Fix to try:" and name one concrete change (a line to add or restore). ` +
    `Only use numbers given below. No hedging, no summary of what was measured, no PASS/FAIL.`;

  const detailedInstructions =
    `Write a detailed but focused analysis (up to ~2 short paragraphs plus a short bulleted recommendation list). ` +
    `Cover: (1) what behaviour changed, tied to specific prompt/tool/setting edits; (2) the likely cause-and-effect chain, worded as likely, since the numbers show what changed but not why; ` +
    `(3) any tradeoff (e.g. cost vs. quality); (4) 1-3 fixes to try, each a concrete change. Leave out tests marked inconclusive. ` +
    `Ground every claim in the measured differences below. Do not invent numbers. Do not output PASS/FAIL.`;

  try {
    const { text } = await generateText({
      model: openaiModel(),
      temperature: 0.2,
      prompt:
        `You are AgentDiff, a tool that explains how an AI agent's behaviour changed between two versions.\n\n` +
        `${opts.detail === "detailed" ? detailedInstructions : shortInstructions}\n\n` +
        `Here is the diff and measured comparison:\n\n${context}`,
    });
    if (!text.trim() && opts.throwOnError) throw new Error("The explanation model returned no text. Try again.");
    return text.trim();
  } catch (err) {
    if (opts.throwOnError) throw err;
    return `(AI explanation failed: ${err instanceof Error ? err.message : String(err)})`;
  }
}
