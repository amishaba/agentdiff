# Your agent

`agent` in the config names an export of your agent file. agentdiff accepts three kinds:

| kind | what to export | fake tools (for discovery and incidents) |
|---|---|---|
| **Mastra** | an `Agent` from `@mastra/core` | 1.63.2 or a later 1.x |
| **OpenAI Agents SDK** | an `Agent` from `@openai/agents`, or the first agent of a team | every agent reachable through handoffs. A `handoff()` callback doesn't run. MCP and hosted tools can't be faked, so a run that needs them stops. |
| **any function** | `async (input, { conversation, context, tools }) => ({ text, toolCalls, usage })` | through `tools`, one function per tool name. A call that bypasses them stops the run. |

A function agent can attach `instructions`, `model` and `tools` to itself, so its prompt and tools are part of the snapshot:

```ts
export async function supportAgent(input: string, run?: { tools?: Record<string, (input: unknown) => unknown> }) {
  const lookup = run?.tools?.lookup_customer ?? lookupCustomer;
  // …your model calls and tool loop…
  return { text: reply, toolCalls: [{ tool: "lookup_customer", input: { query }, output: result }] };
}
supportAgent.instructions = SYSTEM_PROMPT;
supportAgent.model = "gpt-5.4";
supportAgent.tools = TOOLS; // Chat Completions or Responses tool definitions
```

OpenAI's field names (`name`, `arguments` as a JSON string, `prompt_tokens`) work too. When a run uses fake tools and calls something there's no answer for, the run stops and the call is listed as missing. It never falls back to the real tool. Agents are JavaScript or TypeScript.

[← README](../README.md)
