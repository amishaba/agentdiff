# Scenarios

`agentdiff compare` needs tests. `agentdiff scenarios` writes them from your agent's prompt and tools alone, so a brand-new agent can start with a real suite instead of five lines of guesswork.

```
agentdiff scenarios                   # the config's agentPath, else versions.new
agentdiff scenarios --per-item 3 --max 30
```

```
38 scenarios for 21 things to cover · 1 gap
  not written: card declined on the second leg

Review them in .agentdiff/scenarios-<time>/tests
.agentdiff/scenarios-<time>/report.md
```

## What it does

**1. Plans what to cover.** A model reads the prompt, the tools and the guardrails, and lists everything a suite has to check, in five areas:

- **Main job:** each task the agent exists to do, end to end.
- **Rules:** every rule sentence in the prompt (the same sentences [mutation testing](./mutate.md) removes). Any rule the model leaves out is added, so each one gets a scenario.
- **Tool sequences and failures:** the multi-step tool paths, and each point where a tool can come back declined, sold out, not found or broken.
- **Adversarial:** prompt injection in a message or hidden in a tool's output, someone claiming to be staff, pressure to skip a rule, asking for someone else's data.
- **Conversation shapes:** replies that only make sense mid-thread ("YES", "STOP", "thanks"), several messages in a row, a change of topic.

**2. Writes scenarios for each item.** Each one is an ordinary [test file](./tests.md) with:

- the conversation so far, so the test starts mid-thread the way real conversations do;
- the situation in `context`: the time, the account, the booking, an opt-out;
- the user's next message;
- `tool_responses`: what every tool answers in this story, in call order, with the failure or the injected text planted where the item is about one;
- what has to happen: required and forbidden tools, grading criteria, and yes/no checks for an order that matters.

To keep topics out of the suite, name them: `agentdiff scenarios --avoid "medical emergencies, self-harm"`. The planner and the writer both get it.

A tool is only forbidden when the writer names the prompt rule it would break, or the harm it would do, in that moment. A lookup is never forbidden on its own. A tool that sends a message is only required when the prompt says replies go out through it. Otherwise the agent's final text is its reply, and that's what the grader reads.

If the model account runs out of credits, hits its spend limit, or the key is refused, writing stops at once and the scenarios already written are kept. Each item's scenarios are also saved under `partial/` as soon as they're written, so a run that's killed partway loses nothing it paid for.

A scenario that can't run as written is dropped and listed with the reason: a tool the agent doesn't have, a required tool with no answer, a context that isn't an object.

**3. Saves them for review.** Nothing is added to your suite and the agent doesn't run. The scenarios go to `.agentdiff/scenarios-<time>/tests/`, next to `report.md`, which lists every item with the scenarios written for it and every gap. Keep the ones that describe what your agent should do: add them from the dashboard, or copy them into your tests folder.

## In the dashboard

`agentdiff view` has a **Scenarios** page. **Write scenarios** runs the same thing as a job, with progress. The page then shows:

- the totals: scenarios, things to cover, gaps, and how many are in your tests;
- every scenario in one table, filtered by area, with its next message and how many tools it answers;
- the **Coverage** tab: each thing to cover with its scenario count, gaps marked, and anything that wasn't written, with the reason.

Click a scenario to read the conversation, the situation, each tool's answers and what should happen. Tick the ones you want and **Add to tests**: they are copied into your tests folder as they read now, with where they came from, and a draft you already added isn't added twice. Edit a draft file and it counts as new.

## Scripted tool answers

Because every scenario carries its own `tool_responses`, its tests never call your real tools: a scenario about a declined card can't charge one. A tool the agent calls that the scenario doesn't answer stops that run with its name. The grader sees the tool answers too, so a reply that says "your card was declined" is judged against the declined card, not as something the agent made up. See [Tests](./tests.md#scripted-tool-answers).

Running a test on scripted answers swaps the agent's tools, so it needs the same support as [Braintrust replays](./braintrust.md): a Mastra agent on @mastra/core 1.63.2 or later, the OpenAI Agents SDK, or a function agent that calls its tools through `run.tools`.

Next: run [`agentdiff check`](./check.md) on the scenarios you kept, to see how the agent behaves on them before you change anything.

Speed: the scenarios for the prompt's rule sentences are written while the plan is made, and agentdiff's model calls run 12 at once (`AGENTDIFF_MODEL_CONCURRENCY`) with low reasoning effort (`AGENTDIFF_REASONING`, or `default` to leave it to the model). If planning fails, the rule scenarios are still saved and the report says why.

Cost: one model call to plan, and one per thing to cover (`--per-item` scenarios each, 2 by default). It needs `OPENAI_API_KEY`.

[← README](../README.md)
