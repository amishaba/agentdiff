import { useCallback, useEffect, useMemo, useState } from "react";
import { listRuns, loadDataset } from "../data/load.ts";
import { isSampleWorkspace } from "../data/navigation.ts";
import { sortedTests } from "../data/derive.ts";
import { failedSides } from "../../../src/compare/signals.ts";
import { dashboardTab, dashboardTabs, type DashboardTab } from "../data/dashboard.ts";
import { AppShell } from "./AppShell.tsx";
import { Icon } from "./Icon.tsx";
import type { Dataset, RunRef, RunSummary } from "../data/types.ts";
import type { DashboardJob } from "../../../src/dashboard/jobs/types.ts";
import { RunToolbar } from "./RunToolbar.tsx";
import { TraceDrawer } from "./TraceDrawer.tsx";
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
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [dir, setDir] = useState<string | undefined>(
    () => new URLSearchParams(location.search).get("dir") ?? undefined,
  );
  const [data, setData] = useState<Dataset | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setData(null);
    Promise.all([listRuns().catch(() => [] as RunSummary[]), loadDataset(dir)])
      .then(([r, d]) => {
        if (cancelled) return;
        setRuns(r);
        setData(d);
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [dir]);

  const pick = useCallback((next: string) => {
    setDir(next);
    setRequestedDraft(undefined);
    setOpen(null);
    const url = new URL(location.href);
    url.searchParams.set("dir", next);
    url.searchParams.delete("draft");
    history.replaceState(null, "", url);
  }, []);

  const tests = useMemo(() => (data ? sortedTests(data.comparison) : []), [data]);
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
  useEffect(() => {
    if (!jobs.job?.finishedAt) return;
    let cancelled = false;
    listRuns()
      .then((next) => {
        if (!cancelled) setRuns(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [jobs.job?.finishedAt]);
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
          {error && (
            <div className="dashboard-empty" role="alert">
              <h2>{error.includes("no comparisons") ? "No comparisons yet" : "Could not load this comparison"}</h2>
              <p>
                {error.includes("no comparisons")
                  ? "Run your configured tests on the old and new agent with New comparison, or open Incidents to turn a failed Braintrust run into a test."
                  : error}
              </p>
              {error.includes("no comparisons") && (
                <button className="dashboard-button primary" onClick={() => setDrawer(true)}>
                  New comparison
                </button>
              )}
            </div>
          )}
          {!data && !error && (
            <div className="state dim" role="status">
              Loading saved comparison…
            </div>
          )}
          {failed.length > 0 && <ComparisonFailure sides={failed} />}
          {data && c && !failed.length && <Review key={data.dir} data={data} onOpen={setOpen} />}
          {data && <RunProvenance data={data} />}
        </div>
        {/* Keep the inbox mounted across sections and comparisons so active replay jobs and unsaved reviews survive. */}
        <div hidden={tab !== "scenarios"}>
          <ScenariosPage active={tab === "scenarios"} jobs={jobs} requestedDir={scenarioDir} />
        </div>
        <div hidden={tab !== "check"}>
          <CheckPage active={tab === "check"} jobs={jobs} requestedDir={checkDir} />
        </div>
        <div hidden={tab !== "braintrust"}>
          <Braintrust onCompared={onCompared} />
        </div>
        <div hidden={tab !== "project"}>
          <Project active={tab === "project"} jobs={jobs} requestedDraft={requestedDraft} />
        </div>
      </>
      {drawer && <RunDrawer busy={jobs.busy} onStart={jobs.start} onClose={() => setDrawer(false)} />}
      {/* A recorded incident opens old and new side by side. */}
      {data &&
        open &&
        ([...data.traces.old, ...data.traces.new].some((r) => r.test === open.test && r.replay) ? (
          <ReplayPair data={data} sel={open} onClose={() => setOpen(null)} />
        ) : (
          <TraceDrawer data={data} tests={tests} sel={open} onSelect={setOpen} onClose={() => setOpen(null)} />
        ))}
    </AppShell>
  );
}
