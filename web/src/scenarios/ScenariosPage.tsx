import { useCallback, useEffect, useState } from "react";
import { AREA_LABEL, type CoverageArea } from "../../../src/scenarios/types.ts";
import type { ScenarioRun, ScenarioRunSummary } from "../../../src/dashboard/scenarios/types.ts";
import type { JobControls } from "../data/jobs.ts";
import { addScenarios, listScenarioRuns, readScenarioRun } from "../data/scenarios.ts";
import { plural } from "../data/derive.ts";
import { WrappableName } from "../components/WrappableName.tsx";
import { StatTile } from "../components/StatTile.tsx";
import { ScenarioPanel } from "./ScenarioPanel.tsx";
import { AreaTag } from "./AreaTag.tsx";
import { addable, areaCounts, coverage, scenarioRows, type ScenarioRow } from "./model.ts";
import "./scenarios.css";

/**
 * The scenarios page: write scenarios from the agent's prompt and tools, see
 * what they cover, and add the ones you want to the suite.
 */
export function ScenariosPage({
  active,
  jobs,
  requestedDir,
}: {
  active: boolean;
  jobs: JobControls;
  /** A run to show, when the page is opened from a finished job. */
  requestedDir?: string;
}) {
  const [runs, setRuns] = useState<ScenarioRunSummary[] | null>(null);
  const [dir, setDir] = useState<string | undefined>(requestedDir);
  const [run, setRun] = useState<ScenarioRun | null>(null);
  const [error, setError] = useState("");
  const finishedAt = jobs.job?.kind === "scenarios" ? jobs.job.finishedAt : undefined;

  useEffect(() => {
    if (requestedDir) setDir(requestedDir);
  }, [requestedDir]);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    listScenarioRuns()
      .then((next) => {
        if (cancelled) return;
        setRuns(next);
        setDir((current) => (current && next.some((r) => r.dir === current) ? current : next[0]?.dir));
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [active, finishedAt]);
  const load = useCallback(async (target: string) => {
    try {
      setRun(await readScenarioRun(target));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    if (active && dir) void load(dir);
  }, [active, dir, load]);

  const write = () =>
    void jobs.start({ kind: "scenarios", options: { perItem: 2 } }).catch((e: Error) => setError(e.message));
  return (
    <div className="scenarios-page">
      <header className="page-head with-actions">
        <div>
          <h1>Scenarios</h1>
          <p>
            Tests written from your agent's prompt and tools alone: the conversation so far, the situation, and what
            every tool answers. Review them and add the ones that describe what your agent should do.
          </p>
        </div>
        <div className="page-actions">
          {!!runs?.length && (
            <select aria-label="Scenario run" value={dir} onChange={(e) => setDir(e.target.value)}>
              {runs.map((r) => (
                <option key={r.dir} value={r.dir}>
                  {new Date(r.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} ·{" "}
                  {plural(r.scenarios, "scenario")}
                </option>
              ))}
            </select>
          )}
          <button className="dashboard-button primary" disabled={jobs.busy} onClick={write}>
            Write scenarios
          </button>
        </div>
      </header>
      {error && (
        <p className="job-error" role="alert">
          {error}
        </p>
      )}
      {runs && !runs.length && (
        <div className="dashboard-empty">
          <h2>No scenarios yet</h2>
          <p>
            agentdiff reads the prompt and tools, plans what a test suite has to cover (the main job, every rule, tool
            failures, adversarial messages, mid-conversation replies) and writes scenarios for each. The agent doesn't
            run. It needs OPENAI_API_KEY.
          </p>
          <button className="dashboard-button primary" disabled={jobs.busy} onClick={write}>
            Write scenarios
          </button>
        </div>
      )}
      {!runs && !error && <p className="state dim">Loading scenarios…</p>}
      {run && run.dir === dir && <Run run={run} onChanged={() => void load(run.dir)} />}
    </div>
  );
}

function Run({ run, onChanged }: { run: ScenarioRun; onChanged: () => void }) {
  const rows = scenarioRows(run);
  const covered = coverage(run);
  const gaps = covered.filter((c) => !c.scenarios).length;
  const [tab, setTab] = useState<"scenarios" | "coverage">("scenarios");
  const [area, setArea] = useState<CoverageArea | "all">("all");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState("");

  const shown = rows.filter((r) => area === "all" || r.item.area === area);
  const at = shown.findIndex((r) => r.file === open);
  const current = rows.find((r) => r.file === open);
  const add = async (files: string[]) => {
    setAdding(true);
    setNotice("");
    try {
      const saved = await addScenarios(run.dir, files);
      setNotice(`Added ${plural(saved.files.length, "test")} to ${saved.testsDir}.`);
      setChecked(new Set());
      onChanged();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setAdding(false);
    }
  };
  const toggle = (file: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  const choosable = shown.filter(addable);
  const allChecked = !!choosable.length && choosable.every((r) => checked.has(r.file));

  return (
    <>
      <section className="stat-row" aria-label="Summary">
        <StatTile label="Scenarios" value={rows.length} sub={`for ${run.agentName}`} />
        <StatTile label="Things to cover" value={run.plan.length} sub="from the prompt and tools" />
        <StatTile label="Gaps" value={gaps} sub={gaps ? "no scenario kept for these" : "every item has a scenario"} />
        <StatTile
          label="Added to tests"
          value={`${rows.filter((r) => r.savedFile).length}/${rows.length}`}
          sub={`in ${run.testsDir}`}
        />
      </section>

      <div className="r-tabs" role="tablist" aria-label="Scenario sections">
        {(
          [
            ["scenarios", "Scenarios", rows.length],
            ["coverage", "Coverage", run.plan.length],
          ] as const
        ).map(([id, label, count]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {label}
            <span className="tab-count">{count}</span>
          </button>
        ))}
      </div>

      {notice && (
        <p className="sc-notice" role="status">
          {notice}
        </p>
      )}

      <div role="tabpanel" hidden={tab !== "scenarios"}>
        <div className="t-toolbar">
          <div className="segmented" role="group" aria-label="Filter by area">
            <button aria-pressed={area === "all"} onClick={() => setArea("all")}>
              All <span>{rows.length}</span>
            </button>
            {areaCounts(rows).map(([a, n]) => (
              <button key={a} aria-pressed={area === a} onClick={() => setArea(a)}>
                <i className="area-dot" data-area={a} />
                {AREA_LABEL[a]} <span>{n}</span>
              </button>
            ))}
          </div>
          <button
            className="dashboard-button primary"
            disabled={!checked.size || adding}
            onClick={() => void add([...checked])}
          >
            {adding ? "Adding…" : checked.size ? `Add ${plural(checked.size, "scenario")} to tests` : "Add to tests"}
          </button>
        </div>
        <div className="card">
          <table className="data-table rows-open sc-table">
            <thead>
              <tr>
                <th className="sc-check">
                  <input
                    type="checkbox"
                    aria-label="Select every scenario shown"
                    checked={allChecked}
                    disabled={!choosable.length}
                    onChange={() => setChecked(allChecked ? new Set() : new Set(choosable.map((r) => r.file)))}
                  />
                </th>
                <th>Scenario</th>
                <th>Area</th>
                <th>Covers</th>
                <th>Next message</th>
                <th className="num">Tools</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <ScenarioTableRow
                  key={r.file}
                  row={r}
                  checked={checked.has(r.file)}
                  selected={r.file === open}
                  onCheck={() => toggle(r.file)}
                  onOpen={() => setOpen(r.file)}
                />
              ))}
            </tbody>
          </table>
        </div>
        <p className="t-hint">Click a scenario to read its conversation, tool answers and what should happen.</p>
      </div>

      <div role="tabpanel" hidden={tab !== "coverage"}>
        <div className="stack">
          <section className="card">
            <header className="card-head">
              <h2>What the tests have to cover</h2>
              <span>planned from the prompt and tools; every rule in the prompt has a row</span>
            </header>
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Area</th>
                  <th>What to cover</th>
                  <th>Looks for</th>
                  <th className="num">Scenarios</th>
                </tr>
              </thead>
              <tbody>
                {covered.map(({ item, scenarios }) => (
                  <tr key={item.id}>
                    <td>
                      <code className="dim">{item.id}</code>
                    </td>
                    <td>
                      <AreaTag area={item.area} />
                    </td>
                    <td>
                      <b>{item.title}</b>
                    </td>
                    <td className="dim">{item.focus}</td>
                    <td className="num">{scenarios || <span className="gap-tag">Gap</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          {!!(run.dropped.length + run.failed.length) && (
            <section className="card">
              <header className="card-head">
                <h2>Not written</h2>
                <span>{plural(run.dropped.length + run.failed.length, "problem")}</span>
              </header>
              <ul className="kv-list">
                {run.failed.map((f) => (
                  <li key={f.coverageId}>
                    <b>{f.coverageId}</b> the writer failed: {f.reason}
                  </li>
                ))}
                {run.dropped.map((d, i) => (
                  <li key={i}>
                    <b>{d.coverageId}</b> “{d.name}” dropped: {d.reason}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>

      {current && (
        <ScenarioPanel
          row={current}
          testsDir={run.testsDir}
          position={at >= 0 ? `${at + 1} of ${shown.length}` : ""}
          onPrev={at > 0 ? () => setOpen(shown[at - 1].file) : undefined}
          onNext={at >= 0 && at < shown.length - 1 ? () => setOpen(shown[at + 1].file) : undefined}
          onClose={() => setOpen(null)}
          onAdd={addable(current) && !adding ? () => void add([current.file]) : undefined}
        />
      )}
    </>
  );
}

function ScenarioTableRow({
  row: r,
  checked,
  selected,
  onCheck,
  onOpen,
}: {
  row: ScenarioRow;
  checked: boolean;
  selected: boolean;
  onCheck: () => void;
  onOpen: () => void;
}) {
  const tools = Object.keys(r.test.tool_responses ?? {}).length;
  return (
    <tr className={selected ? "selected" : undefined} onClick={onOpen}>
      <td className="sc-check" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          aria-label={`Select ${r.test.name}`}
          checked={checked}
          disabled={!addable(r)}
          onChange={onCheck}
        />
      </td>
      <td>
        <button className="row-link" aria-haspopup="dialog">
          <b>
            <WrappableName name={r.test.name} />
          </b>
        </button>
      </td>
      <td>
        <AreaTag area={r.item.area} />
      </td>
      <td className="sc-covers" title={r.item.title}>
        {r.item.title}
      </td>
      <td className="sc-message" title={r.test.input}>
        {r.test.conversation?.length ? <span className="dim">{r.test.conversation.length} earlier · </span> : null}
        {r.test.input}
      </td>
      <td className="num">{tools || "–"}</td>
      <td>
        {r.savedFile ? (
          <span className="status-pill complete">in tests</span>
        ) : r.issue ? (
          <span className="status-pill issue" title={r.issue}>
            invalid
          </span>
        ) : (
          <span className="dim">draft</span>
        )}
      </td>
    </tr>
  );
}
