# Check

`agentdiff compare` needs an old version to compare with. `agentdiff check` doesn't: it runs your agent as it is on every test, several times, and says how each test went.

```
agentdiff check                 # runsPerTest from the config
agentdiff check --runs 6
agentdiff check --trial                 # every test once, ungraded: find tests that expect the wrong thing
agentdiff check --resume check-<time>   # finish a trial, or a check that stopped partway
```

```
11 of 16 tests steady · 2 break a test rule · 1 scores low · 2 unpredictable
  breaks a test rule: thanks (called send_sms in 3/10 runs)
  unpredictable: card declined (runs differ in whether it calls release_hold, the steps it takes)
```

Each test gets one verdict, worst first:

- **Errors:** runs that failed.
- **Breaks a test rule:** in at least one run it skipped a tool in `must_call_tools` or called one in `must_not_call_tools`. One run is enough, however well it scored.
- **Scores low:** its average grade is under 3 out of 5.
- **Unpredictable:** its runs disagree with each other: a tool some runs call and others don't, replying in some and not others, a check answered differently by at least two runs, or scores from good to bad (3 points apart or more). One judge answering one run differently doesn't count, and neither do run time and cost.
- **Steady:** none of the above.

The grader sees every tool call with its input and output, so an agent that replies through a tool (`send_sms`) is judged on what it sent. See [Tests](./tests.md).

## In the dashboard

`agentdiff view` has a **Check** page. **Run check** runs it as a job, with progress. The page shows how many tests are steady, break a rule, score low or are unpredictable, and every test in one table with its verdict, its rules, its score, its usual path and what happened. Click a test to see each run: every tool it called, what it passed in and got back, and its final text.

Use it on a new agent before its first commit, after [writing scenarios](./scenarios.md) for it, or before a prompt edit, to know which tests are already unpredictable: a change there in a later comparison may be noise.

Speed: the agent runs `concurrency` runs at once (config, default 8). Grading and checks run at the same time, 12 model calls at once (`AGENTDIFF_MODEL_CONCURRENCY`), with low reasoning effort (`AGENTDIFF_REASONING`).

## Try the tests first

New tests, especially [written ones](./scenarios.md), can expect something the agent doesn't do. `agentdiff check --trial` runs every test once and grades nothing, so it costs one agent run per test. It lists which tests kept their tool rules, and the rules broken most:

```
82 of 120 tests kept their tool rules · 38 broke one
Rules broken most (one rule broken in many tests is worth reading those tests first):
  lookup_order, forbidden: called in 14 tests
  send_sms, required: skipped in 5 tests
```

Fix or delete the tests that expect the wrong thing, then `agentdiff check --resume check-<time>`: it keeps the trial's runs, runs the rest up to `runsPerTest`, and grades them all.

## Before and during the runs

A check doesn't spend runs on a suite that can't pass:

- **Before it starts**, it lists every tool the tests require that the agent doesn't have, with the tests that require it, and runs nothing. `compare` does the same, against the tools of both versions.
- **While it runs**, it stops after 20 runs if almost all of them errored (a missing key, a model the account can't use), or if a tool that at least 5 tests require was called in 5% of their runs or fewer. The second usually means the tests expect a tool the agent doesn't use that way, such as a send tool for an agent that replies in its final text. `compare` stops for the same reasons.

If grading hits an account with no credits or a refused key, it stops there instead of scoring every run as an error.

The runs saved before it stopped stay in its folder. `agentdiff check --resume check-<time>` keeps them, runs the rest (and any that errored) without stopping early, then grades them all. It's also how to finish a check whose process died.

A finished check can stand in for its agent later, so those runs aren't paid for again: `agentdiff compare --baseline check-<time>` uses it as the old side, when it's a check of `versions.old` (`agentdiff check agents/v1.ts`), and `agentdiff mutate --baseline check-<time>` uses it as the agent's side.

It needs at least 2 runs per test, to compare them. The report is saved under `.agentdiff/check-<time>/`, with every run. `AGENTDIFF_OFFLINE=1` skips grading and checks only the tool rules and paths.

[← README](../README.md)
