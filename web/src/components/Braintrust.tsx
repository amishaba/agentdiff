import { isSampleWorkspace } from "../data/navigation.ts";
import { localJson } from "../data/jobs.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Incident, Scenario } from "../../../src/dashboard/braintrust/scenario.ts";
import type { ReplayResponse, RunRecord } from "../../../src/types.ts";
import { incidentAge, incidentBadge, incidentScore } from "../data/braintrust.ts";
import { canonical } from "../data/replay.ts";
import "./braintrust.css";

type Status = { connected: boolean; projectId?: string; threshold: number };
type Project = { id: string; name: string };
type Review = {
  scenario: Scenario;
  expectation: string;
  required: string;
  answers: Record<string, string>;
  edits: Record<number, string>;
  missing: Missing[];
  lastRun: string | null;
};
type Missing = NonNullable<RunRecord["replay"]>["missing"][number];
const responseKey = (m: Missing) => JSON.stringify([m.tool, m.input, m.occurrence]);
const missingFor = (scenario: Scenario, missing: Missing[]) =>
  missing.filter(
    (m) =>
      !scenario.responses.some(
        (response) =>
          response.tool === m.tool &&
          response.occurrence === m.occurrence &&
          canonical(response.input) === canonical(m.input),
      ),
  );
const reviewFor = (scenario: Scenario, missing: Missing[] = [], lastRun: string | null = null): Review => ({
  scenario,
  expectation: scenario.expectation || scenario.suggestedExpectation,
  required: scenario.mustCallTools.join(", "),
  answers: {},
  edits: {},
  missing,
  lastRun,
});
function api<T>(route: string, value?: unknown): Promise<T> {
  return localJson<T>("/api/braintrust/" + route, value);
}

