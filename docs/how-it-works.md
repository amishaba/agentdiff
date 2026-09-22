# How a comparison works

Every `compare` runs the same seven stages. Nothing is optional. Cost isn't the point here: a comparison that leaves out a stage misses changes.

| stage | what happens |
|---|---|
| **collect** | your tests, the [Braintrust incidents](./braintrust.md) you saved, and the [discovery](./discovery.md) drafts you promoted |
| **snapshot** | both agents: prompts, tools, models, guardrails, every agent in a team |
| **run** | every test on both agents, `runsPerTest` times each (10 by default), fresh. Old and new runs are interleaved, `concurrency` at a time (8 by default; lower it if your provider rate-limits), so a slow patch at the provider hits both alike. The old agent comes from a throwaway git worktree, so there's no saved baseline to go stale. |
| **discover** | new cases aimed at what you changed, run on both agents, with any difference confirmed on fresh runs |
| **judge** | every run is graded and its checks answered, then each change is confirmed in two halves of the runs |
| **explain** | the likely cause, and a fix to try |
| **save** | one result: `comparison.json`, `report.md`, the dashboard and the PR comment |

A missing key stops the comparison before any agent runs, and the error names the key. A stage that can't run (discovery without an OpenAI key, say) is marked blocked, with the reason, at the top of the report. It is never silently skipped. `AGENTDIFF_OFFLINE=1` runs only the agents and the exact comparison, for working without keys.

## Is it a real change?

Agents are random, so a single run that goes the other way can look like a change. agentdiff splits each side's runs into two halves. A change counts only when two things are true:

- it shows up from old to new in **both** halves;
- it doesn't show up between the old agent's own two halves.

Anything else that moved is marked ❔ inconclusive. A noise line names the tests where the old agent moved against itself.

## What kind of change?

Each test gets one label. The report lists the most serious first.

| | label | when |
|---|---|---|
| 🛑 | broke a rule | a forbidden tool is called more often, a required tool is skipped, a write tool is called more often, or a write tool now runs without a step that used to come first (e.g. `charge` without `check_trip_policy`) |
| 🔻 | worse | the grade dropped, or fewer runs had nothing wrong |
| ✅ | better | the grade rose, or more runs had nothing wrong |
| • | different | something moved, but not for better or worse, e.g. a new path to the same result, cost up or down 10%+, or runs 25% and a full second slower or faster |
| ❔ | inconclusive | it moved in only one half, or no more than the old agent moves against itself |

The rules are exact checks on the recorded tool calls. They don't rely on a model's opinion, which is why they come first. Worse and better come from the grade and the built-in `failure_type` check. A reply that starts or stops is labelled by the grade too: answering a stranded traveler is better, and answering "STOP" is worse.

## Who judges: Jev or OpenAI

By default, [Jev](https://docs.typesafe.ai/introduction) grades every run and answers every check, through [Vercel AI Gateway](https://vercel.com/ai-gateway/models/jev). Jev is TypeSafe's decision model. It doesn't write an opinion. For each question it returns how likely each answer is: for a grade, a probability for each of five levels from "fails the criteria" to "fully meets it". agentdiff turns those probabilities into a 1–5 grade. Jev is fast (about 100 ms) and cheap ($0.042 per million input tokens), so asking it about every run of every test is affordable. Jev sees only the agent's outputs and tool calls.

Set `grader: "openai"` in the config, or `AGENTDIFF_GRADER=openai`, to have an OpenAI model (`AGENTDIFF_MODEL`, default `gpt-5.4`) do both jobs instead. It writes a reason for each grade and answers all of a run's checks in one structured call. Each answer is a single pick, not a distribution.

| key | used for |
|---|---|
| `AI_GATEWAY_API_KEY` | Jev: grades and checks (not needed with `grader: "openai"`) |
| `OPENAI_API_KEY` | discovery planning and the explanation, plus grading with `grader: "openai"` |

These are separate from whatever provider your own agent uses.

## Scope

- Git mode loads the old agent with your *current* `node_modules`. It compares your code, not your lockfile.
- A run that fails is recorded as an error and doesn't stop the comparison. If every run on one side fails (no key, no credits, a broken import), the report shows that error instead of zeros, and `agentdiff ci` fails without touching the PR comment.
- Discovery explores a bounded sample of cases, not every combination. Its run limit is a count of agent runs, not a dollar cap.
- `agentdiff ci` handles `pull_request` events only.

[← README](../README.md)
