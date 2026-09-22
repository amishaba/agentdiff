import { useEffect, useRef, useState, type ReactNode } from "react";
import { exampleRoute, hasLocalDashboard, routes } from "../data/navigation.ts";
import { changedLine, EXAMPLES, kindLabel, type ExampleStory, type ExampleSummary } from "../data/examples.ts";
import { AppShell } from "./AppShell.tsx";
import { Icon } from "./Icon.tsx";
import { StatTile } from "./StatTile.tsx";
import { KIND_LABEL } from "../review/model.ts";
import "./overview.css";

const COMMAND = "npx github:amishaba/agentdiff";

function CopyCommand() {
  const [status, setStatus] = useState<"copy" | "copied" | "failed">("copy");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(COMMAND);
      setStatus("copied");
      timer.current = setTimeout(() => setStatus("copy"), 1_400);
    } catch {
      setStatus("failed");
    }
  }
  return (
    <button className="copy-command" onClick={copy} aria-label={`Copy ${COMMAND}`}>
      <span>$</span>
      {COMMAND}
      <em aria-live="polite">{status === "failed" ? "select to copy" : status}</em>
    </button>
  );
}

// The loop, in order. `stage` matches the stage names a comparison records.
const STAGES = [
  { stage: "collect", title: "Collect", what: "Your tests, plus failed production runs you've saved." },
  { stage: "snapshot", title: "Snapshot", what: "Diffs the two versions: prompt, tools, model, guardrails." },
  { stage: "run", title: "Run", what: "Runs every test on both versions, over and over." },
  { stage: "discover", title: "Discover", what: "Writes new test cases aimed at what you changed." },
  { stage: "judge", title: "Judge", what: "Grades every run and throws out anything that's just noise." },
  { stage: "explain", title: "Explain", what: "Points at the line that probably caused it." },
  { stage: "save", title: "Report", what: "Posts the result on your PR." },
] as const;

const COMMANDS: [string, string][] = [
  ["npx agentdiff", "Set up on the first run, then compare against main and open the results"],
  ["npx agentdiff compare [ref]", "Run a comparison; --if-changed skips it when the agent is unchanged"],
  ["npx agentdiff view", "The local dashboard: comparisons, Braintrust incidents, project settings"],
  ["npx agentdiff report [dir]", "Rebuild a saved comparison's report, no model calls"],
  ["npx agentdiff explain", "A longer explanation of the last comparison"],
  ["npx agentdiff ci", "The GitHub Action's entry point"],
];

const CATCHES: [string, string][] = [
  ["removed a guardrail", "texts people who already replied STOP"],
  ["told it to move faster", "charges the card before checking the travel policy"],
  ["softened one line of the prompt", "refunds without running the fraud check"],
  ["switched to a cheaper model", "costs half as much, and here are the calls it stopped making"],
];

/** A baked label ("Broke a rule") as the change kind the badge colours by. */
const kindOf = (label: string) => Object.entries(KIND_LABEL).find(([, text]) => text === kindLabel(label))?.[0];

const sum = (pick: (e: ExampleSummary) => number) => EXAMPLES.reduce((total, e) => total + pick(e), 0);

