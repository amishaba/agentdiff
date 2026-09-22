# Mutation testing

`agentdiff compare` tells you what changed. `agentdiff mutate` tells you whether your tests would notice.

It makes copies of your agent, each with one thing taken out of its source:

- **a rule sentence** from the prompt: any sentence with *never, only, always, must, before, after, unless, first* and the like, e.g. "Call change_flight only after they reply YES to that exact proposal."
- **a guardrail**: one entry from `inputGuardrails`, `outputGuardrails`, `inputProcessors` or `outputProcessors`.

Then it runs every test on the agent and on each copy, and labels each test the way `compare` does. A copy is **caught** when some test breaks a rule or gets worse, in both halves of its runs. A test whose own runs already disagree (what `check` calls unpredictable) catches a copy only by breaking a tool rule: a judge scoring it lower is no evidence a rule is missing. Each copy's grades and check answers are saved under `verdicts/`, so every catch can be checked against what made it.

```
agentdiff mutate                        # the config's agentPath, else versions.old
agentdiff mutate agents/desk-v1.ts --runs 4 --max 12
agentdiff mutate --baseline check-<time>   # use a finished check's runs as the agent's side
```

```
9 of 12 seeded regressions caught
  not caught: Never repeat a card number.
  not caught: w.draftReviewGuardrail (outputGuardrails)
```

A copy nothing caught is a rule no test exercises, or one the agent follows without being told. Either way it's the next test to write.

The edits are made to the source text, so it works for every kind of agent agentdiff runs, and for a team defined in one file. The prompt can be in the agent file or in a local file it imports (a `prompt.ts` next to it): every file on the import chain is copied, each importing the next copy. A sentence has to be written out as text; one assembled from variables can't be found. The copies sit next to their originals so other imports resolve, and are removed once they're loaded.

Cost: each copy runs the tests most related to what it lost first (tests that require or forbid a tool the sentence names, then those that share its words), a batch at a time, and stops at the first batch that catches it. Only a copy nothing catches runs every test. The agent itself runs every test `--runs` times, unless `--baseline` points at a finished `agentdiff check` of the same file, whose runs and grades are used instead. Set `AGENTDIFF_OFFLINE=1` to skip grading and count only broken rules. The report is saved under `.agentdiff/mutate-<time>/`.

[← README](../README.md)
