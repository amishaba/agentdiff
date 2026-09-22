import { generateObject } from "ai";
import { z } from "zod";
import { openaiModel } from "../lib/llm.ts";
import type { Snapshot } from "../types.ts";
import type { NewTest } from "./write.ts";

const SYSTEM = `You write regression tests for an AI agent, from its system prompt and its tools.
Each test is one realistic message a user would send, and what the agent should do with it.
Cover the agent's main job, and the rules in its prompt that a careless prompt edit could break:
a step it must take first, something it must refuse or hand off, a case where it should not act.
Use only the tool names you are given. Keep messages short and specific, the way people really write.`;

const testSchema = z.object({
  name: z.string().describe("A short lowercase label, e.g. 'refund without an order number'"),
  input: z.string().describe("The user's message"),
  must_call_tools: z.array(z.string()).describe("Tools the agent has to call for this message; empty if none"),
  grading_criteria: z.string().describe("One or two sentences: what a good response does"),
});

/** Drop tools the agent doesn't have and empty tests. */
export function cleanStarterTests(tests: NewTest[], tools: readonly string[]): NewTest[] {
  return tests
    .filter((t) => t.name.trim() && t.input.trim())
    .map((t) => ({ ...t, must_call_tools: [...new Set(t.must_call_tools.filter((tool) => tools.includes(tool)))] }));
}

/** A first set of tests for an agent nobody has written tests for yet, drafted from its prompt and tools. */
export async function draftStarterTests(snapshot: Snapshot, count = 5): Promise<NewTest[]> {
  const { object } = await generateObject({
    model: openaiModel(),
    schema: z.object({ tests: z.array(testSchema).min(1).max(count) }),
    system: SYSTEM,
    prompt: JSON.stringify({
      task: `Write ${count} tests.`,
      instructions: snapshot.instructions,
      tools: Object.fromEntries(snapshot.tools.map((t) => [t, snapshot.toolDefinitions?.[t]?.description ?? ""])),
    }),
    maxOutputTokens: 3_000,
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(90_000),
  });
  return cleanStarterTests(object.tests, snapshot.tools);
}

/** The one test written when tests can't be drafted (offline, or the agent has no prompt to read). */
export const PLACEHOLDER_TEST: NewTest = {
  name: "what can you do",
  input: "Hi, what can you help me with?",
  must_call_tools: [],
  grading_criteria: "Explains what it can help with, briefly and accurately.",
};
