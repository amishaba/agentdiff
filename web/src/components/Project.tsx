import { useCallback, useEffect, useRef, useState } from "react";
import type { DraftList, ProjectState } from "../../../src/dashboard/project/types.ts";
import { localJson, type JobControls } from "../data/jobs.ts";
import { ProjectConfig } from "./ProjectConfig.tsx";
import { DiscoveryDrafts, type DraftFocus } from "./DiscoveryDrafts.tsx";

export function Project({
  active,
  jobs,
  requestedDraft,
}: {
  active: boolean;
  jobs: JobControls;
  requestedDraft?: DraftFocus;
}) {
  const [project, setProject] = useState<ProjectState | null>(null),
    [drafts, setDrafts] = useState<DraftList>({ drafts: [], issues: [] });
  const [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true);
    setError("");
    try {
      const [state, list] = await Promise.allSettled([
        localJson<ProjectState>("/api/project"),
        localJson<DraftList>("/api/project/drafts"),
      ]);
      if (sequence.current !== request) return;
      if (state.status === "rejected") throw state.reason;
      setProject(state.value);
      setDrafts(list.status === "fulfilled" ? list.value : { drafts: [], issues: [list.reason.message] });
    } catch (e) {
      if (sequence.current === request) setError((e as Error).message);
    } finally {
      if (sequence.current === request) setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);
  useEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );
  return (
    <div className="project-panel">
      <header className="page-head">
        <h1>Project</h1>
        <p>Where agentdiff finds your agent and tests, and the draft tests discovery wrote for you to review.</p>
      </header>
      {error && (
        <p className="job-error" role="alert">
          {error}{" "}
          <button className="dashboard-link" onClick={() => void refresh()}>
            Reload project
          </button>
        </p>
      )}
      {!project && !error && (
        <p className="dashboard-note" role="status">
          Loading project settings…
        </p>
      )}
      {project && (
        <>
          <div className="project-meta">
            <span>
              {project.testCount} saved {project.testCount === 1 ? "test" : "tests"} in{" "}
              <code>{project.config.tests}</code>
            </span>
            <button className="dashboard-link" disabled={loading} onClick={() => void refresh()}>
              {loading ? "Refreshing…" : "Reload project"}
            </button>
          </div>
          {project.testIssue && (
            <p className="project-test-issue" role="status">
              {project.testIssue}
            </p>
          )}
          <section className="project-settings-grid">
            <ProjectConfig project={project} busy={jobs.busy} onSaved={refresh} />
          </section>
          <DiscoveryDrafts
            project={project}
            data={drafts}
            busy={jobs.busy}
            requested={requestedDraft}
            onSaved={refresh}
          />
        </>
      )}
    </div>
  );
}
