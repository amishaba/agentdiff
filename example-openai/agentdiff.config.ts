// Same tests as ../example: the comparison should read the same whichever
// framework the agent is built with.
export default {
  agent: "supportAgent",
  versions: {
    old: "./agents/support-v1.ts",
    new: "./agents/support-v2.ts",
  },
  tests: "../example/tests",
  runsPerTest: 10,
  // Its tools return fixed values and reach nothing real, so discovery runs them as they are.
  discovery: { tools: "own" },
};
