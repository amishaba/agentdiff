import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import type { Dataset, RunRecord, RunRef, TestComparison, Version } from "../data/types.ts";
import type { GradeChange } from "../../../src/compare/signals.ts";
import { CHANGE_KINDS, type ChangeKind } from "../../../src/compare/change-kind.ts";
import { KIND_LABEL, runStatus } from "./model.ts";
import { stepsOf } from "../../../src/compare/steps.ts";
import { pathDiff, usualPath, type TableRow } from "./groups.ts";
import { fmtMoney, fmtMs } from "../data/derive.ts";
import { WrappableName } from "../components/WrappableName.tsx";
import { DiffLines } from "./DiffLines.tsx";
import { RunStrip } from "./RunStrip.tsx";
import { Icon } from "../components/Icon.tsx";
import { SidePanel } from "../components/SidePanel.tsx";
import { TraceBody } from "../components/TraceBody.tsx";
import { useSearchParam } from "../data/url-state.ts";

export type Filter = "all" | "changed" | ChangeKind;

type SortKey = "test" | "status" | "score" | "latency";
type Sort = { key: SortKey; desc: boolean };

const SORT_VALUE: Record<SortKey, (r: TableRow) => string | number | null> = {
  test: (r) => r.test.test,
  status: (r) => CHANGE_KINDS.indexOf(r.kind),
  score: (r) => r.grade?.delta ?? null,
  latency: (r) =>
    r.test.old.avgLatencyMs != null && r.test.new.avgLatencyMs != null
      ? r.test.new.avgLatencyMs - r.test.old.avgLatencyMs
      : null,
};

/** "-score" is score, largest first; anything else is the table's own order. */
function parseSort(value: string | null): Sort | null {
  const key = value?.replace(/^-/, "");
  return key && key in SORT_VALUE ? { key: key as SortKey, desc: value!.startsWith("-") } : null;
}

/** Rows ordered by one column; rows without a value (no grades, no timings) go last either way. */
function sortRows(rows: TableRow[], sort: Sort | null): TableRow[] {
  if (!sort) return rows;
  const value = SORT_VALUE[sort.key];
  return [...rows].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
    const order = typeof x === "string" ? x.localeCompare(String(y)) : x - Number(y);
    return sort.desc ? -order : order;
  });
}