/** The homepage: what agentdiff is, what it found on the recorded agents, and how to run it. */
export function Overview() {
  const story = EXAMPLES.find((e) => e.story);
  return (
    <AppShell
      place={{ kind: "home" }}
      crumbs={["agentdiff", "Overview"]}
      actions={
        <>
          <CopyCommand />
          <a className="dashboard-button primary" href={routes.dashboard}>
            {hasLocalDashboard() ? "Open your runs" : "Explore the demo"}
          </a>
        </>
      }
    >
      <div className="overview">
        <header className="page-head">
          <h1>Regression testing for AI agents</h1>
          <p>
            Change one line of a prompt and an agent can stop calling a tool, start replying where it used to stay
            silent, or break a rule your tests set. agentdiff runs the old and new version on the same tests, 10 times
            each, keeps only the changes that repeat, and puts them on the pull request.
          </p>
          <div className="ov-tags">
            {["Open source · MIT", "Mastra", "OpenAI Agents SDK", "Any function"].map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </div>
        </header>

        <section className="stat-row" aria-label="Across the recorded examples">
          <StatTile label="Recorded comparisons" value={EXAMPLES.length} sub="real models, saved runs" />
          <StatTile label="Tests" value={sum((e) => e.tests)} sub={`across all ${EXAMPLES.length} agents`} />
          <StatTile label="Agent runs" value={sum((e) => e.tests * e.runsPerTest * 2)} sub="old and new version" />
          <StatTile
            label="Tests that changed"
            value={`${sum((e) => e.changed)}/${sum((e) => e.tests)}`}
            sub={`${sum((e) => e.rule)} break a rule the test sets`}
          />
        </section>

        <section className="card" aria-labelledby="examples-title">
          <header className="card-head">
            <h2 id="examples-title">Recorded examples</h2>
            <span>one prompt change each, run on real models</span>
          </header>
          <table className="data-table ov-examples">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Top finding</th>
                <th>Tests changed</th>
                <th className="num">Rule breaks</th>
                <th className="num">Cost</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {EXAMPLES.map((e) => (
                <tr key={e.name}>
                  <td>
                    <a className="ov-example" href={exampleRoute(e.name)}>
                      <b>{e.title}</b>
                      <span>{e.change}</span>
                    </a>
                  </td>
                  <td className="ov-headline">{e.headline ?? changedLine(e)}</td>
                  <td>
                    <span className="ov-meter" title={changedLine(e)}>
                      <span className="ov-meter-bar">
                        <i style={{ width: `${(e.changed / e.tests) * 100}%` }} />
                      </span>
                      {e.changed}/{e.tests}
                    </span>
                  </td>
                  <td className="num">{e.rule}</td>
                  <td className="num">{e.cost ?? "–"}</td>
                  <td className="ov-open">
                    <a href={exampleRoute(e.name)} aria-label={`Open ${e.title}`}>
                      Open <Icon name="chevron" size={14} />
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {story?.story && <Finding e={story} s={story.story} />}

        <section className="card" aria-labelledby="loop-title">
          <header className="card-head">
            <h2 id="loop-title">How a comparison runs</h2>
            <span>with the numbers from the {story?.title ?? "first"} run</span>
          </header>
          <table className="data-table">
            <thead>
              <tr>
                <th className="ov-step">#</th>
                <th>Stage</th>
                <th>What it does</th>
                <th className="num">{story?.title}</th>
              </tr>
            </thead>
            <tbody>
              {STAGES.map((st, i) => (
                <tr key={st.stage}>
                  <td className="ov-step">{i + 1}</td>
                  <td>
                    <b>{st.title}</b>
                  </td>
                  <td className="dim">{st.what}</td>
                  <td className="num">{story ? stageStat(story, st.stage) : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <div className="ov-grid">
          <section className="card" aria-labelledby="start-title">
            <header className="card-head">
              <h2 id="start-title">Get started</h2>
              <span>Node 22.12 or newer</span>
            </header>
            <ol className="ov-start">
              <li>
                <b>Run it in your agent's git repo</b>
                <code>{COMMAND}</code>
              </li>
              <li>
                <b>First run</b>
                <span>Finds your agent, asks for your API keys, and writes a config and starter tests.</span>
              </li>
              <li>
                <b>Every run after</b>
                <span>Compares your edits with the version on main and opens the results here.</span>
              </li>
            </ol>
          </section>
          <section className="card" aria-labelledby="commands-title">
            <header className="card-head">
              <h2 id="commands-title">Commands</h2>
              <span>after npm install --save-dev</span>
            </header>
            <table className="data-table">
              <tbody>
                {COMMANDS.map(([command, what]) => (
                  <tr key={command}>
                    <td>
                      <code>{command}</code>
                    </td>
                    <td className="dim">{what}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>

        <section className="card" aria-labelledby="catches-title">
          <header className="card-head">
            <h2 id="catches-title">The kind of thing it catches</h2>
          </header>
          <table className="data-table">
            <thead>
              <tr>
                <th>You…</th>
                <th>and now your agent…</th>
              </tr>
            </thead>
            <tbody>
              {CATCHES.map(([a, b]) => (
                <tr key={a}>
                  <td>
                    <b>{a}</b>
                  </td>
                  <td>{b}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </AppShell>
  );
}

function stageStat(e: ExampleSummary, stage: (typeof STAGES)[number]["stage"]): string {
  const s = e.story;
  switch (stage) {
    case "collect":
      return `${e.tests} tests`;
    case "snapshot":
      return s ? `${s.prompt.length} prompt lines` : "–";
    case "run":
      return `${e.tests * e.runsPerTest * 2} runs`;
    case "discover":
      return e.discovery ? `${e.discovery.experiments} experiments` : "–";
    case "judge":
      return `${e.changed} of ${e.tests} changed`;
    case "explain":
      return "1 cause";
    case "save":
      return "1 PR comment";
  }
}

/** One real finding, laid out like an issue: what happened, on which runs, whether it held up, and the edit behind it. */
function Finding({ e, s }: { e: ExampleSummary; s: ExampleStory }) {
  const steps = (path: string) => path.split(" → ").filter(Boolean);
  const oldSteps = steps(s.old.path),
    newSteps = steps(s.new.path);
  const half = Math.ceil(s.new.runs.length / 2);
  return (
    <section className="card ov-finding" aria-labelledby="finding-title">
      <header className="card-head">
        <h2 id="finding-title">
          <span className="badge" data-kind={kindOf(s.label)}>
            {kindLabel(s.label)}
          </span>
          {s.fact}
        </h2>
        <a href={exampleRoute(e.name)}>
          {e.title} · {s.test}
        </a>
      </header>
      <dl className="ov-finding-body">
        <dt>Input</dt>
        <dd className="ov-input">{s.input}</dd>
        <dt>Old agent</dt>
        <dd>
          <Runs runs={s.old.runs} />
          <Path steps={oldSteps} other={newSteps} mark="-" />
        </dd>
        <dt>New agent</dt>
        <dd>
          <Runs runs={s.new.runs} />
          <Path steps={newSteps} other={oldSteps} mark="+" />
        </dd>
        {s.halves && (
          <>
            <dt>Holds up</dt>
            <dd className="ov-checks">
              <Check ok={s.halves.first}>
                runs 1–{half} {s.halves.first ? "changed" : "no change"}
              </Check>
              <Check ok={s.halves.second}>
                runs {half + 1}–{s.new.runs.length} {s.halves.second ? "changed" : "no change"}
              </Check>
              <Check ok={!s.halves.noise}>old vs old {s.halves.noise ? "moved too" : "no change"}</Check>
            </dd>
          </>
        )}
        <dt>Prompt edit</dt>
        <dd className="diff-lines">
          {s.prompt.map((l, i) => (
            <div key={i} className={l.sign === "-" ? "del" : "add"}>
              <span aria-hidden="true">{l.sign === "-" ? "−" : "+"}</span>
              <span>{l.text}</span>
            </div>
          ))}
          {s.other.map((o) => (
            <div key={o} className="other">
              <span />
              <span>{o}</span>
            </div>
          ))}
        </dd>
        <dt>Likely cause</dt>
        <dd className="ov-cause">{s.cause}</dd>
      </dl>
    </section>
  );
}

function Runs({ runs }: { runs: string[] }) {
  return (
    <span className="ov-runs" aria-label={`${runs.length} runs`}>
      {runs.map((status, i) => (
        <i key={i} className={status} title={`run ${i + 1}: ${status}`} />
      ))}
    </span>
  );
}

function Path({ steps, other, mark }: { steps: string[]; other: string[]; mark: "-" | "+" }) {
  return (
    <span className="ov-path">
      {steps.map((step, i) => (
        <code key={i} className={other.includes(step) ? undefined : mark === "-" ? "del" : "add"}>
          {step}
        </code>
      ))}
    </span>
  );
}

function Check({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <span className={ok ? "yes" : "no"}>
      <i aria-hidden="true">{ok ? "✓" : "×"}</i>
      {children}
    </span>
  );
}
