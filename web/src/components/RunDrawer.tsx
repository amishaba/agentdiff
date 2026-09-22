import { isSampleWorkspace } from "../data/navigation.ts";
import { useEffect, useRef, useState } from "react";
import {
  CompareRequestSchema,
  type CompareRequest,
  type JobRequest,
  type RunSetup,
} from "../../../src/dashboard/jobs/types.ts";
import { DiscoveryConfigSchema } from "../../../src/discovery/types.ts";
import { localJson } from "../data/jobs.ts";

export function RunDrawer({
  busy,
  onStart,
  onClose,
}: {
  busy: boolean;
  onStart: (request: JobRequest) => Promise<unknown>;
  onClose: () => void;
}) {
  const [setup, setSetup] = useState<RunSetup | null>(null);
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.current?.showModal();
    return () => {
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoadError("");
    localJson<RunSetup>("/api/jobs/setup", undefined, controller.signal)
      .then(setSetup)
      .catch((error) => {
        if (!controller.signal.aborted) setLoadError(error.message);
      });
    return () => controller.abort();
  }, [attempt]);
  const title = "New comparison";
  return (
    <dialog
      ref={dialog}
      className="execution-drawer"
      aria-labelledby="execution-title"
      onCancel={(event) => {
        event.preventDefault();
        close.current();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const bounds = event.currentTarget.getBoundingClientRect();
          if (event.clientX < bounds.left) close.current();
        }
      }}
    >
      <header>
        <h2 id="execution-title">{title}</h2>
        <button className="drawer-close" aria-label={`Close ${title.toLowerCase()}`} onClick={onClose}>
          ✕
        </button>
      </header>
      {setup ? (
        <RunForm setup={setup} busy={busy} onStart={onStart} onClose={onClose} />
      ) : (
        <div className="execution-body">
          <p role={loadError ? "alert" : "status"}>{loadError || "Loading project settings…"}</p>
          {loadError && (
            <button className="dashboard-button" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          )}
        </div>
      )}
    </dialog>
  );
}

