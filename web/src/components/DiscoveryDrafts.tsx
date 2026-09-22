import { isSampleWorkspace } from "../data/navigation.ts";
import { appFetch } from "../data/request.ts";
import { useEffect, useRef, useState } from "react";
import {
  PromoteDraftSchema,
  type DiscoveryDraft,
  type DraftList,
  type ProjectState,
  type SavedTests,
} from "../../../src/dashboard/project/types.ts";
import { localJson } from "../data/jobs.ts";
import { EmptyState, SectionHeading } from "./DashboardShared.tsx";

export function RequiredTools({
  tools,
  selected,
  onChange,
  disabled = false,
}: {
  tools: string[];
  selected: string[];
  onChange: (tools: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="project-tool-chips" role="group" aria-label="Required tools">
      {tools.length ? (
        tools.map((tool) => (
          <button
            type="button"
            key={tool}
            disabled={disabled}
            aria-pressed={selected.includes(tool)}
            onClick={() => onChange(selected.includes(tool) ? selected.filter((t) => t !== tool) : [...selected, tool])}
          >
            {tool}
          </button>
        ))
      ) : (
        <span className="dashboard-note">No tools were recorded for this agent.</span>
      )}
    </div>
  );
}

export interface DraftFocus {
  dir: string;
  file: string;
  serial: number;
}
function DraftReview({
  draft,
  project,
  busy,
  onSaved,
  open,
  onToggle,
}: {
  draft: DiscoveryDraft;
  project: ProjectState;
  busy: boolean;
  onSaved: () => Promise<void>;
  open: boolean;
  onToggle: () => void;
}) {
  const sample = isSampleWorkspace();
  const [tools, setTools] = useState<string[]>([]),
    [criteria, setCriteria] = useState(draft.expected ?? "");
  const [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState("");
  const request = useRef({ key: "", id: "" });
  async function download() {
    setError("");
    try {
      const response = await appFetch(
        `/api/project/draft?dir=${encodeURIComponent(draft.dir)}&file=${encodeURIComponent(draft.file)}`,
        { headers: { "x-agentdiff": "local" } },
      );
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error ?? "Could not download this draft.");
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = draft.file;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function promote(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    const payload = {
      dir: draft.dir,
      file: draft.file,
      draftRevision: draft.revision,
      revision: project.revision,
      must_call_tools: tools,
      grading_criteria: criteria,
    };
    const key = JSON.stringify(payload);
    if (request.current.key !== key) request.current = { key, id: crypto.randomUUID() };
    const parsed = PromoteDraftSchema.safeParse({ ...payload, requestId: request.current.id });
    if (!parsed.success) {
      setError("Describe the intended behaviour in the grading criteria before adding this test.");
      return;
    }
    setSaving(true);
    try {
      const result = await localJson<SavedTests>("/api/project/drafts/promote", parsed.data);
      setSaved(`${result.testsDir}/${result.files[0]}`);
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  const added = saved || (draft.savedFile ? `${project.config.tests}/${draft.savedFile}` : "");
  return (
    <article className="dashboard-card project-draft" data-draft-key={`${draft.dir}/${draft.file}`} tabIndex={-1}>
      <header>
        <div>
          <div className="draft-origin">
            <code>{draft.file}</code> · {draft.findingId} · experiment {draft.experimentId}
            <span>{draft.dir}</span>
          </div>
          <p>“{draft.input}”</p>
        </div>
        <div className="report-actions">
          <button className="dashboard-button" onClick={() => void download()}>
            Download
          </button>
          {!added && (
            <button className="dashboard-button primary" onClick={onToggle}>
              {open ? "Close review" : "Review and add"}
            </button>
          )}
        </div>
      </header>
      {added && (
        <p className="project-notice green" role="status">
          {sample ? "Added in this browser tab: " : "Added to "}
          <code>{added}</code>
        </p>
      )}
      {open && !added && (
        <form className="draft-review-form" onSubmit={(event) => void promote(event)} noValidate>
          <p className="dashboard-note">Hypothesis from discovery: {draft.hypothesis}</p>
          <div>
            <span className="field-label">Intended behaviour: which tools must be called?</span>
            <RequiredTools tools={draft.tools} selected={tools} onChange={setTools} disabled={saving} />
          </div>
          <label className="execution-field">
            Grading criteria
            <textarea
              aria-label="Grading criteria"
              rows={2}
              value={criteria}
              disabled={saving}
              onChange={(e) => setCriteria(e.target.value)}
              placeholder="Describe what a correct response should do."
            />
          </label>
          <div className="draft-save">
            <button className="dashboard-button primary" disabled={busy || saving || !criteria.trim()}>
              {saving ? "Adding…" : "Add to test suite"}
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="project-notice job-error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
export function DiscoveryDrafts({
  data,
  project,
  busy,
  requested,
  onSaved,
}: {
  data: DraftList;
  project: ProjectState;
  busy: boolean;
  requested?: DraftFocus;
  onSaved: () => Promise<void>;
}) {
  const [open, setOpen] = useState("");
  const root = useRef<HTMLDivElement>(null),
    handled = useRef<DraftFocus | undefined>(undefined);
  useEffect(() => {
    if (!requested || requested === handled.current) return;
    const key = `${requested.dir}/${requested.file}`;
    if (!data.drafts.some((d) => `${d.dir}/${d.file}` === key)) return;
    handled.current = requested;
    setOpen(key);
    const element = [...(root.current?.querySelectorAll<HTMLElement>("[data-draft-key]") ?? [])].find(
      (el) => el.dataset.draftKey === key,
    );
    element?.scrollIntoView({ block: "start" });
    element?.focus({ preventScroll: true });
  }, [requested, data.drafts]);
  const missing = requested && !data.drafts.some((d) => d.dir === requested.dir && d.file === requested.file);
  return (
    <section className="project-section" ref={root}>
      <SectionHeading title="Draft tests from discovery" note="discovery/drafts/" />
      <p className="dashboard-lead">
        Drafts hold the input and where it came from. Choose the required tools and grading criteria to define which
        behaviour is correct before adding one.
      </p>
      {missing && (
        <p className="job-error" role="alert">
          The selected draft is no longer available: {requested.dir}/{requested.file}.
        </p>
      )}
      {data.issues.length > 0 && (
        <details className="project-draft-issues">
          <summary>
            {data.issues.length} {data.issues.length === 1 ? "draft issue" : "draft issues"}
          </summary>
          {data.issues.map((issue, i) => (
            <p key={i}>{issue}</p>
          ))}
        </details>
      )}
      {data.drafts.length ? (
        <div className="project-draft-list">
          {data.drafts.map((draft) => {
            const key = `${draft.dir}/${draft.file}`;
            return (
              <DraftReview
                key={`${key}/${draft.revision}`}
                draft={draft}
                project={project}
                busy={busy}
                onSaved={onSaved}
                open={open === key}
                onToggle={() => setOpen((value) => (value === key ? "" : key))}
              />
            );
          })}
        </div>
      ) : (
        <EmptyState title="No discovery drafts yet">
          <p>Run a comparison. Discovery findings from it can become tests you review and add here.</p>
        </EmptyState>
      )}
    </section>
  );
}
