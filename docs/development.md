# Development

```bash
npm ci
npm test             # node:test, no model calls
npm run typecheck    # CLI and web
npm run lint         # ESLint, including the layer boundaries below
npm run format       # Prettier (format:check in CI)
npm run build:web    # → dist/web, served by agentdiff view and the hosted site
npm run bake-example -- <compare dir> <name> "<title>" "<what changed>"   # add a recording to the site
```

[`ci.yml`](../.github/workflows/ci.yml) runs the lint, format check, typecheck, tests and build on Node 22 and 24. The dashboard imports the CLI's own [`src/compare/signals.ts`](../src/compare/signals.ts), so the page and the report can't disagree.

The `sms-desk-example` and `booking-example` workflows record the SMS and booking examples against the real models; they are started by hand. This repo also runs the Action on `example/` for PRs labelled `run-agentdiff`.

## Layout

`src/` reads in pipeline order. Each layer imports only the ones below it, and [`eslint.config.js`](../eslint.config.js) enforces that:

| | |
|---|---|
| `cli.ts`, `commands/` | Parse flags, call the pipeline, print. |
| `pipeline/` | `runComparison` (the seven stages), `rebuildReport`, `runTests` — the API the CLI, CI and dashboard workers share. Reports through a `Reporter`; never prints. |
| `config/` `suite/` `agent/` `grade/` `compare/` `explain/` `report/` `discovery/` `github/` | One folder per step. `agent/` is the only code that knows agent frameworks (Mastra, and the adapters for the OpenAI Agents SDK and plain functions). |
| `storage/` | The `.agentdiff/` `Workspace` (beside the config) and the files inside each comparison. |
| `lib/` | Thin wrappers: model providers, git, canonical JSON, errors. |
| `dashboard/` | `agentdiff view`: server, jobs, project settings, Braintrust. |

The browser-safe modules in `compare/` and the `*/types.ts` schemas are also bundled into [`web/`](../web), so they stay free of Node APIs.

[← README](../README.md)