/** Every test in one flat table, most serious first; clicking one opens it in a side panel. */
export function TestsTable({
  data,
  rows,
  counts,
  changed,
  filter,
  setFilter,
  onReplay,
}: {
  data: Dataset;
  rows: TableRow[];
  counts: Record<ChangeKind, number>;
  changed: number;
  filter: Filter;
  setFilter: (f: Filter) => void;
  onReplay?: (ref: RunRef) => void;
}) {
  const c = data.comparison;
  const [queryParam, setQuery] = useSearchParam("q");
  const query = queryParam ?? "";
  const [selected, setSelected] = useSearchParam("test");
  const [sortParam, setSortParam] = useSearchParam("sort");
  const sort = parseSort(sortParam);
  const search = useRef<HTMLInputElement>(null);
  const q = query.trim().toLowerCase();
  const keep = (r: TableRow) =>
    (filter === "all" || (filter === "changed" ? r.kind !== "same" && r.kind !== "inconclusive" : r.kind === filter)) &&
    (!q || r.test.test.toLowerCase().includes(q) || !!r.test.input?.toLowerCase().includes(q));
  const shown = sortRows(rows.filter(keep), sort);
  // Each row's runs, grouped once rather than filtered out of every trace per row per render.
  const runsByTest = useMemo(() => {
    const by = new Map<string, { old: RunRecord[]; new: RunRecord[] }>();
    for (const v of ["old", "new"] as const)
      for (const r of data.traces[v]) {
        const entry = by.get(r.test) ?? { old: [], new: [] };
        entry[v].push(r);
        by.set(r.test, entry);
      }
    return by;
  }, [data.traces]);
  // Ascending, then descending, then back to the table's own order (most serious first).
  const sortBy = (key: SortKey) => setSortParam(sort?.key !== key ? key : sort.desc ? null : `-${key}`);
  const ariaSort = (key: SortKey) => (sort?.key === key ? (sort.desc ? "descending" : "ascending") : undefined);
  const header = (key: SortKey, label: string, className?: string) => (
    <th className={className} aria-sort={ariaSort(key)}>
      <button className="th-sort" onClick={() => sortBy(key)} title={`Sort by ${label.toLowerCase()}`}>
        {label}
        <span aria-hidden="true">{sort?.key === key ? (sort.desc ? "↓" : "↑") : ""}</span>
      </button>
    </th>
  );
  // "/" jumps to the search box, as in GitHub and Linear.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && e.target.closest("input, textarea, select, [contenteditable]");
      if (e.key !== "/" || typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!search.current || search.current.closest("[hidden]")) return;
      e.preventDefault();
      search.current.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // ↑ ↓ (or j k) move between rows; Enter opens one.
  const moveFocus = (e: KeyboardEvent<HTMLTableSectionElement>) => {
    const by = e.key === "ArrowDown" || e.key === "j" ? 1 : e.key === "ArrowUp" || e.key === "k" ? -1 : 0;
    const links = [...e.currentTarget.querySelectorAll<HTMLElement>(".row-link")];
    const at = links.indexOf(document.activeElement as HTMLElement);
    if (!by || at < 0) return;
    e.preventDefault();
    links[Math.min(Math.max(at + by, 0), links.length - 1)].focus();
  };
  const current = rows.find((x) => x.test.test === selected);
  const at = shown.findIndex((x) => x.test.test === selected);
  const step = (by: number) => {
    const next = shown[at + by];
    if (next) setSelected(next.test.test);
  };
  const filters: [Filter, string, number][] = [
    ["all", "All", c.tests.length],
    ["changed", "Changed", changed],
    ...CHANGE_KINDS.filter((k) => counts[k]).map((k): [Filter, string, number] => [k, KIND_LABEL[k], counts[k]]),
  ];
  return (
    <>
      <div className="t-toolbar">
        <div className="segmented" role="group" aria-label="Filter tests">
          {filters.map(([id, label, count]) => (
            <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>
              {id !== "all" && id !== "changed" && <i className="kind-dot" data-kind={id} />}
              {label}
              <span>{count}</span>
            </button>
          ))}
        </div>
        <label className="search">
          <Icon name="search" size={14} />
          <input
            ref={search}
            type="search"
            placeholder="Search tests  /"
            value={query}
            onChange={(e) => setQuery(e.target.value || null)}
            aria-label="Search tests"
          />
        </label>
      </div>
      <div className="card">
        <table className="data-table rows-open tests-table">
          <thead>
            <tr>
              {header("test", "Test")}
              {header("status", "Status")}
              <th>What changed</th>
              <th className="num">Old → new</th>
              {header("score", "Score", "num")}
              {header("latency", "Latency", "num")}
              <th aria-hidden="true" />
            </tr>
          </thead>
          <tbody onKeyDown={moveFocus}>
            {shown.map((x) => (
              <TestRow
                key={x.test.test}
                runs={runsByTest.get(x.test.test) ?? { old: [], new: [] }}
                row={x}
                selected={x.test.test === selected}
                onSelect={() => setSelected(x.test.test)}
              />
            ))}
          </tbody>
        </table>
        {!shown.length && (
          <div className="tt-empty">
            <p>
              No tests match {q ? `“${query.trim()}”` : "this filter"}
              {q && filter !== "all" ? ` in ${filters.find(([id]) => id === filter)?.[1]}` : ""}.
            </p>
            <button
              className="dashboard-button"
              onClick={() => {
                setQuery(null);
                setFilter("all");
              }}
            >
              Show all {c.tests.length} tests
            </button>
          </div>
        )}
      </div>
      <p className="t-hint">Click a test to see its tool path, replies and runs. ↑ ↓ move between tests; / searches.</p>
      {current && (
        <TestPanel
          data={data}
          row={current}
          position={at >= 0 ? `${at + 1} of ${shown.length}` : ""}
          onPrev={at > 0 ? () => step(-1) : undefined}
          onNext={at >= 0 && at < shown.length - 1 ? () => step(1) : undefined}
          onClose={() => setSelected(null)}
          onReplay={onReplay}
        />
      )}
    </>
  );
}

/** "↘ 4.0": how far the score moved; coloured only beyond the noise. */
function Delta({ grade }: { grade: GradeChange }) {
  if (Math.abs(grade.delta) < 0.05) return null;
  return (
    <span className={`delta${grade.meaningful ? (grade.delta < 0 ? " down" : " up") : ""}`}>
      {grade.delta < 0 ? "↘" : "↗"} {Math.abs(grade.delta).toFixed(1)}
    </span>
  );
}

