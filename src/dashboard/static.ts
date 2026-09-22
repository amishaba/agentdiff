// Serves the built web app (`npm run build:web` → dist/web) to `agentdiff view`.
import type http from "node:http";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { exists } from "../storage/fs.ts";
import { send } from "./http.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** The built dashboard (`npm run build:web`); shipped in the package. */
const WEB_DIR = path.join(ROOT, "dist/web");

const ASSET_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

/** Files Vite copies from web/public to the build's root, served by name. */
export const ROOT_FILES = new Set(["/favicon.svg", "/favicon-32.png", "/apple-touch-icon.png"]);

/**
 * The same page as the hosted demo, told to read this machine's runs from
 * /api/* instead of the baked fixture. The flag has to land before the
 * app's module script, so it goes at the top of <head>.
 */
export async function sendApp(res: http.ServerResponse): Promise<void> {
  const index = path.join(WEB_DIR, "index.html");
  if (!(await exists(index))) {
    return send(
      res,
      503,
      "text/plain; charset=utf-8",
      "The dashboard hasn't been built. From the agentdiff checkout run: npm run build:web",
    );
  }
  const html = await fs.readFile(index, "utf8");
  const flag = '<script>window.__AGENTDIFF__={mode:"live"}</script>';
  const marked = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${flag}`) : flag + html;
  send(res, 200, "text/html; charset=utf-8", marked);
}

/** Hashed build output under dist/web/assets — never anything outside it. */
export async function sendAsset(res: http.ServerResponse, pathname: string): Promise<void> {
  const name = path.posix.basename(pathname);
  if (!/^[\w.-]+$/.test(name)) return send(res, 404, "text/plain", "not found");
  return sendFile(res, path.join(WEB_DIR, "assets", name), "public, max-age=31536000, immutable");
}

/** One of ROOT_FILES. Not hashed, so they can change between builds: cache for a day. */
export async function sendRootFile(res: http.ServerResponse, pathname: string): Promise<void> {
  return sendFile(res, path.join(WEB_DIR, pathname.slice(1)), "public, max-age=86400");
}

async function sendFile(res: http.ServerResponse, file: string, cache: string): Promise<void> {
  if (!(await exists(file))) return send(res, 404, "text/plain", "not found");
  const type = ASSET_TYPES[path.extname(file)] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type, "cache-control": cache });
  res.end(await fs.readFile(file));
}
