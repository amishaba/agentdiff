import path from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigSchema, type Config } from "./types.ts";
import { exists } from "./storage.ts";

export interface LoadedConfig {
  config: Config;
  /** Directory the config file lives in — all relative paths resolve from here. */
  rootDir: string;
}

const CANDIDATES = ["agentdiff.config.ts", "agentdiff.config.js", "agentdiff.config.mjs"];

/** Locate and load the user's agentdiff config. Exits with a clear message on failure. */
export async function loadConfig(explicitPath?: string): Promise<LoadedConfig> {
  let configPath: string | undefined;

  if (explicitPath) {
    configPath = path.resolve(explicitPath);
    if (!(await exists(configPath))) {
      fail(`Config file not found: ${configPath}`);
    }
  } else {
    for (const candidate of CANDIDATES) {
      const p = path.resolve(process.cwd(), candidate);
      if (await exists(p)) {
        configPath = p;
        break;
      }
    }
    if (!configPath) {
      fail(
        `No agentdiff.config.ts found in ${process.cwd()}. ` +
          `Create one exporting { agent, agentPath | versions: { old, new }, tests, runsPerTest }.`,
      );
    }
  }

  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(configPath!).href)) as Record<string, unknown>;
  } catch (err) {
    fail(`Could not import config ${configPath}: ${errMessage(err)}`);
  }

  const raw = (mod!.default ?? mod) as unknown;
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    fail(`Invalid agentdiff.config: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  }

  return { config: parsed.data, rootDir: path.dirname(configPath!) };
}

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
