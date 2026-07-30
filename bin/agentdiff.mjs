#!/usr/bin/env node
// Register the tsx ESM loader so we can import the tool's own TypeScript
// sources AND the user's .ts config / agent files on Node 20+.
import { existsSync } from "node:fs";
import { register } from "tsx/esm/api";

// Load a .env from the directory you run agentdiff in, so API keys can live in
// a file instead of the command line. Uses Node's built-in loader (no dep).
if (existsSync(".env") && typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(".env");
  } catch {
    // ignore a malformed/unreadable .env — keys can still come from the shell
  }
}

register();

await import("../src/cli.ts");
