import { fmtMoney, fmtMs, gradeFor, missingRequired, runCost } from "../data/derive.ts";
import type { Dataset, RunRecord, TestComparison } from "../data/types.ts";

function pretty(v: unknown): string {
  if (v == null) return "null";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** One run's full trace: its input, every tool call with arguments and output, the reply, cost and grade. */
export function TraceBody({ data, test: t, run: r }: { data: Dataset; test?: TestComparison; run: RunRecord }) {
  const g = gradeFor(data, r.test, r.version, r.run);
  const missing = t ? missingRequired(t, r) : [];
  const required = t?.mustCallTools ?? [];
  return (
    <div className="trace-body">
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
          <details className="call" key={`${r.test}-${r.version}-${r.run}-${i}`} open={i === 0}>
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
  );
}
