export default {
  agent: "supportAgent",

  // Git / CI — one file; `agentdiff compare <ref>` and `agentdiff ci` use this.
  agentPath: "./agents/support.ts",

  // Two-file mode — `compare` with no ref runs versions.old against versions.new.
  versions: {
    old: "./agents/support-v1.ts",
    new: "./agents/support-v2.ts",
  },

  tests: "./tests",
  runsPerTest: 10,
  discovery: {
    // Every compare runs discovery against these fake tools.
    fixtures: "./discovery-fixtures.ts",
    context: "Test account Jane Doe and order ORDER-123 exist. Lookup returns verified=true; the risk service returns low risk. All action tools return a simulated success. No other fixture states are available.",
  },
};
