import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys, useDataset, useRuns } from "../data/queries.ts";
import { isSampleWorkspace } from "../data/navigation.ts";
import { failedSides } from "../../../src/compare/signals.ts";
import { dashboardTab, dashboardTabs, type DashboardTab } from "../data/dashboard.ts";
import { AppShell } from "./AppShell.tsx";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { Icon } from "./Icon.tsx";
import type { RunRef } from "../data/types.ts";
import type { DashboardJob } from "../../../src/dashboard/jobs/types.ts";
import { RunToolbar } from "./RunToolbar.tsx";
import { RunProvenance } from "./RunProvenance.tsx";
import { Braintrust } from "./Braintrust.tsx";
import { ReplayPair } from "./ReplayPair.tsx";
import { ComparisonFailure } from "./ComparisonFailure.tsx";
import { RunDrawer } from "./RunDrawer.tsx";
import { JobCard } from "./JobCard.tsx";
import { ScenariosPage } from "../scenarios/ScenariosPage.tsx";
import { CheckPage } from "../health/CheckPage.tsx";
import { Project } from "./Project.tsx";
import type { DraftFocus } from "./DiscoveryDrafts.tsx";
import { useJobs } from "../data/jobs.ts";
import { DemoBanner } from "./DemoBanner.tsx";
import { Review } from "../review/Review.tsx";