function Score({ grade }: { grade: GradeChange | null }) {
  if (!grade) return <>–</>;
  return (
    <>
      {grade.old.toFixed(1)} → {grade.new.toFixed(1)} <Delta grade={grade} />
    </>
  );
}

function TestRow({
  runs: byVersion,
  row: x,
  selected,
  onSelect,
}: {
  runs: { old: RunRecord[]; new: RunRecord[] };
  row: TableRow;
  selected: boolean;
  onSelect: () => void;
}) {
  const runs = (v: Version) => byVersion[v];
  return (
    <tr className={selected ? "selected" : undefined} onClick={onSelect}>
      <td>
        <button className="row-link" aria-haspopup="dialog">
          <b>
            <WrappableName name={x.test.test} />
          </b>
        </button>
      </td>
      <td>
        <span className="badge" data-kind={x.kind}>
          {KIND_LABEL[x.kind]}
        </span>
      </td>
      <td className="cell-change" title={x.shift?.metric || undefined}>
        {x.shift?.title ?? "–"}
      </td>
      <td className="num">
        {x.shift?.hit ? (
          <RunStrip shift={x.shift} kind={x.kind} old={runs("old")} neu={runs("new")} />
        ) : x.shift?.old ? (
          `${x.shift.old} → ${x.shift.new}`
        ) : (
          "–"
        )}
      </td>
      <td className="num">
        <Score grade={x.grade} />
      </td>
      <td className="num">
        {fmtMs(x.test.old.avgLatencyMs)} → {fmtMs(x.test.new.avgLatencyMs)}
      </td>
      <td className="chev">
        <Icon name="chevron" size={14} />
      </td>
    </tr>
  );
}

/**
 * One test in a side panel: what changed, the two usual paths as one diff, the replies, and every run.
 * A run opens its trace in the same panel, with a way back to the test; a recorded incident goes to `onReplay`.
 */