export function Braintrust({ onCompared }: { onCompared: (dir: string) => void }) {
  const sample = isSampleWorkspace();
  const [status, setStatus] = useState<Status | null>(null),
    [projects, setProjects] = useState<Project[]>([]);
  const [key, setKey] = useState(""),
    [changeKey, setChangeKey] = useState(false),
    [connectionVersion, setConnectionVersion] = useState(0);
  const [incidents, setIncidents] = useState<Incident[]>([]),
    [hasMore, setHasMore] = useState(false),
    [checked, setChecked] = useState("");
  const [reviews, setReviews] = useState<Record<string, Review>>({}),
    [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState(""),
    [reviewError, setReviewError] = useState(""),
    [pending, setPending] = useState("");
  const [loading, setLoading] = useState(false),
    [loadingOlder, setLoadingOlder] = useState(false);
  const requestSequence = useRef(0),
    selection = useRef(""),
    refreshing = useRef<string | null>(null);

  const refresh = useCallback(async (older = false) => {
    const context = selection.current;
    if (!context || refreshing.current === context) return;
    const request = ++requestSequence.current;
    refreshing.current = context;
    setLoading(true);
    setLoadingOlder(older);
    try {
      const result = await api<{ incidents: Incident[]; hasMore: boolean; checkedAt: string }>(
        "incidents" + (older ? "?older=1" : ""),
      );
      if (request !== requestSequence.current || context !== selection.current) return;
      setIncidents(result.incidents);
      setHasMore(result.hasMore);
      setChecked(result.checkedAt);
      setError("");
    } catch (e) {
      if (request === requestSequence.current && context === selection.current) setError((e as Error).message);
    } finally {
      if (request === requestSequence.current) {
        refreshing.current = null;
        setLoading(false);
        setLoadingOlder(false);
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api<Status>("status")
      .then(async (s) => {
        if (cancelled) return;
        setStatus(s);
        if (s.connected) {
          const result = await api<{ projects: Project[] }>("projects");
          if (!cancelled) setProjects(result.projects);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    selection.current =
      status?.connected && status.projectId ? status.projectId + ":" + status.threshold + ":" + connectionVersion : "";
    requestSequence.current++;
    refreshing.current = null;
    setIncidents([]);
    setChecked("");
    setHasMore(false);
    setOpenId(null);
    setReviews({});
    setReviewError("");
    setLoading(false);
    if (!selection.current) return;
    void refresh();
    if (sample) return;
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 60_000);
    return () => {
      clearInterval(timer);
      requestSequence.current++;
      refreshing.current = null;
    };
  }, [status?.connected, status?.projectId, status?.threshold, connectionVersion, refresh]);

  async function act(action: string, work: () => Promise<void>) {
    setPending(action);
    setError("");
    setReviewError("");
    try {
      await work();
    } catch (e) {
      if (action === "save") setReviewError((e as Error).message);
      else setError((e as Error).message);
    } finally {
      setPending("");
    }
  }
  async function openIncident(id: string) {
    setReviewError("");
    if (openId === id) {
      setOpenId(null);
      return;
    }
    if (reviews[id]) {
      setOpenId(id);
      return;
    }
    const [scenario, last] = await Promise.all([
      api<Scenario>("scenario?id=" + encodeURIComponent(id)),
      api<{ dir: string | null; missing: Missing[] }>("missing?id=" + encodeURIComponent(id)),
    ]);
    setReviews((previous) => ({ ...previous, [id]: reviewFor(scenario, last.missing, last.dir) }));
    setOpenId(id);
  }
  const updateReview = (id: string, update: Partial<Review>) => {
    setReviewError("");
    setReviews((previous) => ({ ...previous, [id]: { ...previous[id], ...update } }));
  };
  async function saveAsTest(id: string) {
    const review = reviews[id],
      draft = review.scenario;
    const responses: ReplayResponse[] = missingFor(draft, review.missing).map((m) => {
      let output: unknown;
      try {
        output = JSON.parse(review.answers[responseKey(m)]);
      } catch {
        throw new Error("Enter valid JSON for " + m.tool + " (call " + m.occurrence + ").");
      }
      return { ...m, output, source: "user" };
    });
    for (const [index, text] of Object.entries(review.edits)) {
      const response = draft.responses[Number(index)];
      try {
        responses.push({ ...response, output: JSON.parse(text), source: "user" });
      } catch {
        throw new Error("Enter valid JSON for " + response.tool + " (call " + response.occurrence + ").");
      }
    }
    const saved = await api<Scenario & { reviewRevision: string }>("review", {
      id,
      expectation: review.expectation,
      mustCallTools: review.required
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      responses,
    });
    const added = await api<{ file: string; reviewRevision: string }>("add", { id });
    setReviews((previous) => ({
      ...previous,
      [id]: reviewFor(saved, missingFor(saved, review.missing), review.lastRun),
    }));
    setIncidents((previous) =>
      previous.map((incident) =>
        incident.id === id
          ? {
              ...incident,
              reviewed: true,
              reviewRevision: saved.reviewRevision,
              savedFile: added.file,
              savedRevision: added.reviewRevision,
            }
          : incident,
      ),
    );
    setOpenId(null);
  }
  const disabled = !!pending;
  const selectedProject = projects.find((p) => p.id === status?.projectId);
  return (
    <section className="braintrust-panel" id="incidents" aria-label="Test failed Braintrust runs">
      <header className="braintrust-heading">
        <div>
          <h1>Turn a failed Braintrust run into a test</h1>
          <p>
            Pick a failed production run, say what the agent should have done, and save it to your tests. Every
            comparison then runs it on both agents, with the recorded tool responses.
          </p>
        </div>
        {status?.connected && (
          <div className="braintrust-connection">
            <span className="braintrust-connection-dot" aria-label={sample ? "Sample project" : "Connected"} />
            <label className="braintrust-inline-control">
              <span className="sr-only">Braintrust project</span>
              <select
                aria-label="Braintrust project"
                value={status.projectId ?? ""}
                disabled={disabled}
                title={selectedProject?.name ?? "Choose a project"}
                onChange={(e) => {
                  const projectId = e.target.value;
                  void act("project", async () => {
                    await api("project", { projectId, threshold: status.threshold });
                    setStatus((s) => (s ? { ...s, projectId } : s));
                  });
                }}
              >
                <option value="" disabled>
                  Choose project
                </option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="braintrust-inline-control">
              score below{" "}
              <select
                aria-label="Score threshold"
                value={status.threshold}
                disabled={disabled || !status.projectId}
                onChange={(e) => {
                  const threshold = Number(e.target.value);
                  void act("threshold", async () => {
                    await api("project", { projectId: status.projectId, threshold });
                    setStatus((s) => (s ? { ...s, threshold } : s));
                  });
                }}
              >
                {[...new Set([0.25, 0.5, 0.75, 1, status.threshold])]
                  .sort((a, b) => a - b)
                  .map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
              </select>
            </label>
            {checked && (
              <span title={new Date(checked).toLocaleString()}>
                · updated {new Date(checked).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            )}
            <button
              className="dashboard-link"
              disabled={disabled}
              onClick={() => {
                setChangeKey((value) => !value);
                setKey("");
              }}
            >
              {sample ? "Connection details" : "Change key"}
            </button>
            <button
              className="dashboard-button braintrust-refresh"
              disabled={disabled || loading || !status.projectId}
              onClick={() => void refresh()}
            >
              {loading && !loadingOlder ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        )}
      </header>
      {error && (
        <p className="job-error braintrust-error" role="alert">
          {error}
        </p>
      )}
      {!status && !error && (
        <p className="dashboard-note" role="status">
          Checking connection…
        </p>
      )}
      {sample && changeKey && (
        <div className="dashboard-card braintrust-connect">
          <p>
            This is a sample Braintrust project. No account is connected and no API key is needed. Connect your own
            project from the local AgentDiff app.
          </p>
          <button className="dashboard-button" onClick={() => setChangeKey(false)}>
            Close details
          </button>
        </div>
      )}
      {!sample && ((status && !status.connected) || changeKey) && (
        <form
          className="dashboard-card braintrust-connect"
          onSubmit={(e) => {
            e.preventDefault();
            void act("connect", async () => {
              const result = await api<{ projects: Project[]; projectId?: string }>("connect", { apiKey: key });
              setKey("");
              setChangeKey(false);
              setProjects(result.projects);
              setConnectionVersion((value) => value + 1);
              setStatus((s) => (s ? { ...s, connected: true, projectId: result.projectId, threshold: 0.5 } : s));
            });
          }}
        >
          <p>Connect Braintrust to load failed runs from your project.</p>
          <label className="execution-field">
            Braintrust API key
            <input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              required
              placeholder="Paste your API key"
              disabled={disabled}
            />
          </label>
          <div className="braintrust-connect-actions">
            {changeKey && (
              <button
                className="dashboard-button"
                type="button"
                disabled={!!pending}
                onClick={() => {
                  setChangeKey(false);
                  setKey("");
                }}
              >
                Cancel
              </button>
            )}
            <button className="dashboard-button primary" disabled={disabled || !key.trim()}>
              {pending === "connect" ? "Connecting…" : "Connect Braintrust"}
            </button>
          </div>
        </form>
      )}
      {status?.connected && (
        <>
          {!status.projectId && <p className="dashboard-note">Choose a Braintrust project to load its failed runs.</p>}
          {status.projectId && !incidents.length && (
            <div className="dashboard-empty" role="status">
              <h3>{loading ? "Loading failed runs…" : checked ? "No failed runs found" : "Failed runs unavailable"}</h3>
              <p>
                {loading
                  ? "Reading the selected project’s recorded traces."
                  : checked
                    ? "No recorded errors or scores below the selected threshold were found in the records checked so far."
                    : "Refresh to try loading this project again."}
              </p>
            </div>
          )}
          {!!incidents.length && (
            <div className="dashboard-card braintrust-inbox">
              <div className="braintrust-incident-summary braintrust-columns" aria-hidden="true">
                <span>Score</span>
                <span>Input</span>
                <span>Reason</span>
                <span>Trace</span>
                <span>Age</span>
                <span />
              </div>
              {incidents.map((incident) => {
                const badge = incidentBadge(incident),
                  score = incidentScore(incident);
                const review = openId === incident.id ? reviews[incident.id] : undefined;
                const missing = review ? missingFor(review.scenario, review.missing) : [];
                return (
                  <article className="braintrust-incident" key={incident.id} aria-label={incident.name}>
                    <div className="braintrust-incident-summary">
                      <span className="braintrust-score" title={score.detail} aria-label={score.detail}>
                        {score.label}
                      </span>
                      <p className="braintrust-input" title={incident.input}>
                        {incident.input}
                      </p>
                      <span className="braintrust-meta" title={incident.reason}>
                        {incident.reason}
                      </span>
                      <span className="braintrust-meta" title={incident.rootSpanId}>
                        {incident.rootSpanId}
                      </span>
                      <time
                        className="braintrust-meta"
                        dateTime={incident.created || undefined}
                        title={incident.created ? new Date(incident.created).toLocaleString() : undefined}
                      >
                        {incidentAge(incident.created)}
                      </time>
                      <div className="braintrust-actions">
                        {badge && (
                          <span className={"braintrust-status " + badge.tone} title={badge.detail} role="status">
                            {badge.label}
                          </span>
                        )}
                        <button
                          className="dashboard-button"
                          aria-expanded={!!review}
                          aria-controls={"review-" + incident.id}
                          disabled={disabled}
                          onClick={() => void act("review", () => openIncident(incident.id))}
                        >
                          {review ? "Close review" : "Review"}
                        </button>
                      </div>
                    </div>
                    {review?.lastRun && (
                      <div className="braintrust-result">
                        <button className="dashboard-link" onClick={() => onCompared(review.lastRun!)}>
                          Last comparison that ran it →
                        </button>
                      </div>
                    )}
                    {review && (
                      <form
                        className="braintrust-review"
                        id={"review-" + incident.id}
                        aria-label={"Review " + incident.name}
                        onSubmit={(e) => {
                          e.preventDefault();
                          void act("save", () => saveAsTest(incident.id));
                        }}
                      >
                        <p>
                          The recording shows what happened; your expected behaviour defines a correct result. Saving
                          writes this run to your tests, and every comparison replays it.
                        </p>
                        <details className="braintrust-original">
                          <summary>Full recorded input</summary>
                          <p>{review.scenario.input || "This recording's input couldn't be read as a message."}</p>
                          {!!review.scenario.conversation?.length && (
                            <p className="dashboard-note">
                              After {review.scenario.conversation.length} earlier{" "}
                              {review.scenario.conversation.length === 1 ? "turn" : "turns"}.
                            </p>
                          )}
                          {review.scenario.context && <pre>{JSON.stringify(review.scenario.context, null, 2)}</pre>}
                        </details>
                        {review.scenario.blockers.map((blocker) => (
                          <p className="job-error" key={blocker} role="alert">
                            {blocker}
                          </p>
                        ))}
                        <label className="execution-field">
                          Expected behaviour
                          <textarea
                            aria-label="Expected behaviour"
                            rows={2}
                            value={review.expectation}
                            disabled={disabled}
                            onChange={(e) => updateReview(incident.id, { expectation: e.target.value })}
                            placeholder="Describe what a correct response should do."
                          />
                        </label>
                        {review.scenario.suggestedExpectation && !review.scenario.reviewed && (
                          <p>Braintrust supplied an expected result. Review it before saving.</p>
                        )}
                        <label className="execution-field">
                          Required tools
                          <input
                            aria-label="Required tools"
                            aria-describedby={"required-help-" + incident.id}
                            value={review.required}
                            disabled={disabled}
                            onChange={(e) => updateReview(incident.id, { required: e.target.value })}
                            placeholder="Tool names, separated by commas"
                          />
                          <span id={"required-help-" + incident.id}>
                            Optional. Each named tool must be called in every run.
                          </span>
                        </label>
                        <details className="braintrust-recorded">
                          <summary>Recorded tool responses ({review.scenario.responses.length})</summary>
                          <p className="dashboard-note">
                            Replays use these recorded or supplied responses. Edit them as JSON when the test needs
                            different data.
                          </p>
                          {review.scenario.responses.map((response, index) => (
                            <div className="braintrust-response" key={responseKey(response)}>
                              <div>
                                <code>{response.tool}</code> · call {response.occurrence} · {response.source}
                              </div>
                              <pre>{JSON.stringify(response.input, null, 2)}</pre>
                              <label className="execution-field">
                                Response to use (JSON)
                                <textarea
                                  aria-label={"Response for " + response.tool + " call " + response.occurrence}
                                  rows={3}
                                  value={review.edits[index] ?? JSON.stringify(response.output, null, 2)}
                                  disabled={disabled}
                                  onChange={(e) =>
                                    updateReview(incident.id, { edits: { ...review.edits, [index]: e.target.value } })
                                  }
                                />
                              </label>
                            </div>
                          ))}
                        </details>
                        {!!missing.length && (
                          <div className="braintrust-missing">
                            <h3>
                              The last comparison was blocked: {missing.length} tool{" "}
                              {missing.length === 1 ? "output wasn’t" : "outputs weren’t"} recorded
                            </h3>
                            {missing.map((m) => (
                              <div className="braintrust-response" key={responseKey(m)}>
                                <div>
                                  <code>{m.tool}</code> · call {m.occurrence}
                                </div>
                                <pre>{JSON.stringify(m.input, null, 2)}</pre>
                                <label className="execution-field">
                                  Output to use in every replay (JSON)
                                  <textarea
                                    aria-label={"Missing output for " + m.tool + " call " + m.occurrence}
                                    rows={2}
                                    value={review.answers[responseKey(m)] ?? ""}
                                    disabled={disabled}
                                    onChange={(e) =>
                                      updateReview(incident.id, {
                                        answers: { ...review.answers, [responseKey(m)]: e.target.value },
                                      })
                                    }
                                    placeholder="Enter the tool response as JSON"
                                  />
                                </label>
                              </div>
                            ))}
                          </div>
                        )}
                        <p>
                          Required tools are checked from each run's tool calls; the expected behaviour is graded like
                          any other test.
                        </p>
                        {reviewError && (
                          <p className="job-error" role="alert">
                            {reviewError}
                          </p>
                        )}
                        <footer>
                          <button
                            className="dashboard-button"
                            type="button"
                            disabled={!!pending}
                            onClick={() => {
                              setOpenId(null);
                              setReviewError("");
                              setReviews((previous) => {
                                const next = { ...previous };
                                delete next[incident.id];
                                return next;
                              });
                            }}
                          >
                            Cancel
                          </button>
                          <button
                            className="dashboard-button primary"
                            disabled={
                              disabled ||
                              !!review.scenario.blockers.length ||
                              (!review.expectation.trim() && !review.required.trim()) ||
                              missing.some((m) => !review.answers[responseKey(m)]?.trim())
                            }
                          >
                            {pending === "save" ? "Saving…" : incident.savedFile ? "Update the test" : "Save as test"}
                          </button>
                        </footer>
                      </form>
                    )}
                  </article>
                );
              })}
              {hasMore && (
                <footer className="braintrust-pagination">
                  <button className="dashboard-link" disabled={disabled || loading} onClick={() => void refresh(true)}>
                    {loadingOlder ? "Loading older runs…" : "Load older runs"}
                  </button>
                </footer>
              )}
            </div>
          )}
          {hasMore && !incidents.length && (
            <div className="braintrust-pagination">
              <button className="dashboard-link" disabled={disabled || loading} onClick={() => void refresh(true)}>
                Load older runs
              </button>
            </div>
          )}
        </>
      )}
      <p className="braintrust-footnote">
        {sample
          ? "Review edits stay in this browser tab."
          : "Your key stays on this computer. Saved incidents run in every comparison, locally, with the recorded tool outputs."}
      </p>
    </section>
  );
}
