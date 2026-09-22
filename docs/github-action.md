# GitHub Action

```yaml
name: agentdiff
on:
  pull_request:
    paths: ["agents/**", "agentdiff.config.ts", "tests/**"]

permissions:
  contents: read
  pull-requests: write

jobs:
  compare:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "22" }
      - run: npm ci
      - uses: amishaba/agentdiff@main
        env:
          AI_GATEWAY_API_KEY: ${{ secrets.AI_GATEWAY_API_KEY }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          # plus whatever key your own agent uses
```

The Action compares `agentPath` on the PR against the base branch and leaves one comment, which it updates on every push. The comment has:

- a headline: `11 of 16 tests changed: 1 broke a rule, 7 worse, 2 better · … · cost -10%`;
- a chart;
- one table, worst test first;
- two sentences: the likely cause, and a fix to try.

If the snapshot of the PR's agent matches the base, the Action skips the runs and removes its old comment. Set `working-directory` if the config isn't at the repo root.

[← README](../README.md)
