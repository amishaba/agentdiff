import type { RunSummary } from "../data/types.ts";

export function RunToolbar({
  runs,
  dir,
  onPick,
  onCompare,
}: {
  runs: RunSummary[];
  dir?: string;
  onPick: (dir: string) => void;
  onCompare?: () => void;
}) {
  return (
    <div className="run-toolbar">
      {(runs.length > 0 || dir) && (
        <label className="runpick">
          <span>Comparison</span>
          <select value={dir ?? runs[0]?.dir} onChange={(event) => onPick(event.target.value)}>
            {dir && !runs.some((run) => run.dir === dir) && <option value={dir}>{dir}</option>}
            {runs.map((run) => (
              <option key={run.dir} value={run.dir}>
                {run.label}
                {run.agentName ? ` · ${run.agentName}` : ""}
                {run.changed != null && run.tests != null ? ` · ${run.changed}/${run.tests} changed` : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      {onCompare && (
        <div className="execution-actions">
          <button className="dashboard-button primary" onClick={onCompare}>
            New comparison
          </button>
        </div>
      )}
    </div>
  );
}
