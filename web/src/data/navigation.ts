import type { Mode } from "./types.ts";

declare global {
  interface Window {
    /** Injected by agentdiff view; absent from the static website. */
    __AGENTDIFF__?: { mode: Mode };
  }
}

// Keep navigation inside the single-file export as well as the hosted website.
const root = typeof window !== "undefined" && window.location.protocol === "file:" ? window.location.pathname : "/";
export const routes = {
  home: root,
  examples: `${root}?view=report`,
  dashboard: `${root}?view=dashboard`,
} as const;

/** One recorded example on the Examples page. */
export const exampleRoute = (name: string) => `${root}?view=report&example=${encodeURIComponent(name)}`;

export type Page = "home" | "examples" | "dashboard";

export function hasLocalDashboard(): boolean {
  return window.__AGENTDIFF__?.mode === "live";
}

/** The hosted dashboard is a browser-only sample workspace. */
export function isSampleWorkspace(): boolean {
  return !hasLocalDashboard() || new URLSearchParams(window.location.search).get("demo") === "1";
}

/** Explicit page links take priority over a saved comparison in the URL. */
export function currentPage(): Page {
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view");
  if (view === "report") return "examples";
  if (view === "dashboard" || (hasLocalDashboard() && !view && params.has("dir"))) return "dashboard";
  return "home";
}
