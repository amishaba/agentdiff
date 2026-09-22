// npm runs this after `npm install` in this repo, and when agentdiff is installed
// from GitHub. It builds the dashboard (dist/web), unless the build tools weren't
// installed, as with the GitHub Action's `npm ci --omit=dev`, which doesn't need it.
import { execSync } from "node:child_process";
import { createRequire } from "node:module";

try {
  createRequire(import.meta.url).resolve("vite");
} catch {
  process.exit(0);
}
execSync("npm run build:web", { stdio: "inherit" });
