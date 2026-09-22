// Generate an offline, single-file copy from the same React website. The normal
// Vercel build remains unchanged. Offline typography uses the site's system fallbacks.
import { build } from "vite";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = await build({
  root: path.join(root, "web"),
  configFile: path.join(root, "web/vite.config.ts"),
  base: "./",
  build: {
    write: false,
    copyPublicDir: false,
    cssCodeSplit: false,
    modulePreload: false,
    rolldownOptions: { output: { format: "es", codeSplitting: false } },
  },
});
const output = (Array.isArray(result) ? result[0] : result).output;
const chunks = output.filter((asset) => asset.type === "chunk");
if (
  chunks.length !== 1 ||
  chunks[0].imports.length ||
  chunks[0].dynamicImports.some((name) => name !== chunks[0].fileName) ||
  /\bimport\s*\(/.test(chunks[0].code)
)
  throw new Error("Standalone demo must have exactly one bundled script.");
const htmlAsset = output.find((asset) => asset.type === "asset" && asset.fileName === "index.html");
if (!htmlAsset) throw new Error("Missing website HTML.");
const css = output
  .filter((asset) => asset.type === "asset" && asset.fileName.endsWith(".css"))
  .map((asset) => String(asset.source))
  .join("\n");
const script = chunks[0].code.replace(/<\/script/gi, "<\\/script");
let html = String(htmlAsset.source)
  .replace(/<script\b[^>]*\bsrc=[^>]*><\/script>/gi, "")
  .replace(/<link\b[^>]*>/gi, "")
  // Functions, not strings: a replacement string reads $', $` and $& in the code and data as patterns.
  .replace("</head>", () => `<style>${css}</style>\n</head>`)
  .replace("</body>", () => `<script type="module">${script}</script>\n</body>`);
if (/<(?:script|link)\b[^>]*(?:src|href)=/i.test(html))
  throw new Error("Standalone demo still references an external dependency.");
const dest = path.join(root, "dist/agentdiff-demo.html");
await fs.mkdir(path.dirname(dest), { recursive: true });
await fs.writeFile(dest, html);
console.log(`Offline demo: ${dest}`);
