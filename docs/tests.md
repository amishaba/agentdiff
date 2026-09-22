# Tests

Each test is one JSON file in `tests/`:

```json
{
  "name": "thumbs up after a confirmation",
  "conversation": [
    { "role": "user", "content": "Book the 9:15 to JFK" },
    { "role": "assistant", "content": "Booked UA518, seat 23C." }
  ],
  "input": "👍",
  "context": { "now": "2026-10-13T23:40:00-07:00", "do_not_contact": false },
  "must_call_tools": [],
  "must_not_call_tools": ["send_sms"],
  "grading_criteria": "A thumbs-up after a confirmation needs no reply.",
  "checks": {
    "replied": "Did the agent send a reply?",
    "outcome": { "question": "What did the agent do?", "options": ["nothing", "confirmed again", "asked a question"] }
  }
}
```

Only `name` and `input` are required.

- `conversation`: the earlier turns, oldest first. The agent gets them as history, then `input` as the new message.
- `context`: the state your tools read. It is passed as Mastra's `RequestContext`, as the OpenAI Agents SDK's run `context`, or as the second argument to a function agent.
- `must_call_tools` / `must_not_call_tools`: skipping a required tool, or calling a forbidden one more often, breaks a rule.
- `grading_criteria`: what the grader grades each run against. The grader sees the final text **and every tool call, with its input and output**: an agent acts through its tools as much as through what it says, so a message it sends with a tool (an SMS, an email) is graded like a reply, and so are the arguments it passes.
- `checks`: questions about what each run did. A string is a yes/no question. `{ question, options }` picks one option. Every run's answers are compared between the agents.
- `tool_responses`: scripted answers for the agent's tools, so the test never runs the real ones. See below.

Two checks are asked of every run, so you don't have to write them:

- `failure_type`: what went wrong, if anything. One of `none`, `skipped_step`, `wrong_order`, `wrong_tool`, `wrong_arguments`, `unsupported_claim`, `looped`, `gave_up`, `unwanted_reply` or `missing_reply`.
- `acted_before_check`: whether the agent changed something before the check that change depends on, such as moving money before verifying the customer.

### Agents that reply through a tool

If your agent sends its reply with a tool (`send_sms`, `send_email`) instead of returning text, test the tool. A test where it should answer says `"must_call_tools": ["send_sms"]`; one where it should stay quiet (after "STOP", or an "ok" after a goodbye) says `"must_not_call_tools": ["send_sms"]`. Put what the message should say in `grading_criteria`: the grader reads it from the call. Only do this when the agent really replies through the tool: if its reply is its final text, a test that requires the send tool can't pass, and `check` stops early to say so.

Set `writeTools` in the config to the tools that change something outside the agent:

```ts
writeTools: ["send_sms", "charge", "cancel_booking"]
```

agentdiff then flags a write tool that's called more often, or one that now runs without a step that used to come before it.

## Scripted tool answers

A test can say what each tool answers instead of letting the agent's real tools run, so a test about a declined card never charges one:

```json
"tool_responses": {
  "lookup_customer": [{ "verified": true, "name": "Jane Doe" }],
  "charge": [{ "status": "declined", "reason": "insufficient_funds" }, { "status": "ok" }]
}
```

Each tool gets its outputs in call order: the first `charge` is declined, the second goes through, and any call after that gets the last answer again. The arguments don't have to match, so the test runs the same against any version of the prompt. A call to a tool that isn't listed stops the run and names the tool. Like every tool call, these answers are in front of the grader, so it judges the reply against what the tools said.

[`agentdiff scenarios`](./scenarios.md) writes them for you. A test answers its tools from `tool_responses` or from a Braintrust recording (`replay`), not both.

## Checks in the path

A path is the ordered list of what a run did, including the checks the agent ran along the way. One agent's path might read `should_reply: no → no reply` while the other's reads `should_reply: yes → send_sms`. agentdiff records three kinds of check with no setup:

- **OpenAI Agents SDK guardrails.** These are answered "tripped" or "passed". A tripped guardrail ends the run as `no reply`, not as an error.
- **Jev questions your agent asks itself**, to route a message or gate a tool. These go through the AI SDK's `experimental_evaluate` or TypeSafe's API. Only the question and the answer are kept.
- **A function agent's own checks**, which it reports itself: `checks: [{ id: "opted_out", answer: true, after: 0 }]`. Here `after` is how many tool calls came before the check.

When one agent runs a check and the other never does, it's listed once, as removed or added. The two paths are then compared without it.

[← README](../README.md)
