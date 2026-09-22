// Lint rules plus the architecture's import boundaries (README → Development → Layout):
//
//   cli.ts → commands/ → pipeline/ → pipeline steps (config, suite, agent, grade,
//   compare, explain, report, discovery, github) → storage/, lib/
//   dashboard/ → pipeline/ and the steps; never commands/
//
// Lower layers never import higher ones. Modules the browser bundle uses
// stay free of Node APIs. Type-only imports are exempt: they are erased.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

const restrict = (...patterns) => ({
  "@typescript-eslint/no-restricted-imports": [
    "error",
    { patterns: patterns.map((p) => ({ ...p, allowTypeImports: true })) },
  ],
});

const higherLayers = {
  dashboard: { group: ["**/dashboard/**"], message: "Pipeline steps must not depend on the dashboard." },
  commands: { group: ["**/commands/**"], message: "Only cli.ts calls commands/. Call pipeline/ instead." },
  pipeline: {
    group: ["**/pipeline/**"],
    message: "Pipeline steps must not depend on the pipeline that orchestrates them.",
  },
};

const nodeOnly = {
  group: [
    "node:*",
    "chalk",
    "ai",
    "@ai-sdk/*",
    "**/storage/**",
    "**/lib/llm.ts",
    "**/lib/git.ts",
    "**/agent/**",
    "**/grade/**",
  ],
  message: "This module is bundled into the web app; keep it free of Node and server-only code.",
};

/** Exactly the src/ modules web/ imports by value. compare/confirm.ts is not one: it judges with the AI SDK. */
const BROWSER_SAFE = [
  "src/compare/{signals,format,check-rows,change-kind,steps,stats,pricing,snapshot-diff}.ts",
  "src/types.ts",
  "src/lib/canonical.ts",
  "src/discovery/types.ts",
  "src/scenarios/types.ts",
  "src/health/{types,describe}.ts",
  "src/dashboard/*/types.ts",
  "src/pipeline/progress.ts",
];

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "**/node_modules/**",
      "example/**",
      "example-*/**",
      ".agentdiff/**",
      "web/public/**",
      "private/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      // `_name` marks an intentional discard; rest siblings strip fields.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { varsIgnorePattern: "^_", argsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  {
    // Agents are peer dependencies whose surfaces differ across frameworks and
    // versions, so agent/ duck-types them (see AnyAgent). Tests build fakes.
    files: ["src/agent/**", "test/**"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    files: [
      "src/{config,suite,agent,grade,compare,explain,report,discovery,scenarios,health,github,storage,lib}/**",
      "src/types.ts",
    ],
    rules: restrict(higherLayers.dashboard, higherLayers.commands, higherLayers.pipeline),
  },
  {
    files: ["src/pipeline/**"],
    rules: restrict(higherLayers.dashboard, higherLayers.commands),
  },
  {
    files: ["src/dashboard/**"],
    rules: restrict(higherLayers.commands),
  },
  {
    files: BROWSER_SAFE,
    rules: restrict(nodeOnly, higherLayers.dashboard, higherLayers.commands, higherLayers.pipeline),
  },
  {
    // Renders web components under Node with a stubbed `window`.
    files: ["test/fixtures/web-regressions.mjs"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["web/**"],
    languageOptions: { globals: globals.browser },
    rules: restrict({
      regex:
        "^(\\.\\./)+src/(?!compare/(signals|format|check-rows|change-kind|steps|stats|pricing|snapshot-diff)\\.ts$|types\\.ts$|lib/canonical\\.ts$|(discovery|scenarios)/types\\.ts$|health/(types|describe)\\.ts$|dashboard/[a-z]+/types\\.ts$|pipeline/progress\\.ts$)",
      message:
        "The web app may only import browser-safe CLI modules (see BROWSER_SAFE in eslint.config.js). Use `import type` for anything else.",
    }),
  },
);
