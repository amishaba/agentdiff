import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("original navigation, report traces, run selection and saved links remain available", () => {
  // Use the web project's JSX settings to render its real components in Node.
  execFileSync(process.execPath, ["--import", "tsx", "test/fixtures/web-regressions.mjs"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, TSX_TSCONFIG_PATH: "web/tsconfig.json" },
    stdio: "pipe",
  });
});
