import type { TestHealth } from "../../../src/health/types.ts";
import { healthDetail } from "../../../src/health/describe.ts";
import type { CheckRunView } from "../../../src/dashboard/check/types.ts";
import { fmtMs, plural } from "../data/derive.ts";
import { SidePanel } from "../components/SidePanel.tsx";
import { Verdict } from "./Verdict.tsx";

/** One test of a check: what went wrong, its rules, its usual path, and every run with its tool calls. */
export function CheckPanel({
  test: t,
  runs,
  position,
  onPrev,
  onNext,
  onClose,
}: {
  test: TestHealth;
  runs: CheckRunView[];
  position: string;
  onPrev?: () => void;
  onNext?: () => void;
  onClose: () => void;
}) {
  return (
    <SidePanel
      id={t.test}
      badge={<Verdict status={t.status} />}
      title={t.test}
      subtitle={t.input}
      position={position}
      noun="test"
      onPrev={onPrev}
      onNext={onNext}
      onClose={onClose}
    >
      <section>
        <h3>What happened</h3>
        <p className="panel-input">{healthDetail(t) || `Nothing went wrong in ${plural(t.runs, "run")}.`}</p>
      </section>
      {!!t.rules.length && (
        <section>
          <h3>Rules</h3>
          <dl className="kv">
            {t.rules.map((r) => (
              <div key={`${r.kind}:${r.tool}`}>
                <dt>{r.kind === "required" ? "must call" : "must never call"}</dt>
                <dd>
                  <code>{r.tool}</code>{" "}
                  <span className={r.kept < r.of ? "rule-broken" : "dim"}>
                    kept in {r.kept}/{r.of} runs
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {t.usualPath && (
        <section>
          <div className="panel-sec-head">
            <h3>Usual path</h3>
            <span>
              {t.usualPath.runs}/{t.usualPath.of} runs took it · {plural(t.paths, "path")} in all
            </span>
          </div>
          <div className="step-chips">
            {t.usualPath.steps.length ? (
              t.usualPath.steps.map((s, i) => <code key={i}>{s}</code>)
            ) : (
              <span className="dim">no tool calls</span>
            )}
          </div>
        </section>
      )}
      <section>
        <h3>Every run</h3>
        <ol className="check-runs">
          {runs.map((r) => (
            <li key={r.run}>
              <details>
                <summary>
                  <b>Run {r.run}</b>
                  <span className="check-run-path">
                    {r.error ? (
                      <span className="rule-broken">errored</span>
                    ) : r.toolCalls.length ? (
                      r.toolCalls.map((c) => c.tool).join(" → ")
                    ) : (
                      "no tool calls"
                    )}
                  </span>
                  <span className="dim">
                    {r.score == null ? "" : `score ${r.score.toFixed(1)} · `}
                    {r.latencyMs == null ? "" : fmtMs(r.latencyMs)}
                  </span>
                </summary>
                {r.error && <pre className="check-error">{r.error}</pre>}
                {r.toolCalls.map((c, i) => (
                  <div key={i} className="check-call">
                    <code>
                      {i + 1}. {c.tool}
                    </code>
                    <div>
                      <span>called with</span>
                      <pre>{c.input}</pre>
                    </div>
                    <div>
                      <span>got back</span>
                      <pre>{c.output}</pre>
                    </div>
                  </div>
                ))}
                <div className="check-reply">
                  <span>final text</span>
                  <p>
                    {r.reply?.trim() ||
                      (r.toolCalls.length ? "none: anything it sent went through the tool calls above" : "none")}
                  </p>
                </div>
              </details>
            </li>
          ))}
        </ol>
      </section>
    </SidePanel>
  );
}