/** The workspace: saved comparisons, Braintrust incidents and project settings, one section at a time. */
export function Dashboard() {
  const sample = isSampleWorkspace();
  const jobs = useJobs();
  const [drawer, setDrawer] = useState(false);
  const [requestedDraft, setRequestedDraft] = useState<DraftFocus | undefined>(() => {
    const params = new URLSearchParams(location.search);
    return params.get("dir") && params.get("draft")
      ? { dir: params.get("dir")!, file: params.get("draft")!, serial: 0 }
      : undefined;
  });
  const [dir, setDir] = useState<string | undefined>(
    () => new URLSearchParams(location.search).get("dir") ?? undefined,
  );
  const queryClient = useQueryClient();
  const runList = useRuns();
  const runs = runList.data ?? [];
  // A link names its comparison; otherwise the newest one opens.
  const target = dir ?? runs[0]?.dir;
  const dataset = useDataset(target);
  const data = dataset.data ?? null;
  const noRuns = !dir && runList.isSuccess && !runs.length;
  const loadError = dataset.error ?? (dir ? null : runList.error);

  const [open, setOpen] = useState<RunRef | null>(null);
  const [tab, setTab] = useState(() => dashboardTab(location.search));

  const selectTab = useCallback((next: DashboardTab) => {
    setTab(next);
    const url = new URL(location.href);
    url.searchParams.set("tab", next);
    if (next !== "project") url.searchParams.delete("draft");
    history.pushState(null, "", url);
  }, []);

  useEffect(() => {
    const restore = () => {
      setTab(dashboardTab(location.search));
      setDir(new URLSearchParams(location.search).get("dir") ?? undefined);
      const params = new URLSearchParams(location.search);
      setRequestedDraft(
        params.get("dir") && params.get("draft")
          ? { dir: params.get("dir")!, file: params.get("draft")!, serial: Date.now() }
          : undefined,
      );
      setOpen(null);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);

  const pick = useCallback((next: string) => {
    setDir(next);
    setRequestedDraft(undefined);
    setOpen(null);
    const url = new URL(location.href);
    url.searchParams.set("dir", next);
    url.searchParams.delete("draft");
    // The open test belongs to the comparison being left.
    url.searchParams.delete("test");
    history.replaceState(null, "", url);
  }, []);

  const c = data?.comparison;
  const failed = c ? failedSides(c) : [];
  const onCompared = useCallback(
    (next: string) => {
      pick(next);
      selectTab("overview");
    },
    [pick, selectTab],
  );
  // A finished job's result opens on its own page: a comparison on Comparisons, a check on Check, scenarios on Scenarios.
  const [scenarioDir, setScenarioDir] = useState<string | undefined>();
  const [checkDir, setCheckDir] = useState<string | undefined>();
  const openJob = useCallback(
    (job: DashboardJob) => {
      if (!job.resultDir) return;
      if (job.kind === "scenarios") {
        setScenarioDir(job.resultDir);
        selectTab("scenarios");
      } else if (job.kind === "check") {
        setCheckDir(job.resultDir);
        selectTab("check");
      } else onCompared(job.resultDir);
    },
    [onCompared, selectTab],
  );
  // A finished job may have saved a comparison or rewritten one's explanation.
  const finished = jobs.job?.finishedAt;
  const finishedDir = jobs.job?.resultDir;
  useEffect(() => {
    if (!finished) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.runs });
    if (finishedDir) void queryClient.invalidateQueries({ queryKey: queryKeys.dataset(finishedDir) });
  }, [finished, finishedDir, queryClient]);
  const tabLabel = dashboardTabs.find(([id]) => id === tab)![1];
  return (
    <AppShell
      place={{ kind: "dashboard", tab }}
      onTab={selectTab}
      crumbs={[sample ? "Recorded run" : "Local workspace", tabLabel]}
      actions={
        <>
          {tab === "overview" && <RunToolbar runs={runs} dir={data?.dir ?? dir} onPick={pick} />}
          <button className="dashboard-button primary" onClick={() => setDrawer(true)}>
            <Icon name="plus" size={14} />
            New comparison
          </button>
        </>
      }
    >
      {sample && <DemoBanner />}
      <JobCard jobs={jobs} onOpen={openJob} />
      <>
        <div hidden={tab !== "overview"}>
          {noRuns && (
            <div className="dashboard-empty">
              <h2>No comparisons yet</h2>
              <p>
                Run your configured tests on the old and new agent with New comparison, or open Incidents to turn a
                failed Braintrust run into a test.
              </p>
              <button className="dashboard-button primary" onClick={() => setDrawer(true)}>
                New comparison
              </button>
            </div>
          )}
          {loadError && (
            <div className="dashboard-empty" role="alert">
              <h2>{dataset.error ? "Could not load this comparison" : "Could not list saved comparisons"}</h2>
              <p>{loadError.message}</p>
              <button
                className="dashboard-button"
                onClick={() => void (dataset.error ? dataset.refetch() : runList.refetch())}
              >
                Try again
              </button>
            </div>
          )}
          {!data && !loadError && !noRuns && (
            <div className="state dim" role="status">
              Loading saved comparison…
            </div>
          )}
          {failed.length > 0 && <ComparisonFailure sides={failed} />}
          {data && c && !failed.length && (
            <ErrorBoundary label="This comparison" resetKey={data.dir}>
              <Review key={data.dir} data={data} onReplay={setOpen} />
            </ErrorBoundary>
          )}
          {data && <RunProvenance data={data} />}
        </div>
        {/* Keep the inbox mounted across sections and comparisons so active replay jobs and unsaved reviews survive. */}
        <div hidden={tab !== "scenarios"}>
          <ErrorBoundary label="Scenarios">
            <ScenariosPage active={tab === "scenarios"} jobs={jobs} requestedDir={scenarioDir} />
          </ErrorBoundary>
        </div>
        <div hidden={tab !== "check"}>
          <ErrorBoundary label="Check">
            <CheckPage active={tab === "check"} jobs={jobs} requestedDir={checkDir} />
          </ErrorBoundary>
        </div>
        <div hidden={tab !== "braintrust"}>
          <ErrorBoundary label="Incidents">
            <Braintrust onCompared={onCompared} />
          </ErrorBoundary>
        </div>
        <div hidden={tab !== "project"}>
          <ErrorBoundary label="Project settings">
            <Project active={tab === "project"} jobs={jobs} requestedDraft={requestedDraft} />
          </ErrorBoundary>
        </div>
      </>
      {drawer && <RunDrawer busy={jobs.busy} onStart={jobs.start} onClose={() => setDrawer(false)} />}
      {/* A recorded incident opens old and new side by side; other runs open in their test's panel. */}
      {data && open && (
        <ErrorBoundary label="This replay" resetKey={open}>
          <ReplayPair data={data} sel={open} onClose={() => setOpen(null)} />
        </ErrorBoundary>
      )}
    </AppShell>
  );
}
