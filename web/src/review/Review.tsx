import { useMemo, useState } from "react";
import type { Dataset, RunRef } from "../data/types.ts";
import { confirmedChange, incompleteStages, noisyTests } from "../../../src/compare/signals.ts";
import { CHANGE_KINDS, changeKind, sortedTests, type ChangeKind } from "../../../src/compare/change-kind.ts";
import { discoveryFindings, kindCounts, KIND_LABEL, otherChanges, promptChanges, totals } from "./model.ts";
import { tableRows } from "./groups.ts";
import { DiffLines } from "./DiffLines.tsx";
import { TestsTable, type Filter } from "./TestsTable.tsx";
import { StatTile } from "../components/StatTile.tsx";
import { baseName, fmtMoney, fmtMs, fmtNum, plural } from "../data/derive.ts";
import "./review.css";

type Tab = "tests" | "changes" | "discovery" | "details";

/**
 * The comparisons page: headline numbers, then every test in one table, most serious first.
 * `onReplay` opens a recorded incident's old and new runs side by side; other runs open in the test's panel.
 */
export function Review({ data, onReplay }: { data: Dataset; onReplay?: (ref: RunRef) => void }) {
  const c = data.comparison;
  const rows = useMemo(() => tableRows(c, data.traces), [c, data.traces]);
  const findings = useMemo(() => discoveryFindings(c), [c]);
  const discovered = findings.filter((f) => f.differs).length;
  const n = kindCounts(c);
  const t = totals(c);
  const changed = c.tests.filter(confirmedChange).length;
  const incomplete = incompleteStages(c);
  const edits = promptChanges(c).reduce((sum, g) => sum + g.lines.length, 0) + otherChanges(c).length;

  const [tab, setTab] = useState<Tab>("tests");
  const [filter, setFilter] = useState<Filter>("all");
  const tabs: [Tab, string, number | null][] = [
    ["tests", "Tests", c.tests.length],
    ["changes", "Agent diff", edits],
    ...(c.discovery ? [["discovery", "Discovery", discovered] as [Tab, string, number]] : []),
    ["details", "Run details", null],
  ];
  const showKind = (k: ChangeKind) => {
    setFilter(k);
    setTab("tests");
  };

  return (
    <div className="review">
      <header className="r-head">
        <h1>
          {changed
            ? `${changed} of ${plural(c.tests.length, "test")} behave differently`
            : n.inconclusive
              ? "Nothing moved that repeated in both halves of the runs"
              : "Every test behaves the same"}
        </h1>
        <div className="meta">
          <code className="files">
            {baseName(c.oldFile)} → {baseName(c.newFile)}
          </code>
          <span>{c.agentName}</span>
          <span>
            {plural(c.tests.length, "test")} × {c.runsPerTest} runs
          </span>
          {c.createdAt && (
            <span>
              recorded {new Date(c.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
            </span>
          )}
          {c.grader && <span>scored by {c.grader === "jev" ? "Jev" : "OpenAI"}</span>}
        </div>
        {incomplete && <p className="warn">Incomplete: {incomplete}</p>}
      </header>

      <section className="kpis" aria-label="Summary">
        <StatTile
          label="Tests by change"
          value={
            <>
              {changed}
              <small>of {c.tests.length} behave differently</small>
            </>
          }
        >
          <div className="kind-bar" aria-hidden="true">
            {CHANGE_KINDS.filter((k) => n[k]).map((k) => (
              <span key={k} data-kind={k} style={{ flexGrow: n[k] }} />
            ))}
          </div>
          <ul className="kind-legend">
            {CHANGE_KINDS.filter((k) => n[k]).map((k) => (
              <li key={k}>
                <button onClick={() => showKind(k)}>
                  <i data-kind={k} />
                  {KIND_LABEL[k]}
                  <b>{n[k]}</b>
                </button>
              </li>
            ))}
          </ul>
        </StatTile>
        <StatTile label="Cost per run" value={t.cost ?? "–"} sub="new vs old, all tests" />
        <StatTile label="Latency" value={t.latency ?? "–"} sub="new vs old, all tests" />
        <StatTile
          label="Steps per run"
          value={t.stepsOld != null && t.stepsNew != null ? `${t.stepsOld.toFixed(1)} → ${t.stepsNew.toFixed(1)}` : "–"}
          sub="tool calls and checks"
        />
      </section>

      <div className="r-tabs" role="tablist" aria-label="Comparison sections">
        {tabs.map(([id, label, count]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {label}
            {count != null && <span className="tab-count">{count}</span>}
          </button>
        ))}
      </div>

      <div role="tabpanel" hidden={tab !== "tests"}>
        <TestsTable
          data={data}
          rows={rows}
          counts={n}
          changed={changed}
          filter={filter}
          setFilter={setFilter}
          onReplay={onReplay}
        />
      </div>
      <div role="tabpanel" hidden={tab !== "changes"}>
        <Edits data={data} />
      </div>
      {c.discovery && (
        <div role="tabpanel" hidden={tab !== "discovery"}>
          <Discovered data={data} />
        </div>
      )}
      <div role="tabpanel" hidden={tab !== "details"}>
        <More data={data} />
      </div>
    </div>
  );
}

/** Everything that differs between the two agents' configs: prompt lines, tools, model, settings. */
function Edits({ data }: { data: Dataset }) {
  const c = data.comparison;
  const lines = promptChanges(c);
  const other = otherChanges(c);
  const diff = c.snapshotDiff.instructionsDiff.trim();
  const count = lines.reduce((sum, g) => sum + g.lines.length, 0);
  const team = lines.length > 1 || lines.some((g) => g.agent !== (c.newSnapshot.name || c.agentName));
  return (
    <div className="stack">
      <section className="card">
        <header className="card-head">
          <h2>What changed in the agent</h2>
          <span>{[plural(count, "prompt line"), plural(other.length, "other change")].join(" · ")}</span>
        </header>
        {!count && !other.length && <p className="card-empty">The prompt, tools, model and settings are the same.</p>}
        {lines.map((g) => (
          <div key={g.agent} className="card-body">
            {team && <div className="edits-agent">{g.agent}</div>}
            <DiffLines lines={g.lines} />
          </div>
        ))}
      </section>
      {!!other.length && (
        <section className="card">
          <header className="card-head">
            <h2>Model, tools and settings</h2>
            <span>{plural(other.length, "change")}</span>
          </header>
          <ul className="kv-list">
            {other.map((o) => (
              <li key={o}>
                <code>{o}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
      {diff && (
        <section className="card">
          <header className="card-head">
            <h2>Raw prompt diff</h2>
            <span>{plural(diff.split("\n").length, "line")}</span>
          </header>
          <pre className="raw-diff">
            {diff.split("\n").map((l, i) => (
              <span key={i} className={l.startsWith("-") ? "d" : l.startsWith("+") ? "a" : undefined}>
                {l}
                {"\n"}
              </span>
            ))}
          </pre>
        </section>
      )}
    </div>
  );
}

/** Discovery's findings: new cases beyond the tests, each two cases that differ in one detail. */
function Discovered({ data }: { data: Dataset }) {
  const c = data.comparison;
  const d = c.discovery;
  const all = useMemo(() => discoveryFindings(c), [c]);
  if (!d) return null;
  const shown = all.filter((f) => f.differs),
    checksOnly = all.filter((f) => !f.differs);
  return (
    <section id="discovery" className="stack" aria-label="Found by discovery">
      <p className="panel-lead">
        Cases agentdiff wrote itself: pairs of messages that differ in one detail, run on both agents.{" "}
        {plural(d.experiments.length, "experiment")} · {plural(d.agentRuns, "run")}.
      </p>
      {!shown.length && (
        <div className="card">
          <p className="card-empty">{d.reason ?? "Nothing new held up when it reran the cases."}</p>
        </div>
      )}
      {shown.map((f) => (
        <article key={f.id} className="card">
          <header className="card-head">
            <h2>{f.name}</h2>
            {f.sameMessage && <span>Both cases send “{f.cases[0].message}”</span>}
          </header>
          <div className="disc-cases">
            {f.cases.map((cs, i) => (
              <div key={i} className="disc-case">
                <div className="disc-case-h">
                  <span>{i === 0 ? "Case A" : "Case B"}</span>
                  {cs.kind && (
                    <span className="badge" data-kind={cs.kind}>
                      {KIND_LABEL[cs.kind]}
                    </span>
                  )}
                </div>
                {!f.sameMessage && <p className="disc-msg">“{cs.message}”</p>}
                {cs.context.map((line) => (
                  <p key={line} className="disc-ctx">
                    {line}
                  </p>
                ))}
                <dl>
                  <dt>old</dt>
                  <dd>
                    {cs.old.path}{" "}
                    <span>
                      {cs.old.runs}/{cs.old.of}
                    </span>
                  </dd>
                  <dt>new</dt>
                  <dd className={cs.old.path !== cs.new.path ? "moved" : undefined}>
                    {cs.new.path}{" "}
                    <span>
                      {cs.new.runs}/{cs.new.of}
                    </span>
                  </dd>
                  {cs.expected && (
                    <>
                      <dt>expected</dt>
                      <dd className="disc-expected">{cs.expected}</dd>
                    </>
                  )}
                </dl>
              </div>
            ))}
          </div>
        </article>
      ))}
      {!!checksOnly.length && (
        <p className="panel-lead">
          {checksOnly.length === 1 ? "One more differs" : `${checksOnly.length} more differ`} only in checks the new
          agent no longer runs, with the same tool calls and reply:{" "}
          {checksOnly.map((f) => f.name.toLowerCase()).join("; ")}.
        </p>
      )}
    </section>
  );
}

function More({ data }: { data: Dataset }) {
  const c = data.comparison;
  const noisy = noisyTests(c);
  return (
    <div className="stack">
      <section className="card">
        <header className="card-head">
          <h2>Every test in numbers</h2>
          <span>averages per run, old → new</span>
        </header>
        <table className="data-table">
          <thead>
            <tr>
              <th>Test</th>
              <th>Status</th>
              <th className="num">Score</th>
              <th className="num">Cost</th>
              <th className="num">Latency</th>
              <th className="num">Steps</th>
            </tr>
          </thead>
          <tbody>
            {sortedTests(c).map((t) => {
              const kind = changeKind(t, c.writeTools);
              return (
                <tr key={t.test}>
                  <td>{t.test}</td>
                  <td>
                    <span className="badge" data-kind={kind}>
                      {KIND_LABEL[kind]}
                    </span>
                  </td>
                  <td className="num">
                    {fmtNum(t.old.avgGrade)} → {fmtNum(t.new.avgGrade)}
                  </td>
                  <td className="num">
                    {fmtMoney(t.old.avgCost)} → {fmtMoney(t.new.avgCost)}
                  </td>
                  <td className="num">
                    {fmtMs(t.old.avgLatencyMs)} → {fmtMs(t.new.avgLatencyMs)}
                  </td>
                  <td className="num">
                    {fmtNum(t.old.avgSteps)} → {fmtNum(t.new.avgSteps)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      {c.tests.some((t) => t.confirmation) && (
        <section className="card">
          <header className="card-head">
            <h2>Noise</h2>
            <span>
              old agent against itself:{" "}
              {noisy.length ? `${noisy.length} of ${c.tests.length} tests moved` : "no test moved"}
            </span>
          </header>
          <p className="card-text">
            Each side's runs are split in two halves. A change counts only when it shows up in both halves and the old
            agent's two halves agree with each other.
            {noisy.length ? ` The old agent's halves disagreed on: ${noisy.map((t) => t.test).join(", ")}.` : ""}
          </p>
        </section>
      )}
      {!!c.stages?.length && (
        <section className="card">
          <header className="card-head">
            <h2>How this comparison ran</h2>
            <span>{plural(c.stages.length, "stage")}</span>
          </header>
          <table className="data-table">
            <thead>
              <tr>
                <th>Stage</th>
                <th>Status</th>
                <th>Detail</th>
                <th className="num">Time</th>
              </tr>
            </thead>
            <tbody>
              {c.stages.map((s) => (
                <tr key={s.stage}>
                  <td>{s.stage}</td>
                  <td>
                    <span className={`status-pill ${s.status}`}>{s.status}</span>
                  </td>
                  <td>{s.detail}</td>
                  <td className="num">{(s.ms / 1000).toFixed(1)}s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {data.explanation?.trim() && (
        <section className="card">
          <header className="card-head">
            <h2>Explainer notes</h2>
            <span>written by a model from the numbers above</span>
          </header>
          <p className="card-text explainer">{data.explanation}</p>
        </section>
      )}
    </div>
  );
}
