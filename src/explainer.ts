import { generateText } from "ai";
import type { Comparison } from "./types.ts";
import { graderModel, hasApiKey, NO_KEY_HINT } from "./ai.ts";
import { buildExplainerContext } from "./summary.ts";

const UNAVAILABLE = `(AI explanation unavailable — ${NO_KEY_HINT}.)`;

/**
 * One AI call that explains what changed and the likely cause.
 * `detailed` produces the longer analysis used by the `explain` command.
 */
export async function explainComparison(c: Comparison, detailed = false): Promise<string> {
  if (!hasApiKey()) return UNAVAILABLE;

  const context = buildExplainerContext(c);

  const shortInstructions =
    `Explain in 2-4 sentences of plain English what changed in the agent's behaviour and the single most likely cause, ` +
    `linking specific prompt/tool/setting changes to the measured differences. ` +
    `If a required tool is now being skipped, call that out first. End with one concrete recommendation. ` +
    `Do not invent numbers; only use what is given. Do not output PASS/FAIL.`;

  const detailedInstructions =
    `Write a detailed but focused analysis (up to ~2 short paragraphs plus a short bulleted recommendation list). ` +
    `Cover: (1) what behaviour changed, tied to specific prompt/tool/setting edits; (2) the most likely cause-and-effect chain; ` +
    `(3) any tradeoff (e.g. cost vs. quality); (4) 1-3 concrete recommendations. ` +
    `Ground every claim in the measured differences below. Do not invent numbers. Do not output PASS/FAIL.`;

  try {
    const { text } = await generateText({
      model: graderModel(),
      temperature: 0.2,
      prompt:
        `You are AgentDiff, a tool that explains how an AI agent's behaviour changed between two versions.\n\n` +
        `${detailed ? detailedInstructions : shortInstructions}\n\n` +
        `Here is the diff and measured comparison:\n\n${context}`,
    });
    return text.trim();
  } catch (err) {
    return `(AI explanation failed: ${err instanceof Error ? err.message : String(err)})`;
  }
}
