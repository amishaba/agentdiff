import { useEffect, useMemo, useRef } from "react";
import { baseName, fmtMoney, fmtMs, gradeFor, missingRequired, runCost, runsFor, VERSIONS } from "../data/derive.ts";
import type { Dataset, RunRecord, RunRef, TestComparison } from "../data/types.ts";

function pretty(v: unknown): string {
  if (v == null) return "null";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export function TraceDrawer(props: {
  data: Dataset;
  tests: TestComparison[];
  sel: RunRef;
  onSelect: (r: RunRef) => void;
  onClose: () => void;
  records?: RunRecord[];
  context?: string;
}) {
  const { data, tests, sel, onSelect, onClose } = props;
  const body = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const containFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const controls = [
        ...(dialog.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input, select, textarea, summary, [tabindex="0"]',
        ) ?? []),
      ].filter((el) => el.getClientRects().length > 0);
      const first = controls[0],
        last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === body.current)) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === body.current)) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", containFocus);
    return () => {
      window.removeEventListener("keydown", containFocus);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  // ← / → walk every run on the page in reading order: old 1..n, new 1..n, next test.
  const order = useMemo<RunRef[]>(() => {
    if (props.records) return props.records.map((r) => ({ test: r.test, version: r.version, run: r.run }));
    const out: RunRef[] = [];
    for (const t of tests)
      for (const v of VERSIONS)
        for (const r of runsFor(data, t.test, v)) out.push({ test: t.test, version: v, run: r.run });
    return out;
  }, [data, tests, props.records]);
  const at = order.findIndex((r) => r.test === sel.test && r.version === sel.version && r.run === sel.run);
  const prev = at > 0 ? order[at - 1] : null;
  const next = at >= 0 && at < order.length - 1 ? order[at + 1] : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && prev) onSelect(prev);
      else if (e.key === "ArrowRight" && next) onSelect(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prev, next, onClose, onSelect]);

  useEffect(() => {
    body.current?.scrollTo({ top: 0 });
    body.current?.focus();
  }, [sel]);

  const t = tests.find((x) => x.test === sel.test);
  const r = props.records
    ? props.records.find((x) => x.test === sel.test && x.version === sel.version && x.run === sel.run)
    : runsFor(data, sel.test, sel.version).find((x) => x.run === sel.run);
  if (!r) return null;
  const g = props.records ? undefined : gradeFor(data, sel.test, sel.version, sel.run);
  const missing = t ? missingRequired(t, r) : [];
  const required = t?.mustCallTools ?? [];
  const total = props.records
    ? props.records.filter((x) => x.test === sel.test && x.version === sel.version).length
    : t?.[sel.version].runs;
  const file = sel.version === "old" ? data.comparison.oldFile : data.comparison.newFile;

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer trace-drawer" ref={dialog} role="dialog" aria-label="trace" aria-modal="true">
        <div className="drawer-head">
          <div>
            {props.context && <div className="m">{props.context}</div>}
            <div className="t">{t?.test ?? r.test}</div>
            <div className="m">
              {sel.version === "old" ? "v1" : "v2"} · {baseName(file)} · run {sel.run}
              {total != null && ` of ${total}`}
            </div>
          </div>
          <div className="keys">
            <button onClick={() => prev && onSelect(prev)} disabled={!prev} title="previous run (←)">
              ←
            </button>
            <button onClick={() => next && onSelect(next)} disabled={!next} title="next run (→)">
              →
            </button>
            <button onClick={onClose} title="close (esc)">
              esc
            </button>
          </div>
        </div>
        <div className="drawer-body" ref={body} tabIndex={-1}>
          <div className="trace-block">
            <span className="label">input</span>
            <div className="txt">{r.input}</div>
          </div>

          <div className="trace-block">
            <span className="label">
              tool calls · {r.tool_calls.length}
              {required.length ? ` (test requires ${required.join(", ")})` : ""}
            </span>
            {r.tool_calls.length === 0 ? (
              <div className="dim">
                {r.error ? "No tool calls recorded before the error." : "none - the agent answered directly."}
              </div>
            ) : null}
            {r.tool_calls.map((tc, i) => (
              <details className="call" key={`${sel.test}-${sel.version}-${sel.run}-${i}`} open={i === 0}>
                <summary className="call-name">
                  <code>
                    {i + 1}. {tc.tool}
                  </code>
                  {required.includes(tc.tool) ? <span className="label">required</span> : null}
                </summary>
                <div className="io">
                  <div>
                    <span className="label">arguments</span>
                    <pre>{pretty(tc.input)}</pre>
                  </div>
                  <div>
                    <span className="label">output</span>
                    <pre>{pretty(tc.output)}</pre>
                  </div>
                </div>
              </details>
            ))}
          </div>

          {missing.length ? <div className="missing-note">required but never called: {missing.join(", ")}</div> : null}

          <div className="trace-block">
            <span className="label">final response</span>
            <div className="txt">{r.final_response ?? <span className="dim">unavailable</span>}</div>
          </div>

          {r.error != null && (
            <div className="trace-block">
              <span className="label red">error</span>
              <pre className="red">{r.error}</pre>
            </div>
          )}

          <div className="metrics">
            <div>
              <div className="mv">{r.steps ?? "unavailable"}</div>
              <span className="label">steps</span>
            </div>
            <div>
              <div className="mv">
                {r.tokens ? `${r.tokens.input ?? "unavailable"} / ${r.tokens.output ?? "unavailable"}` : "unavailable"}
              </div>
              <span className="label">tokens in / out</span>
            </div>
            <div>
              <div className="mv">{r.latency_ms == null ? "unavailable" : fmtMs(r.latency_ms)}</div>
              <span className="label">latency</span>
            </div>
            <div>
              <div className="mv">{runCost(data, r) == null ? "unavailable" : fmtMoney(runCost(data, r))}</div>
              <span className="label">est. cost</span>
            </div>
          </div>

          {g ? (
            <div className="trace-block">
              <span className="label">
                grade · <b className={g.score <= 2 ? "red" : ""}>{g.score}</b>/5
                {t?.gradingCriteria ? ` · against: “${t.gradingCriteria}”` : ""}
              </span>
              <div className="txt dim">{g.reason}</div>
            </div>
          ) : null}
          <p className="dashboard-note">Saved trace · values may be clipped. This view is not a raw export.</p>
        </div>
      </aside>
    </>
  );
}
