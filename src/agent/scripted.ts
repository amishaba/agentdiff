import type { ToolCall } from "../types.ts";
import type { ToolSession } from "./replay.ts";

/**
 * Answers an agent's tools from the outputs a test writes out for them: each
 * tool's outputs in call order, the last one again once they run out. The
 * agent's own tools never run. Unlike a recorded replay, arguments don't have
 * to match, so the same test runs against any version of the prompt.
 */
export class ScriptedSession implements ToolSession {
  readonly controller = new AbortController();
  readonly calls: ToolCall[] = [];
  failure: string | null = null;
  private counts = new Map<string, number>();
  constructor(private responses: Record<string, unknown[]>) {}

  fail(message: string): never {
    this.failure ??= message;
    this.controller.abort();
    throw new Error(this.failure);
  }

  execute(tool: string, input: unknown): unknown {
    if (this.controller.signal.aborted) throw new Error(this.failure ?? "Test stopped.");
    const outputs = Object.hasOwn(this.responses, tool) ? this.responses[tool] : [];
    const n = this.counts.get(tool) ?? 0;
    this.counts.set(tool, n + 1);
    const output = outputs[Math.min(n, outputs.length - 1)];
    this.calls.push({
      tool,
      input: structuredClone(input),
      output: output === undefined ? null : structuredClone(output),
    });
    if (output === undefined) this.fail(`This test has no response for ${tool}. Add it to the test's tool_responses.`);
    return structuredClone(output);
  }
}
