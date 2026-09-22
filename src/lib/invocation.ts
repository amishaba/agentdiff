/**
 * How to run agentdiff again, for the messages that say so: `npx agentdiff`
 * when it's installed in the project, the GitHub form when npx fetched it.
 */
export const AGENTDIFF = /[\\/]_npx[\\/]/.test(process.argv[1] ?? "")
  ? "npx github:amishaba/agentdiff"
  : "npx agentdiff";