const numericFields = [
  ["maxCandidates", "Candidates", 1, 30],
  ["maxRounds", "Rounds", 1, 5],
  ["confirmationRuns", "Confirmation runs", 3, 10],
  ["maxFindings", "Max findings", 1, 10],
  ["timeoutMs", "Timeout (seconds)", 0.1, 120],
  ["maxSteps", "Max steps", 1, 50],
] as const;
function RunForm({
  setup,
  busy,
  onStart,
  onClose,
}: {
  setup: RunSetup;
  busy: boolean;
  onStart: (request: JobRequest) => Promise<unknown>;
  onClose: () => void;
}) {
  const sample = isSampleWorkspace();
  const { config } = setup;
  const gitAllowed = !!config.agentPath && !!setup.refs.length;
  const [mode, setMode] = useState<CompareRequest["mode"]>(gitAllowed || !config.versions ? "git" : "files");
  const [ref, setRef] = useState(setup.defaultRef);
  const [ifChanged, setIfChanged] = useState(true);
  const defaults = DiscoveryConfigSchema.parse(config.discovery ?? {});
  const [fields, setFields] = useState<Record<string, string>>(() => ({
    fixtures: defaults.fixtures ?? "",
    context: defaults.context,
    ...Object.fromEntries([
      ...numericFields.map(([key]) => [key, String(key === "timeoutMs" ? defaults[key] / 1000 : defaults[key])]),
      ["maxAgentRuns", String(defaults.maxAgentRuns)],
    ]),
  }));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const errorMessage = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) errorMessage.current?.focus();
  }, [error]);
  const discovery = !setup.onlyIncidentTests;
  const runs = setup.testCount * config.runsPerTest * 2;
  const modeAllowed = mode === "git" ? gitAllowed : !!config.versions;
  const ready = !busy && !submitting && modeAllowed;
  const oldPath = mode === "git" ? `${config.agentPath} @ ${ref || "…"}` : config.versions?.old;
  const newPath = mode === "git" ? `${config.agentPath} (working tree)` : (config.versions?.new ?? config.agentPath);
  const change = (key: string, value: string) => setFields((old) => ({ ...old, [key]: value }));
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    const settings = {
      fixtures: fields.fixtures.trim() || undefined,
      context: fields.context,
      maxAgentRuns: Number(fields.maxAgentRuns),
      ...Object.fromEntries(
        numericFields.map(([key]) => [
          key,
          fields[key] === "" ? NaN : Number(fields[key]) * (key === "timeoutMs" ? 1000 : 1),
        ]),
      ),
    };
    const result = CompareRequestSchema.safeParse({
      mode,
      ...(mode === "git" ? { ref } : {}),
      ifChanged,
      discovery: settings,
    });
    if (!result.success) {
      setError(result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      return;
    }
    const request: JobRequest = { kind: "compare", options: result.data };
    setSubmitting(true);
    try {
      await onStart(request);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the job.");
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <form className="execution-form" noValidate onSubmit={(event) => void submit(event)}>
      <div className="execution-body">
        {sample && (
          <p className="dashboard-note">
            Recorded run · explore these settings, then load the recorded comparison. Your settings stay in this browser
            tab.
          </p>
        )}
        <div>
          <span className="field-label">Compare the current agent against</span>
          <div className="execution-modes">
            <button type="button" aria-pressed={mode === "git"} disabled={!gitAllowed} onClick={() => setMode("git")}>
              <strong>Git ref</strong>
              <span>{gitAllowed ? "Working tree vs a commit" : "Needs agentPath and Git"}</span>
            </button>
            <button
              type="button"
              aria-pressed={mode === "files"}
              disabled={!config.versions}
              onClick={() => setMode("files")}
            >
              <strong>Config files</strong>
              <span>{config.versions ? "Old / new pair" : "Needs versions.old / new"}</span>
            </button>
          </div>
        </div>
        {mode === "git" && (
          <label className="execution-field">
            Git ref
            <input list="comparison-refs" value={ref} onChange={(e) => setRef(e.target.value)} required />
            <datalist id="comparison-refs">
              {setup.refs.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </label>
        )}
        <dl className="execution-summary">
          <dt>Old</dt>
          <dd>
            <code>{oldPath}</code>
          </dd>
          <dt>New</dt>
          <dd>
            <code>{newPath}</code>
          </dd>
          <dt>Tests</dt>
          <dd>
            {setup.testCount} tests in <code>{config.tests}</code>
          </dd>
          <dt>Runs</dt>
          <dd>
            {config.runsPerTest} per test per version · {runs} agent runs
          </dd>
        </dl>
        <label className="execution-checkbox">
          <input type="checkbox" checked={ifChanged} onChange={(e) => setIfChanged(e.target.checked)} />
          <span>
            Skip if the agent snapshot is unchanged<small>Same prompt, model, tools, and settings means no runs.</small>
          </span>
        </label>
        <div className="execution-discovery">
          <div className="discovery-toggle">
            <strong>Behavioural discovery</strong>
            <p>
              Every comparison also writes new inputs aimed at what changed and checks whether the difference repeats.
            </p>
          </div>
          {!discovery && (
            <p className="execution-help">
              Skipped: every test is a saved Braintrust incident, and discovery builds its cases from ordinary tests.
            </p>
          )}
          {discovery && (
            <>
              <label className="execution-field">
                Fixture module
                <input
                  value={fields.fixtures}
                  onChange={(e) => change("fixtures", e.target.value)}
                  placeholder="agentdiff/fixtures.ts"
                />
                <span>Functions that answer the agent’s tool calls. They can keep state between calls.</span>
              </label>
              <label className="execution-field">
                Context (optional)
                <textarea
                  rows={2}
                  maxLength={12000}
                  value={fields.context}
                  onChange={(e) => change("context", e.target.value)}
                  placeholder="What should this agent always or never do?"
                />
              </label>
              <label className="execution-field">
                Max agent runs
                <input
                  className="short-input"
                  type="number"
                  min={20}
                  max={500}
                  step={1}
                  required
                  value={fields.maxAgentRuns}
                  onChange={(e) => change("maxAgentRuns", e.target.value)}
                />
                <span>Counts agent attempts, not dollars or tool calls.</span>
              </label>
              <details className="execution-advanced">
                <summary>Advanced</summary>
                <div>
                  {numericFields.map(([key, label, min, max]) => (
                    <label className="execution-field" key={key}>
                      {label}
                      <input
                        type="number"
                        min={min}
                        max={max}
                        step={key === "timeoutMs" ? 0.001 : 1}
                        required
                        value={fields[key]}
                        onChange={(e) => change(key, e.target.value)}
                      />
                    </label>
                  ))}
                </div>
              </details>
            </>
          )}
        </div>
        {busy && (
          <p className="execution-help" role="status">
            Another job is running. You can start this when it finishes.
          </p>
        )}
        {error && (
          <p ref={errorMessage} tabIndex={-1} className="job-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer>
        <span>
          {runs} agent runs{discovery ? ` + up to ${fields.maxAgentRuns || "-"} discovery runs` : ""}
        </span>
        <button className="dashboard-button primary" type="submit" disabled={!ready}>
          {submitting ? "Loading…" : sample ? "Load recorded comparison" : "Start comparison"}
        </button>
      </footer>
    </form>
  );
}
