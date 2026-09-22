// Bramblewood Clinic's text-message booking assistant, as a function agent. Its reply
// is structured output, { replies: [...] }: one entry per text the clinic
// sends, none when it stays quiet. Tools are answered by the test when it says,
// otherwise by the simulated clinic in world.ts.
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, isStepCount, jsonSchema, Output, tool } from "ai";
import { z } from "zod";
import { buildPrompt, SAMPLE, TOOL_GUIDANCE, type ClinicData } from "./prompt.ts";
import { TOOLS, type ToolDefinition } from "./tools.ts";
import { world } from "./world.ts";

const MODEL = process.env.CLINIC_MODEL ?? "gpt-5.1";
const REPLIES = z.object({ replies: z.array(z.string()) });

type Turn = { role: "user" | "assistant"; content: string };
type Run = {
  conversation?: Turn[];
  context?: Record<string, unknown>;
  tools?: Record<string, (input: unknown) => unknown>;
};

/** The sample data with a test's context laid over it: `contact` and `now` replace the sample's, the rest is shown as is. */
function dataFor(context: Record<string, unknown> = {}): { data: ClinicData; extra: Record<string, unknown> } {
  const { contact, now, ...extra } = context;
  return {
    data: {
      now: typeof now === "string" ? now : SAMPLE.now,
      contact: { ...SAMPLE.contact, ...(contact && typeof contact === "object" ? contact : {}) },
    },
    extra,
  };
}

/** The assistant, optionally with edited tool descriptions or tool guidance: how v2 changes the prompt. */
export function createClinicAgent(
  edits: { tools?: Record<string, ToolDefinition>; guidance?: Record<string, string> } = {},
) {
  const defs = edits.tools ?? TOOLS;
  const guidance = edits.guidance ?? TOOL_GUIDANCE;
  const system = (context?: Record<string, unknown>) => {
    const { data, extra } = dataFor(context);
    const more = Object.keys(extra).length ? `\n\n<context>\n${JSON.stringify(extra, null, 2)}\n</context>` : "";
    return buildPrompt(data, guidance) + more;
  };

  async function clinicAssistant(input: string, run: Run = {}) {
    const calls: { tool: string; input: unknown; output: unknown }[] = [];
    const tools = Object.fromEntries(
      Object.entries(defs).map(([name, def]) => [
        name,
        tool({
          description: def.description,
          inputSchema: jsonSchema(def.parameters),
          execute: async (args) => {
            const output = await (run.tools?.[name] ?? world[name])(args);
            calls.push({ tool: name, input: args, output });
            return output;
          },
        }),
      ]),
    );
    const result = await generateText({
      model: createOpenAI().chat(MODEL),
      system: system(run.context),
      messages: [...(run.conversation ?? []), { role: "user", content: input }],
      tools,
      output: Output.object({ schema: REPLIES }),
      stopWhen: isStepCount(12),
      // One call at a time, so tool answers come back in the order the run reports them.
      providerOptions: { openai: { parallelToolCalls: false } },
    });
    const texts = (result.output?.replies ?? []).map((r) => r.trim()).filter(Boolean);
    return { text: texts.length ? texts.join("\n\n") : null, toolCalls: calls, usage: result.totalUsage };
  }
  clinicAssistant.instructions = system();
  clinicAssistant.model = MODEL;
  clinicAssistant.tools = defs;
  return clinicAssistant;
}
