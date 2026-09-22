import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { exists } from "../storage/fs.ts";
import { errMessage, fail } from "../lib/errors.ts";
import { importFromProject } from "./peer.ts";
import { isOpenAIAgent, openAIAgentsAdapter } from "./adapters/openai-agents.ts";
import { functionAdapter, isAgentFunction } from "./adapters/function.ts";

/**
 * An imported agent: a Mastra agent as-is, or an AgentAdapter around another
 * framework. Mastra is a peer dependency whose surface differs across
 * versions, so agent/ duck-types it and never imports @mastra/core.
 */
export type AnyAgent = Record<string, any>;

/**
 * Replay rebuilds a Mastra agent from its internals, so it needs a version it
 * was tested on: 1.63.2 through the rest of 1.x (tested on 1.63.2 and 1.72.0).
 */
export function mastraReplaySupported(version: string): boolean {
  const [major, minor, patch] = version.split("-")[0].split(".").map(Number);
  return major === 1 && (minor > 63 || (minor === 63 && patch >= 2));
}

/**
 * Import the user's agent file and return the exported agent: a Mastra agent as
 * it is, or an adapter around an OpenAI Agents SDK agent or a plain function.
 */
export async function importAgent(
  rootDir: string,
  fileRel: string,
  exportName: string,
  opts: { maxTurns?: number } = {},
): Promise<AnyAgent> {
  const file = path.resolve(rootDir, fileRel);
  if (!(await exists(file))) {
    fail(`Agent file not found: ${file}`);
  }

  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } catch (err) {
    fail(`Could not import agent file ${fileRel}: ${errMessage(err)}`);
  }

  const agent = (mod![exportName] ?? mod!.default) as AnyAgent | undefined;
  if (!agent) {
    const names = Object.keys(mod!).filter((k) => k !== "default");
    fail(
      `Export "${exportName}" not found in ${fileRel}. ` +
        (names.length ? `Available exports: ${names.join(", ")}.` : "File has no named exports."),
    );
  }
  if (typeof agent.generate !== "function") {
    if (isOpenAIAgent(agent)) {
      try {
        return await openAIAgentsAdapter(agent, file, opts);
      } catch (err) {
        fail(errMessage(err));
      }
    }
    if (isAgentFunction(agent)) return functionAdapter(agent, exportName);
    fail(
      `Export "${exportName}" in ${fileRel} isn't an agent agentdiff can run. Export a Mastra agent, an OpenAI Agents SDK agent, ` +
        "or a function that takes the input and returns { text, toolCalls }.",
    );
  }
  try {
    const require = createRequire(file);
    const pkg = JSON.parse(readFileSync(require.resolve("@mastra/core/package.json"), "utf8"));
    Object.defineProperty(agent, "__agentdiffReplaySupported", {
      value: mastraReplaySupported(pkg.version),
      configurable: true,
    });
    // Tests with a context pass it as Mastra's RequestContext, from the project's own copy.
    const rc = await importFromProject(file, "@mastra/core", "./request-context");
    if (rc?.RequestContext)
      Object.defineProperty(agent, "__agentdiffRequestContext", { value: rc.RequestContext, configurable: true });
  } catch {
    /* Ordinary comparisons keep supporting older Mastra versions. */
  }
  return agent;
}
