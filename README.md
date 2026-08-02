# AgentDiff

in my experience, prompt wording affects agent behaviour more than expected. adding a line like "be concise" can result in the agent calling fewer tools (the model you are on matters asw). I made this mostly to see what actually changes between two versions of an agent. Built on [Mastra](https://mastra.ai).

It shows you how an agent's behaviour changed between two versions: tool and workflow call rates, cost, latency, steps, an AI grade per test, and a diff of the prompt and settings, plus a short explanation of what likely caused any regression.

## Install

```bash
npm install --save-dev agentdiff
```

Needs Node 20+ and `@mastra/core` in your project (peer dependency, never bundled). Grading, explanations, and test generation use a Gemini key — set `GEMINI_API_KEY` in a `.env` where you run AgentDiff (see `.env.example`). Without a key those steps are skipped and only the mechanical comparison runs. This is separate from whatever provider your own agent uses.

## Configure

Create `agentdiff.config.ts` at your project root. Two ways to pick the "before" agent.

Git mode — one agent file, git provides the old side:

```ts
export default {
  agent: "supportAgent",
  agentPath: "./agents/support.ts",
  tests: "./tests",
  runsPerTest: 5,
};
```

Two-file mode — an explicit old/new pair:

```ts
export default {
  agent: "supportAgent",
  versions: { old: "./agents/support-v1.ts", new: "./agents/support-v2.ts" },
  tests: "./tests",
  runsPerTest: 5,
};
```

## Tests

One JSON file per test in `tests/`:

```json
{
  "name": "refund request",
  "input": "I want my money back",
  "must_call_tools": ["lookup_customer"],
  "grading_criteria": "Did the agent verify the customer before refunding?"
}
```

`must_call_tools` and `grading_criteria` are optional. `must_call_tools` accepts tool or workflow names and the report tracks the hit rate per version. Don't want to hand-write them? `agentdiff generate-tests` drafts a suite from the agent's own prompt, tools, and workflows.

A runnable reference project lives in [`example/`](./example).

## Commands

```bash
npx agentdiff compare HEAD~1   # git mode: working tree vs a ref (also main, a tag, etc.)
npx agentdiff baseline         # two-file mode: snapshot + run the old agent
npx agentdiff compare          # ...then run the new agent and diff against the baseline
npx agentdiff generate-tests   # draft tests/*.json from the agent (-n for count)
npx agentdiff explain          # longer AI writeup of the last compare
npx agentdiff view             # local web view of past comparisons
```

Add `-c path/to/agentdiff.config.ts` to use a config elsewhere.

In git mode, AgentDiff checks the ref out into a throwaway worktree under `.agentdiff/`, runs that old agent, diffs it against your current one, and removes the worktree afterwards.

## Output

Results land in `.agentdiff/compare-<timestamp>/` (safe to gitignore): the individual run records, a structured `comparison.json`, and a human-readable `report.md`. The report never says pass/fail — it shows what changed and leaves the call to you. `agentdiff view` renders these on a local page; nothing is uploaded.

## Limitations

- Duck-types the agent and its `generate()` result, so it tolerates differences across Mastra versions. A wrong export name or missing `generate` gives a clear import error.
- A failing run is recorded as an error rather than crashing the comparison.
- Git mode resolves the old agent against your *current* `node_modules`, so package-version changes between refs aren't reflected — it diffs your code, not your lockfile.
- MVP: no CI integration or trend history yet.

## License

MIT — see [LICENSE](./LICENSE).
