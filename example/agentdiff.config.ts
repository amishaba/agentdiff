export default {
  agent: "supportAgent",

  // Two-file mode: keep an explicit old/new pair side by side.
  // Used by `agentdiff baseline` and `agentdiff compare` (no ref).
  versions: {
    old: "./agents/support-v1.ts",
    new: "./agents/support-v2.ts",
  },

  // Git mode (alternative to `versions`): point at a SINGLE agent file and let
  // git provide the "old" side. Then `agentdiff compare main` / `compare HEAD~1`
  // diffs your working tree against that ref — no second file to maintain.
  // agentPath: "./agents/support.ts",

  tests: "./tests",
  runsPerTest: 5,
};
