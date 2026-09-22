/** The dashboard's pages; older tab links (prompt, paths, report, …) open Comparisons. */
export const dashboardTabs = [
  ["overview", "Comparisons"],
  ["scenarios", "Scenarios"],
  ["check", "Check"],
  ["braintrust", "Incidents"],
  ["project", "Project"],
] as const;
export type DashboardTab = (typeof dashboardTabs)[number][0];
export function dashboardTab(search: string): DashboardTab {
  const value = new URLSearchParams(search).get("tab");
  return dashboardTabs.find(([id]) => id === value)?.[0] ?? "overview";
}
