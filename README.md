# AgentDiff

When you change an AI agent, AgentDiff tells you **how its behaviour changed** and **whether you made it worse**.

Point it at two versions of a [Mastra](https://mastra.ai) agent and a folder of test inputs. AgentDiff runs both, then reports the differences that matter: tool-call rates, cost, latency, step counts, an AI grade per test, and a diff of the prompt and model settings — plus an AI-written explanation of the likely cause of any regression.

## How it works

The fastest path is **git mode** — compare your working tree against any git ref:

- `compare <ref>` — checks the ref out into a throwaway git worktree, runs that older agent, runs your current one, diffs them, writes a report to `.agentdiff/compare-<timestamp>/report.md`, and removes the worktree. No separate baseline step.

Or use the **baseline** flow when the "before" agent isn't a git ref:

1. `baseline` — snapshots the **old** agent (prompt, model, tools, settings) and runs it against every test N times, saving the results under `.agentdiff/baseline/`.
2. `compare` (no ref) — runs the **new** agent the same way and compares it against that saved baseline.

Either way, `compare` grades both versions with an AI grader and `explain` re-runs the explainer on the most recent compare for a longer write-up. Short on tests to run? `generate-tests` drafts a starter suite from the agent's own prompt and tools. Everything is stored as plain JSON/Markdown files under `.agentdiff/`. No database, server, or dashboard.

## Requirements

- **Node.js 20+**
- **Mastra** installed in your project (`@mastra/core` — it's a peer dependency, never bundled).
- Your agent's own model provider + API key (e.g. `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`) — whatever your agent already uses.
- A **Gemini API key** for AgentDiff's AI grading, explanation, and test generation (grading/explanation are optional — without a key they're skipped and only the mechanical comparison runs; `generate-tests` requires one).

## Install

```bash
npm install --save-dev agentdiff
```

## Setup

### 1. API key for grading

AgentDiff uses a Gemini key to power the AI grade and the "likely cause" explanation. Copy the template and paste your key:

```bash
cp node_modules/agentdiff/.env.example .env
```

```dotenv
# .env (in the folder you run agentdiff from)
GEMINI_API_KEY=your-key-here
# optional: override the grading/explanation model
# AGENTDIFF_MODEL=gemini-2.5-flash
```

The `.env` in your current directory is loaded automatically. Keys are read from `GEMINI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, or `GOOGLE_API_KEY`.

> This is separate from your agent's own model key. Your agent brings its own provider; AgentDiff only needs Gemini for grading.

### 2. Config file

Create `agentdiff.config.ts` at your project root. There are two ways to tell AgentDiff which agents to compare:

**Git mode (recommended)** — point at a single agent file and let git provide the "before" side:

```ts
export default {
  agent: "supportAgent",              // the exported agent variable (or use the default export)
  agentPath: "./agents/support.ts",   // the one agent file, diffed across git refs
  tests: "./tests",                   // folder of *.json test files
  runsPerTest: 5,                     // how many times to run each test (default 5)
};
```

**Two-file mode** — keep an explicit before/after pair side by side:

```ts
export default {
  agent: "supportAgent",
  versions: {
    old: "./agents/support-v1.ts",    // the "before" agent
    new: "./agents/support-v2.ts",    // the "after" agent
  },
  tests: "./tests",
  runsPerTest: 5,
};
```

### 3. Tests

Each test is a JSON file in the `tests/` folder:

```json
{
  "name": "refund request",
  "input": "I want my money back",
  "must_call_tools": ["lookup_customer"],
  "grading_criteria": "Did the agent verify the customer (via lookup_customer) before refunding? Was the reply polite?"
}
```

- `name` — label shown in the report.
- `input` — the user message sent to the agent.
- `must_call_tools` *(optional)* — tools the agent is expected to call; the report tracks the hit rate per version.
- `grading_criteria` *(optional)* — natural-language rubric the AI grader scores each response against (1–5).

Don't want to hand-write these? Let AgentDiff draft them for you — see [Generate tests](#generate-tests-optional) below.

A complete, runnable reference project lives in [`example/`](./example).

## Usage

### Compare against git history (git mode)

No need to maintain two files. Compare your working tree against any git ref:

```bash
npx agentdiff compare HEAD~1   # working tree vs the previous commit
npx agentdiff compare main     # current branch vs main
npx agentdiff compare v1.2.0   # vs a tag
```

AgentDiff checks the ref out into a throwaway git worktree, runs that older agent, diffs it against your current one, and cleans the worktree up afterwards. No baseline step required.

### Compare against a saved baseline

Useful when the "before" agent isn't in git history (e.g. the two-file setup, or snapshotting the current state before you start editing):

```bash
# 1. Snapshot + run the OLD agent, save the baseline
npx agentdiff baseline

# 2. Run the NEW agent and compare against that baseline
npx agentdiff compare
```

### Generate tests (optional)

Writing the first batch of tests is the most tedious part of setup. Let the LLM draft them from your agent's own prompt and tools:

```bash
npx agentdiff generate-tests            # ~12 scenarios
npx agentdiff generate-tests -n 20      # ask for more
```

It reads the agent snapshot (system prompt + tool names) and proposes a mix of happy-path, edge-case, and hostile (prompt-injection / policy-skipping) scenarios — each written as a normal `tests/*.json` file with `must_call_tools` and `grading_criteria` filled in. Existing test files are never overwritten (a name clash gets a `-2`, `-3`, … suffix).

> These are **drafts**. Read and edit them before you trust a comparison — the LLM is guessing at your agent's intended behaviour, not defining it. Requires a Gemini API key (same key as grading).

Coming later: `generate-tests --from-logs logs.jsonl` to build tests from real production conversations.

### Explain

```bash
# (optional) Get a longer AI explanation of the most recent compare
npx agentdiff explain
```

### View in the browser

```bash
# Open a local web view of your comparison reports
npx agentdiff view
```

Serves a small local page (default port 4321, `-p/--port` to change) that lists every comparison under `.agentdiff/` and renders it: summary stats, per-test tool-call rates and grade/cost/latency deltas with regressions highlighted, the prompt and settings diff, sample responses, and the full `report.md`. It reads the JSON files already on disk — nothing is uploaded, no API key needed. It auto-opens your browser; pass `--no-open` to skip that. Press Ctrl+C to stop.

Point at a config elsewhere with `-c`:

```bash
npx agentdiff baseline -c path/to/agentdiff.config.ts
npx agentdiff compare main -c path/to/agentdiff.config.ts
```

## Output

Written under `.agentdiff/` (safe to gitignore):

```
.agentdiff/
  baseline/                # only in the baseline flow
    snapshot.json          # old agent's prompt/model/tools/settings
    runs/*.json            # every run of the old agent
  compare-<timestamp>/
    snapshot.json          # new agent's snapshot
    runs/*.json            # every run of the new agent
    old-snapshot.json      # old agent's snapshot   (git mode only)
    old-runs/*.json        # every run of the old agent (git mode only)
    comparison.json        # full structured comparison
    report.md              # human-readable report
    explanation.md         # written by `agentdiff explain`
```

In git mode the temporary checkout lives at `.agentdiff/worktree-<n>/` only while the old agent runs, then is removed automatically.

The `compare` command also prints a summary to your terminal. Reports never say PASS/FAIL — they surface what changed (tool-call regressions, cost/latency deltas, grade changes, and the prompt/settings diff) and leave the judgement to you.

## Notes & limitations

- AgentDiff duck-types the Mastra agent and its `generate()` result, so it tolerates differences across Mastra versions. If your agent's export name or `generate` method differs, you'll get a clear import error.
- Each agent run is isolated: a failing run is recorded as an error rather than crashing the whole comparison.
- Requests run with a small concurrency limit to avoid hammering provider rate limits.
- **Git mode** resolves the old agent's dependencies from your *current* `node_modules` (the worktree is nested inside the repo so Node walks up to it). Behaviour changes from swapping package versions between refs won't be reflected — AgentDiff diffs your agent code, not your lockfile.
- This is an MVP focused on the compare workflow above — no CI integration, web UI, or historical trend tracking (yet).

## License

MIT — see [LICENSE](./LICENSE).
