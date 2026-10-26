import type { MouseEvent, ReactNode } from "react";
import { EXAMPLES } from "../data/examples.ts";
import { exampleRoute, isSampleWorkspace, routes } from "../data/navigation.ts";
import { dashboardTabs, type DashboardTab } from "../data/dashboard.ts";
import { Icon, type IconName } from "./Icon.tsx";
import "./shell.css";

export const GITHUB = "https://github.com/amishaba/agentdiff";
// Shown only once it leads somewhere: the package isn't published yet. Set it to its URL when it is.
export const NPM: string | null = null;

/** Where the app is: the overview, a workspace section, or one recorded example. */
export type Place = { kind: "home" } | { kind: "dashboard"; tab: DashboardTab } | { kind: "example"; name: string };

const TAB_ICON: Record<DashboardTab, IconName> = {
  overview: "compare",
  scenarios: "scenarios",
  check: "check",
  braintrust: "incident",
  project: "settings",
};

/** Sidebar, header and content area shared by the workspace and the recorded examples. */
export function AppShell({
  place,
  onTab,
  crumbs,
  actions,
  children,
}: {
  place: Place;
  /** Switches workspace sections in place; without it the links load the page. */
  onTab?: (tab: DashboardTab) => void;
  crumbs: ReactNode[];
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="app">
      <Sidebar place={place} onTab={onTab} />
      <div className="app-main">
        <header className="app-header">
          <nav className="crumbs" aria-label="Breadcrumb">
            {crumbs.map((crumb, i) => (
              <span key={i} className="crumb" aria-current={i === crumbs.length - 1 ? "page" : undefined}>
                {i > 0 && <Icon name="slash" size={14} />}
                {crumb}
              </span>
            ))}
          </nav>
          <div className="app-header-actions">
            {actions}
            <a
              className="header-github"
              href={GITHUB}
              target="_blank"
              rel="noreferrer"
              aria-label="agentdiff on GitHub"
            >
              <Icon name="github" />
              <span>GitHub</span>
            </a>
          </div>
        </header>
        <main className="app-content">{children}</main>
      </div>
    </div>
  );
}

function Sidebar({ place, onTab }: { place: Place; onTab?: (tab: DashboardTab) => void }) {
  const sample = isSampleWorkspace();
  const demo = new URLSearchParams(window.location.search).get("demo") === "1" ? "&demo=1" : "";
  const plainClick = (event: MouseEvent) =>
    event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
  return (
    <aside className="sidebar">
      <a className="sidebar-brand" href={routes.home} aria-label="agentdiff home">
        <span className="site-mark" aria-hidden="true">
          <i />
          <i />
        </span>
        agentdiff
      </a>
      <nav className="app-nav" aria-label="Main navigation">
        <div className="nav-section">
          <a href={routes.home} aria-current={place.kind === "home" ? "page" : undefined}>
            <Icon name="home" />
            <span>Overview</span>
          </a>
        </div>
        <div className="nav-section">
          <span className="nav-heading">{sample ? "Recorded run" : "Local workspace"}</span>
          {dashboardTabs.map(([id, label]) => (
            <a
              key={id}
              href={`${routes.dashboard}&tab=${id}${demo}`}
              aria-current={place.kind === "dashboard" && place.tab === id ? "page" : undefined}
              onClick={(event) => {
                if (!onTab || !plainClick(event)) return;
                event.preventDefault();
                onTab(id);
              }}
            >
              <Icon name={TAB_ICON[id]} />
              <span>{label}</span>
            </a>
          ))}
        </div>
        <div className="nav-section">
          <span className="nav-heading">Recorded examples</span>
          {EXAMPLES.map((e) => (
            <a
              key={e.name}
              href={exampleRoute(e.name)}
              aria-current={place.kind === "example" && place.name === e.name ? "page" : undefined}
              title={e.change}
            >
              <Icon name="file" />
              <span>{e.title}</span>
              <span className="nav-count" aria-label={`${e.changed} of ${e.tests} tests changed`}>
                {e.changed}/{e.tests}
              </span>
            </a>
          ))}
        </div>
      </nav>
      <div className="sidebar-foot">
        <a href={GITHUB} target="_blank" rel="noreferrer">
          <Icon name="github" />
          <span>GitHub</span>
        </a>
        {NPM && (
          <a href={NPM} target="_blank" rel="noreferrer">
            <Icon name="file" />
            <span>npm</span>
          </a>
        )}
        <span className="sidebar-meta">open source · MIT · made by amisha</span>
      </div>
    </aside>
  );
}
