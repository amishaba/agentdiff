import { useEffect, useState } from "react";
import { HEALTH_LABEL, HEALTH_STATUSES, type HealthStatus, type TestHealth } from "../../../src/health/types.ts";
import { byStatus, healthDetail } from "../../../src/health/describe.ts";
import type { CheckRun, CheckRunSummary } from "../../../src/dashboard/check/types.ts";
import type { JobControls } from "../data/jobs.ts";
import { listChecks, readCheck } from "../data/check.ts";
import { plural } from "../data/derive.ts";
import { WrappableName } from "../components/WrappableName.tsx";
import { StatTile } from "../components/StatTile.tsx";
import { CheckPanel } from "./CheckPanel.tsx";
import { Verdict } from "./Verdict.tsx";
import "./check.css";

/**
 * The check page: how the agent as it is behaves on every test, run several
 * times, with a verdict per test and every run's tool calls one click away.
 */
export function CheckPage({
  active,
  jobs,
  requestedDir,
}: {
  active: boolean;
  jobs: JobControls;
  /** A check to show, when the page is opened from a finished job. */
  requestedDir?: string;
}) {
  const [checks, setChecks] = useState<CheckRunSummary[] | null>(null);
  const [dir, setDir] = useState<string | undefined>(requestedDir);
  const [run, setRun] = useState<CheckRun | null>(null);
  const [error, setError] = useState("");
  const finishedAt = jobs.job?.kind === "check" ? jobs.job.finishedAt : undefined;

  useEffect(() => {
    if (requestedDir) setDir(requestedDir);
  }, [requestedDir]);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    listChecks()
      .then((next) => {
        if (cancelled) return;
        setChecks(next);
        setDir((current) => (current && next.some((c) => c.dir === current) ? current : next[0]?.dir));
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [active, finishedAt]);
  useEffect(() => {
    if (!active || !dir) return;
    let cancelled = false;
    readCheck(dir)
      .then((next) => {
        if (cancelled) return;
        setRun(next);
        setError("");
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [active, dir]);

  const start = () => void jobs.start({ kind: "check", options: {} }).catch((e: Error) => setError(e.message));
  return (
    <div className="check-page">
      <header className="page-head with-actions">
        <div>
          <h1>Check</h1>
          <p>
            How your agent as it is behaves on every test, run several times, with nothing to compare it to. A test is
            unpredictable when its runs disagree with each other.
          </p>
        </div>
        <div className="page-actions">
          {!!checks?.length && (
            <select aria-label="Saved check" value={dir} onChange={(e) => setDir(e.target.value)}>
              {checks.map((c) => (
                <option key={c.dir} value={c.dir}>
                  {new Date(c.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} ·{" "}
                  {c.steady}/{c.tests} steady
                </option>
              ))}
            </select>
          )}
          <button className="dashboard-button primary" disabled={jobs.busy} onClick={start}>
            Run check
          </button>
        </div>
      </header>
      {error && (
        <p className="job-error" role="alert">
          {error}
        </p>
      )}
      {checks && !checks.length && (
        <div className="dashboard-empty">
          <h2>No checks yet</h2>
          <p>
            Runs your agent as it is on every test in your suite, several times each, grades the runs, and says which
            tests are steady, unpredictable, scoring low or breaking a rule. Write tests first on the Scenarios page if
            you have none.
          </p>
          <button className="dashboard-button primary" disabled={jobs.busy} onClick={start}>
            Run check
          </button>
        </div>
      )}
      {!checks && !error && <p className="state dim">Loading checks…</p>}
      {run && run.dir === dir && <Results run={run} />}
    </div>
  );
}

function Results({ run }: { run: CheckRun }) {
  const tests = byStatus(run.tests);
  const [filter, setFilter] = useState<HealthStatus | "all">("all");
  const [open, setOpen] = useState<string | null>(null);
  const count = (s: HealthStatus) => run.tests.filter((t) => t.status === s).length;
  const shown = tests.filter((t) => filter === "all" || t.status === filter);
  const at = shown.findIndex((t) => t.test === open);
  const current = run.tests.find((t) => t.test === open);
  return (
    <>
      <section className="stat-row" aria-label="Summary">
        <StatTile
          label="Steady"
          value={`${count("steady")}/${run.tests.length}`}
          sub={`${run.runsPerTest} runs per test · ${run.agentName}`}
        />
        <StatTile
          label="Break a test rule"
          value={count("rule")}
          sub="a required tool skipped or a forbidden one called"
        />
        <StatTile
          label="Score low"
          value={count("low")}
          sub={run.graded ? "average under 3 of 5" : run.trial ? "not graded (trial)" : "not graded (offline)"}
        />
        <StatTile
          label="Unpredictable"
          value={count("unsteady")}
          sub={count("error") ? `${plural(count("error"), "test")} with errors` : "runs disagree"}
        />
      </section>

      <div className="t-toolbar">
        <div className="segmented" role="group" aria-label="Filter by verdict">
          <button aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
            All <span>{run.tests.length}</span>
          </button>
          {HEALTH_STATUSES.filter(count).map((s) => (
            <button key={s} aria-pressed={filter === s} onClick={() => setFilter(s)}>
              {HEALTH_LABEL[s]} <span>{count(s)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="card">
        <table className="data-table rows-open check-table">
          <thead>
            <tr>
              <th>Test</th>
              <th>Verdict</th>
              <th>Rules</th>
              <th className="num">Score</th>
              <th>Usual path</th>
              <th>What happened</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((t) => (
              <tr key={t.test} className={t.test === open ? "selected" : undefined} onClick={() => setOpen(t.test)}>
                <td>
                  <button className="row-link" aria-haspopup="dialog">
                    <b>
                      <WrappableName name={t.test} />
                    </b>
                  </button>
                </td>
                <td>
                  <Verdict status={t.status} />
                </td>
                <td className="dim">{rulesLine(t)}</td>
                <td className="num">{t.score == null ? "–" : t.score.toFixed(1)}</td>
                <td className="dim check-path">
                  {t.usualPath ? `${t.usualPath.runs}/${t.usualPath.of} runs · ${plural(t.paths, "path")}` : "–"}
                </td>
                <td className="check-detail">{healthDetail(t) || <span className="dim">nothing went wrong</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="t-hint">
        Click a test to see each run: the tools it called with what it passed in, and what it said.
      </p>
      {current && (
        <CheckPanel
          test={current}
          runs={run.runs[current.test] ?? []}
          position={at >= 0 ? `${at + 1} of ${shown.length}` : ""}
          onPrev={at > 0 ? () => setOpen(shown[at - 1].test) : undefined}
          onNext={at >= 0 && at < shown.length - 1 ? () => setOpen(shown[at + 1].test) : undefined}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

/** "2 rules kept", or the first rule broken. */
function rulesLine(t: TestHealth): string {
  if (!t.rules.length) return "–";
  const broken = t.rules.find((r) => r.kept < r.of);
  if (!broken) return `${plural(t.rules.length, "rule")} kept`;
  return `${broken.kind === "required" ? "skipped" : "called"} ${broken.tool} ${broken.of - broken.kept}/${broken.of}`;
}
