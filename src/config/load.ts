import path from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigSchema, type Config } from "../types.ts";
import { exists } from "../storage/fs.ts";
import { Workspace } from "../storage/workspace.ts";
import { errMessage, fail } from "../lib/errors.ts";

export interface LoadedConfig {
  config: Config;
  /** Directory the config file lives in — all relative paths resolve from here. */
  rootDir: string;
  /** The project's .agentdiff/ workspace, beside the config. */
  workspace: Workspace;
}

/** Config filenames looked up in the working directory, in order. */
export const CONFIG_FILES = ["agentdiff.config.ts", "agentdiff.config.js", "agentdiff.config.mjs"];

/** The config file to use: `explicitPath`, else the first CONFIG_FILES match in the cwd, else null. */
export async function findConfigFile(explicitPath?: string): Promise<string | null> {
  if (explicitPath) {
    const configPath = path.resolve(explicitPath);
    if (!(await exists(configPath))) fail(`Config file not found: ${configPath}`);
    return configPath;
  }
  for (const candidate of CONFIG_FILES) {
    const p = path.resolve(process.cwd(), candidate);
    if (await exists(p)) return p;
  }
  return null;
}

/**
 * The workspace beside the config. Kept relative to the cwd so printed paths
 * stay short (".agentdiff/compare-…" when the config is right here).
 */
function workspaceFor(configPath: string): Workspace {
  return new Workspace(path.relative(process.cwd(), path.dirname(configPath)) || ".");
}

/** The project's workspace, for commands that read results without loading the config. */
export async function locateWorkspace(explicitConfigPath?: string): Promise<Workspace> {
  const configPath = await findConfigFile(explicitConfigPath);
  return configPath ? workspaceFor(configPath) : new Workspace(".");
}

/** Locate and load the user's agentdiff config. Throws a clear error on failure. */
export async function loadConfig(explicitPath?: string): Promise<LoadedConfig> {
  const configPath = await findConfigFile(explicitPath);
  if (!configPath) {
    fail(
      `No agentdiff.config.ts found in ${process.cwd()}. ` +
        `Create one exporting { agent, agentPath | versions: { old, new }, tests, runsPerTest }.`,
    );
  }

  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(configPath).href)) as Record<string, unknown>;
  } catch (err) {
    fail(`Could not import config ${configPath}: ${errMessage(err)}`);
  }

  const raw = (mod!.default ?? mod) as unknown;
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    fail(`Invalid agentdiff.config: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  }

  return { config: parsed.data, rootDir: path.dirname(configPath), workspace: workspaceFor(configPath) };
}