export function TestPanel({
  data,
  row: x,
  position,
  onPrev,
  onNext,
  onClose,
  onReplay,
}: {
  data: Dataset;
  row: TableRow;
  position: string;
  onPrev?: () => void;
  onNext?: () => void;
  onClose: () => void;
  onReplay?: (ref: RunRef) => void;
}) {
  const t = x.test;
  const runs = (v: Version) => data.traces[v].filter((r) => r.test === t.test).sort((a, b) => a.run - b.run);
  const sides = [
    { who: "old agent", runs: runs("old") },
    { who: "new agent", runs: runs("new") },
  ].map((s) => ({ ...s, path: usualPath(s.runs) }));
  const [o, n] = [sides[0].path, sides[1].path];
  const lines = pathDiff(o?.steps ?? [], n?.steps ?? []);
  const tripped = x.tripped.filter((r) => r.side === "old");
  const related = x.related;
  const reply = (path: typeof o) => {
    const text = path?.run.final_response?.trim();
    return text ? (text.length > 600 ? text.slice(0, 600) + "…" : text) : null;
  };
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  const [trace, setTrace] = useState<RunRef | null>(null);
  // A trace belongs to the test it was opened from: moving to another test shows that test.
  const order = [...sides[0].runs, ...sides[1].runs];
  const at = trace?.test === t.test ? order.findIndex((r) => r.version === trace.version && r.run === trace.run) : -1;
  const traced = at >= 0 ? order[at] : null;
  const result =
    traced &&
    runResult(
      data,
      t,
      traced,
      o,
      data.grades.find((g) => g.test === t.test && g.version === traced.version && g.run === traced.run)?.score,
    );
  const scrolled = useRef(0);
  const body = () => document.querySelector<HTMLElement>(".side-panel .panel-body");
  const openRun = (ref: RunRef) => {
    if (onReplay && order.some((r) => r.replay)) return onReplay(ref);
    if (!traced) scrolled.current = body()?.scrollTop ?? 0;
    flushSync(() => setTrace(ref));
    body()?.scrollTo({ top: 0 });
    document.querySelector<HTMLElement>(".side-panel .run-view")?.focus({ preventScroll: true });
  };
  const backToTest = () => {
    flushSync(() => setTrace(null));
    body()?.scrollTo({ top: scrolled.current });
    document.querySelector<HTMLElement>(".side-panel")?.focus({ preventScroll: true });
  };
  const step = (by: number) => {
    const r = order[at + by];
    if (r) openRun({ test: r.test, version: r.version, run: r.run });
  };

  return (
    <SidePanel
      id={t.test}
      badge={
        <span className="badge" data-kind={x.kind}>
          {KIND_LABEL[x.kind]}
        </span>
      }
      title={t.test}
      subtitle={x.shift?.title}
      position={position}
      noun="test"
      onPrev={onPrev}
      onNext={onNext}
      onClose={onClose}
    >
      {traced ? (
        <section
          className="run-view"
          tabIndex={-1}
          aria-label={`${traced.version} agent, run ${traced.run}`}
          onKeyDown={(e) => {
            if (e.key === "Escape") backToTest();
            else if (e.key === "ArrowLeft") step(-1);
            else if (e.key === "ArrowRight") step(1);
            else return;
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <div className="run-view-bar">
            <button className="run-back" onClick={backToTest} title="Back to the test (Esc)">
              ← Back to test
            </button>
            <span className="run-view-where">
              {cap(traced.version)} agent · run {traced.run} of{" "}
              {traced.version === "old" ? sides[0].runs.length : sides[1].runs.length}
            </span>
            {result && (
              <span className="badge" data-kind={result.tone}>
                {result.label}
              </span>
            )}
            <div className="panel-nav">
              <button onClick={() => step(-1)} disabled={at <= 0} aria-label="Previous run" title="Previous run (←)">
                ←
              </button>
              <button
                onClick={() => step(1)}
                disabled={at >= order.length - 1}
                aria-label="Next run"
                title="Next run (→)"
              >
                →
              </button>
            </div>
          </div>
          <TraceBody data={data} test={t} run={traced} />
        </section>
      ) : (
        <>
          {t.input && (
            <section>
              <h3>Input</h3>
              <p className="panel-input">{t.input}</p>
            </section>
          )}
          <dl className="panel-stats">
            {x.shift?.old && (
              <div>
                <dt>{x.shift.metric}</dt>
                <dd>
                  {x.shift.old} → {x.shift.new}
                </dd>
              </div>
            )}
            <div>
              <dt>score</dt>
              <dd>
                <Score grade={x.grade} />
              </dd>
            </div>
            <div>
              <dt>latency</dt>
              <dd>
                {fmtMs(t.old.avgLatencyMs)} → {fmtMs(t.new.avgLatencyMs)}
              </dd>
            </div>
            <div>
              <dt>cost per run</dt>
              <dd>
                {fmtMoney(t.old.avgCost)} → {fmtMoney(t.new.avgCost)}
              </dd>
            </div>
          </dl>
          {!!tripped.length && (
            <p className="panel-note">
              Old runs stopped by{" "}
              {tripped.map((r, i) => (
                <span key={r.id}>
                  {i ? ", " : ""}
                  <code>{r.id}</code> in {r.runs}/{r.of}
                </span>
              ))}
              , a guardrail the new agent doesn't have.
            </p>
          )}
          {x.shift?.hit && (
            <section>
              <div className="panel-sec-head">
                <h3>Run by run</h3>
                <span>{x.shift.metric} · click a run to open its trace</span>
              </div>
              <RunStrip shift={x.shift} kind={x.kind} old={sides[0].runs} neu={sides[1].runs} onOpen={openRun} />
            </section>
          )}
          <section>
            <div className="panel-sec-head">
              <h3>Tool path</h3>
              <span>
                usual path · old {o ? `${o.runs}/${o.of}` : "–"} runs · new {n ? `${n.runs}/${n.of}` : "–"} runs
              </span>
            </div>
            {!o || !n ? (
              <p className="panel-note">Every run of the {!o ? "old" : "new"} agent errored.</p>
            ) : (
              <>
                <ol className="path-diff">
                  {lines.map((l, i) => (
                    <li key={i} className={`${l.type}${l.sign === "-" ? " del" : l.sign === "+" ? " add" : ""}`}>
                      <span className="mark">{l.sign === "-" ? "−" : l.sign === "+" ? "+" : ""}</span>
                      <span className="step-type">{l.type}</span>
                      <span className="step">
                        {l.check ? (
                          <>
                            {l.text.split(": ")[0]} <em>{l.text.split(": ")[1]}</em>
                          </>
                        ) : (
                          l.text
                        )}
                        {l.sign === " " && l.old !== l.new ? (
                          <em>
                            {" "}
                            ×{l.old} → ×{l.new}
                          </em>
                        ) : Math.max(l.old, l.new) > 1 ? (
                          <em> ×{Math.max(l.old, l.new)}</em>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ol>
                <p className="path-legend">
                  <span className="del">− old agent only</span>
                  <span className="add">+ new agent only</span>
                  <span>unmarked: both</span>
                </p>
              </>
            )}
          </section>
          <section>
            <h3>Final reply</h3>
            <div className="panel-replies">
              {sides.map((s) => {
                const text = reply(s.path);
                return (
                  <div key={s.who}>
                    <span>{cap(s.who)}</span>
                    <p className={text ? undefined : "none"}>
                      {text ??
                        (s.path?.run.tool_calls.length
                          ? "no final text: anything it sent went through its tool calls (open a run below)"
                          : "no reply")}
                    </p>
                  </div>
                );
              })}
            </div>
          </section>
          {!!(related.lines.length + related.other.length) && (
            <section>
              <h3>Edits that mention it</h3>
              <DiffLines lines={related.lines} />
              {related.other.map((e) => (
                <div key={e} className="edit-other">
                  {e}
                </div>
              ))}
            </section>
          )}
          <RunsTable data={data} test={t} old={sides[0].runs} neu={sides[1].runs} oldPath={o} onOpen={openRun} />
        </>
      )}
    </SidePanel>
  );
}

/** What one run did, in words: an old run next to the old agent's usual path, a new run next to the old agent. */
function runResult(
  data: Dataset,
  t: TestComparison,
  r: RunRecord,
  oldPath: ReturnType<typeof usualPath>,
  grade: number | undefined,
): { label: string; tone: string } {
  if (r.error) return { label: "Error", tone: "error" };
  if (r.version === "old")
    return oldPath && stepsOf(r).join("\n") === oldPath.steps.join("\n")
      ? { label: "Usual path", tone: "same" }
      : { label: "Less common path", tone: "same" };
  const status = runStatus(t, r, data.comparison.writeTools ?? [], grade);
  return status === "rule"
    ? { label: "Breaks a test rule", tone: "rule" }
    : status === "low"
      ? { label: "Scored below 3", tone: "worse" }
      : status === "same"
        ? { label: "Same path as old", tone: "same" }
        : { label: "Different path", tone: "different" };
}

/** Every run of the test, old and new side by side by run number, each one opening its full trace in the panel. */
function RunsTable({
  data,
  test: t,
  old,
  neu,
  oldPath,
  onOpen,
}: {
  data: Dataset;
  test: TestComparison;
  old: RunRecord[];
  neu: RunRecord[];
  oldPath: ReturnType<typeof usualPath>;
  onOpen: (ref: RunRef) => void;
}) {
  const count = Math.max(old.length, neu.length);
  const cells = (r: RunRecord | undefined, who: string) => {
    if (!r) return <td colSpan={3} />;
    const grade = data.grades.find((g) => g.test === t.test && g.version === r.version && g.run === r.run)?.score;
    const result = runResult(data, t, r, oldPath, grade);
    return (
      <>
        <td>
          <button
            className="run-open"
            onClick={() => onOpen({ test: r.test, version: r.version, run: r.run })}
            aria-label={`Open ${who} run ${r.run}`}
            title="Show this run's full trace"
          >
            <span className="badge" data-kind={result.tone}>
              {result.label}
            </span>
            <Icon name="chevron" size={12} />
          </button>
        </td>
        <td className="num">{grade == null ? "–" : grade.toFixed(1)}</td>
        <td className="num">{fmtMs(r.latency_ms)}</td>
      </>
    );
  };
  return (
    <section>
      <h3>Every run</h3>
      <p className="panel-help">
        Each agent ran this test {count} times. Click a result to open that run's full trace: every tool call with its
        input and output, and the reply.
      </p>
      <table className="runs-table">
        <thead>
          <tr>
            <th rowSpan={2}>Run</th>
            <th colSpan={3}>Old agent</th>
            <th colSpan={3}>New agent</th>
          </tr>
          <tr>
            <th>Result</th>
            <th className="num">Score</th>
            <th className="num">Time</th>
            <th>Result</th>
            <th className="num">Score</th>
            <th className="num">Time</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: count }, (_, i) => (
            <tr key={i}>
              <td className="run-n">{i + 1}</td>
              {cells(old[i], "old agent")}
              {cells(neu[i], "new agent")}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
