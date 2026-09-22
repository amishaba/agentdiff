# agentdiff

regression testing for AI agents.

[![ci](https://github.com/amishaba/agentdiff/actions/workflows/ci.yml/badge.svg)](https://github.com/amishaba/agentdiff/actions/workflows/ci.yml) · **live examples: [agent-diff.vercel.app](https://agent-diff.vercel.app/)**

## why i built this

the beauty of the agent world is that agents might be our first truly autonomous pieces of code. they can act agentically, on their own, across business and product functions. at the core of that autonomy are two building blocks: prompts and tools (which can be combined further into subagents).

tools are the more deterministic, testable part. a `return_balance` tool, given a valid input, a good sql query and a durable db connection, will always return the right balance. chain a bunch of these together and you get an agent that, from a single text message, books you an entire trip from sf to nyc: flights, hotels, big bus rides, restaurant reservations.

and at the core of that orchestration is the prompt. it works almost like the agent’s dna, or its brain, or maybe its nurture. any agent run on the same model will produce roughly the same output, so the prompt and tools are what make my agent act differently from yours.

so prompt wording changes what an agent does more than you’d expect. adding a line like “be concise” can make it call fewer tools, and the model you’re on changes how much. but nobody reviews a prompt change the way they review code. a prompt diff seems less important than a code diff, semantically and empirically, so it ships with less scrutiny (imo).

i made agentdiff mostly to see what actually changes between two versions of an agent.

Also, it's pretty easy to go online and find people talking to their instinct, muse, grok, dot, poke, pickle or what have you, and the agent saying stuff like 'you're right, and i shouldn't have…' even after super explicit, clear instructions. While we don't have insight into what these agents have in their prompts, i can imagine the frequent changes being made to these high-growth, early-stage products could be to blame. agentdiff has also helped me understand and benchmark some of that.

## one line, ten runs

the example on [my site](https://agent-diff.vercel.app/?view=report&example=sms) is an sms travel agent. the first version changes a flight only after the traveler replies YES to that exact proposal. the second, trying to reduce friction, says: for other fares, be proactive, complete the change without back-and-forth.

> in 10 of 10 runs, the new version moved the traveler’s flight before they said yes. the old one never did.

it reads like a small ux tweak. it took away the agent’s main guardrail.

[![The SMS travel desk example, "Reply faster, cut Jev costs": 11 of 16 tests behave differently. The new agent calls change_flight without a YES in 10 of 10 runs, and replies to STOP, thanks and tapbacks where the old agent's opt_out and should_reply guardrails sent nothing. 10 runs per test.](./docs/review.png)](https://agent-diff.vercel.app/?view=report&example=sms)

## quick start

```bash
npx github:amishaba/agentdiff
```

Run it in your agent's git repo. The first time, it finds your agent, asks for your API keys, and writes a config and starter tests from your agent's prompt. Then it compares your edits with the version on `main` and opens the results. After that, change your prompt and run it again.

Needs Node 22.12 or newer. Works with Mastra, the OpenAI Agents SDK, or [any function](./docs/agents.md). To keep it in your project instead, run `npm install --save-dev github:amishaba/agentdiff`, and after that it's `npx agentdiff`. To set it up by hand, see [setup](./docs/setup.md).

## how it works

`agentdiff compare main` runs your tests against both versions, with git as the old side: the old ref is checked out into a throwaway worktree, so there’s no baseline to keep in sync. it diffs what the agent did, which tools, in what order, at what cost and how fast, not just what it said. “refunded first, looked the customer up after” still shows up when every required tool fired.

## agents are random

one run of each version proves nothing. agents are nondeterministic, so to tell whether a difference is a real pattern or a fluke, you have to run the same test several times. agentdiff runs each version of the prompt 10 times by default and splits its runs in two. a change counts only if it shows up in both halves, and not between the old agent’s own halves. that’s what separates a regression from noise.

more: [how a comparison works](./docs/how-it-works.md) (the seven stages, the labels, who judges).

## starting from just a prompt

a new agent has no old version to compare against, and no tests yet. `agentdiff scenarios` reads the prompt and tools and writes a suite: earlier turns of the conversation, the situation, what every tool answers, and what should happen. `agentdiff check --trial` runs each test once to catch the ones that expect the wrong thing, then `agentdiff check` runs them all 10 times by default and says which tests the agent breaks a rule on, scores low on, or handles differently from run to run.

the [clinic example](https://agent-diff.vercel.app/?view=report&example=clinic) started this way: 95 tests written from its prompt, then a "faster booking" edit that booked appointments before the patient confirmed in 13 of 44 runs.

## what it catches

| You changed… | agentdiff shows |
|---|---|
| removed a guardrail or a gate | texts sent after STOP, replies to 👍, a check that no longer runs |
| made a flow faster | a charge before the trip is settled, a policy check skipped |
| softened a prompt line | a required tool called less often, a refund with no fraud check |
| switched to a cheaper model | the cost change, next to what the cheaper model stopped doing |
| made booking faster | appointments booked before the patient confirms |

## what i learned

an agent’s guardrails live in its prompt, and it’s easy to talk the agent out of them without meaning to. the worst cases are super long IF AND NOT BUT NEVER ALWAYS chains. agents always seem to make weird mistakes on those.

## docs

| | |
|---|---|
| [Setup](./docs/setup.md) | the config, keys and test files, by hand |
| [Tests](./docs/tests.md) | the test file format, checks, write tools |
| [Your agent](./docs/agents.md) | Mastra, OpenAI Agents SDK, or a plain function |
| [Discovery](./docs/discovery.md) | finding the cases you didn't write tests for |
| [Check](./docs/check.md) | how one version behaves on every test, with nothing to compare against |
| [Scenarios](./docs/scenarios.md) | writing a suite from the prompt and tools alone, with scripted tool answers |
| [Mutation testing](./docs/mutate.md) | seeding regressions into your agent to see which ones your tests catch |
| [Braintrust](./docs/braintrust.md) | turning failed production runs into tests |
| [GitHub Action](./docs/github-action.md) | one PR comment per pull request |
| [Development](./docs/development.md) | scripts, CI, and the code layout |

## commands

With agentdiff installed in your project:

```bash
npx agentdiff                  # set up on the first run, then compare against main and open the results
npx agentdiff compare [ref]    # run a comparison; --if-changed skips it when the agent is unchanged
npx agentdiff view             # the local dashboard: comparisons, Braintrust incidents, project settings
npx agentdiff report [dir]     # rebuild a saved comparison's report, no model calls
npx agentdiff explain          # a longer explanation of the last comparison
npx agentdiff check            # how the agent as it is behaves on every test, no old version needed
npx agentdiff check --trial    # every test once, ungraded: find tests that expect the wrong thing first
npx agentdiff scenarios        # write test scenarios from the prompt and tools, for review
npx agentdiff mutate           # seed regressions into the agent and count the ones your tests catch
npx agentdiff ci               # the GitHub Action's entry point
```

Add `-c path/to/agentdiff.config.ts` to use a config file somewhere else.

## examples

The repo has five example agents, each with a real prompt change and a set of tests:

- [`example-sms/`](./example-sms): a travel desk that travelers text. The change, "Reply faster, cut Jev costs", drops the opt-out rule and lets the agent change flights without a YES. 16 tests.
- [`example-booking/`](./example-booking): four OpenAI Agents SDK agents that book business trips. The change, "Faster bookings", skips the policy check and charges holds early. 9 tests.
- [`example/`](./example) and [`example-openai/`](./example-openai): a support agent, in Mastra and in the OpenAI Agents SDK, with a softened refund policy. 7 tests.
- [`example-clinic/`](./example-clinic): a clinic's text-message booking assistant, a function agent. The change, "Faster booking", books the first open slot as soon as a patient asks. Its 95 tests were written by `agentdiff scenarios` from the prompt alone.

Each example uses the copy of agentdiff in this repo, so set the repo up first:

```bash
git clone https://github.com/amishaba/agentdiff.git
cd agentdiff
npm install
npm run build:web          # builds the dashboard

cd example-sms
npm install
npx agentdiff              # asks for your keys, then runs the example
```

The example agents call OpenAI themselves, so they need `OPENAI_API_KEY` even with `AGENTDIFF_OFFLINE=1`. The SMS example is 320 agent runs (16 tests, 10 runs each, two versions) and takes about 30 minutes.

The [live examples](https://agent-diff.vercel.app/?view=report) are real recordings of these.

## license

MIT, see [LICENSE](./LICENSE).
