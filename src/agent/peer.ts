import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Import a package the way the agent's own project imports it: resolved from
 * the agent file's folder, through the package's ESM entry. The agent and
 * agentdiff then share one module instance, which matters for packages that
 * check classes with instanceof. Returns null when the package isn't installed.
 */
export async function importFromProject(
  fromFile: string,
  pkg: string,
  subpath = ".",
): Promise<Record<string, any> | null> {
  for (let dir = path.dirname(fromFile); ; dir = path.dirname(dir)) {
    const pkgDir = path.join(dir, "node_modules", ...pkg.split("/"));
    const pkgFile = path.join(pkgDir, "package.json");
    if (existsSync(pkgFile)) {
      const manifest = JSON.parse(readFileSync(pkgFile, "utf8"));
      const entry = manifest.exports?.[subpath] ?? (subpath === "." ? manifest.exports : undefined);
      const file = esmPath(entry) ?? (subpath === "." ? (manifest.module ?? manifest.main) : undefined);
      if (typeof file !== "string") return null;
      return import(pathToFileURL(path.join(pkgDir, file)).href);
    }
    if (path.dirname(dir) === dir) return null;
  }
}

function esmPath(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return undefined;
  const e = entry as Record<string, unknown>;
  return esmPath(e.import) ?? esmPath(e.default) ?? esmPath(e.node);
}
