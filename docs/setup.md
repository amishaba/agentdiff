# Setting it up by hand

`npx github:amishaba/agentdiff` does all of this for you the first time you run it. These are the same steps by hand, for when you want to see or change each piece.

You need Node 22.12 or newer, and your agent's code in a git repo. agentdiff runs Mastra agents, OpenAI Agents SDK agents, or any function that calls a model ([how to export yours](./agents.md)).

**1. Install it**

```bash
npm install --save-dev github:amishaba/agentdiff
```

**2. Add your API keys**

agentdiff reads keys from a `.env` file in the folder you run it from. Copy the template:

```bash
cp node_modules/agentdiff/.env.example .env
```

Then fill in two keys:

- `OPENAI_API_KEY`, from [platform.openai.com](https://platform.openai.com/api-keys). It writes extra test cases and the explanation.
- `AI_GATEWAY_API_KEY`, from [Vercel AI Gateway](https://vercel.com/ai-gateway). It grades every run with Jev.

Only have an OpenAI key? Add `AGENTDIFF_GRADER=openai` to `.env`, and OpenAI does the grading too.

**3. Write a test**

A test is a message to send your agent, plus what should happen. Save this as `tests/refund.json`:

```json
{
  "name": "refund request",
  "input": "I want a refund for order 42",
  "must_call_tools": ["lookup_order"],
  "grading_criteria": "Looks up the order before promising a refund."
}
```

Only `name` and `input` are required. See [every test field](./tests.md).

**4. Tell agentdiff where your agent is**

Create `agentdiff.config.ts` in your project's root folder:

```ts
export default {
  agent: "supportAgent",             // the name your file exports the agent as
  agentPath: "./agents/support.ts",  // the file the agent is in
  tests: "./tests",                  // the folder from step 3
};
```

**5. Run it**

```bash
npx agentdiff compare main
```

This runs your tests on two versions of `agents/support.ts`. The **old** agent is the file as it is on `main`. The **new** agent is the file as it is in your folder right now, uncommitted edits included. Each test runs 10 times on each version, so 5 tests means 100 agent runs. You can use any git ref in place of `main`, such as `HEAD~1` or a tag.

The summary prints in your terminal. To look through the results in your browser:

```bash
npx agentdiff view   # starts the dashboard at http://localhost:4321
```

Results are saved in `.agentdiff/`, next to your config. Add that folder to `.gitignore`.

**Other ways to run it**

- **Two files instead of git:** replace `agentPath` with `versions: { old: "./agents/v1.ts", new: "./agents/v2.ts" }`, then run `npx agentdiff compare` with no ref.
- **Without keys:** set `AGENTDIFF_OFFLINE=1`. Your agent still runs, but nothing is graded, explained or discovered. You see what each version did: which tools it called, in what order, and whether it replied.
- **On every pull request:** the [GitHub Action](./github-action.md) runs the same comparison and posts one comment.

[← README](../README.md)
