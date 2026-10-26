import { isSampleWorkspace } from "../data/navigation.ts";
import { isActiveJob, type DashboardJob, type JobKind } from "../../../src/dashboard/jobs/types.ts";
import type { JobControls } from "../data/jobs.ts";

const TITLE: Record<JobKind, string> = {
  compare: "Comparison",
  explain: "Detailed explanation",
  scenarios: "Scenarios",
  check: "Check",
};

export function JobCard({ jobs, onOpen }: { jobs: JobControls; onOpen: (job: DashboardJob) => void }) {
  const sample = isSampleWorkspace();
  const { job } = jobs;
  if (!job && !jobs.error && (!jobs.busy || jobs.checking)) return null;
  const active = isActiveJob(job);
  const progress = job?.progress;
  const determinate =
    (active || job?.status === "complete") &&
    progress?.total != null &&
    progress.total > 0 &&
    progress.completed != null;
  const title = job ? TITLE[job.kind] : "";
  const status =
    job?.status === "running"
      ? "Running"
      : job?.status === "cancelling"
        ? "Stopping"
        : job?.status === "complete"
          ? sample
            ? "Loaded"
            : "Complete"
          : job?.status === "skipped"
            ? "Skipped"
            : job?.status === "blocked"
              ? "Blocked"
              : job?.status === "cancelled"
                ? "Cancelled"
                : "Failed";
  return (
    <section className="dashboard-card job-card" aria-label="Job status">
      <div className="job-main">
        <span className={`status-dot ${job?.status ?? ""}`} aria-hidden="true" />
        <div className="job-details">
          <h2>
            {job ? `${title} · ${status}` : jobs.error ? "Job status unknown" : "Another local operation is running"}
          </h2>
          {(job?.dir || job?.resultDir) && <code>.agentdiff/{job.resultDir ?? job.dir}/</code>}
          <p role="status">
            {job
              ? active
                ? job.status === "cancelling"
                  ? "Stopping the worker…"
                  : progress?.message
                : job.message
              : jobs.error
                ? "New jobs can start once the server answers."
                : "You can start another job when it finishes."}
          </p>
        </div>
        <div className="job-actions">
          {active && (
            <button
              className="dashboard-button"
              disabled={job?.status === "cancelling"}
              onClick={() => void jobs.cancel()}
            >
              {job?.status === "cancelling" ? "Stopping…" : "Cancel"}
            </button>
          )}
          {!active && job?.resultDir && (
            <button className="dashboard-button" onClick={() => onOpen(job)}>
              Open result →
            </button>
          )}
        </div>
      </div>
      {progress?.completed != null && (
        <div className="job-progress">
          <span>
            {progress.total != null
              ? job?.kind === "scenarios"
                ? `${progress.completed} / ${progress.total} things to cover written`
                : `${progress.completed} / ${progress.total} runs ${job?.status === "cancelled" ? "completed before stopping" : "saved"}`
              : `${progress.completed} discovery runs saved${progress.limit != null ? ` · budget: ${progress.limit} attempts` : ""}`}
          </span>
          {determinate && (
            <div
              role="progressbar"
              aria-label="Saved runs"
              aria-valuenow={progress.completed}
              aria-valuemin={0}
              aria-valuemax={progress.total}
              className="job-track"
            >
              <span style={{ width: `${Math.min(100, (progress.completed / progress.total!) * 100)}%` }} />
            </div>
          )}
        </div>
      )}
      {jobs.error && (
        <p className="job-error" role="alert">
          Could not confirm the latest job status: {jobs.error} Retrying automatically.
        </p>
      )}
    </section>
  );
}
