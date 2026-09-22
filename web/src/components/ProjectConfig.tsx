import { isSampleWorkspace } from "../data/navigation.ts";
import { useEffect, useState } from "react";
import { ConfigSchema, type Config } from "../../../src/types.ts";
import { DiscoveryConfigSchema, type DiscoveryConfig } from "../../../src/discovery/types.ts";
import type { ProjectState } from "../../../src/dashboard/project/types.ts";
import { localJson } from "../data/jobs.ts";

const defaults = () => DiscoveryConfigSchema.parse({});
const limits = [
  ["maxCandidates", "Candidates", 1, 30],
  ["maxRounds", "Rounds", 1, 5],
  ["confirmationRuns", "Confirmation runs", 3, 10],
  ["maxFindings", "Max findings", 1, 10],
  ["timeoutMs", "Timeout (ms)", 100, 120000],
  ["maxSteps", "Max steps", 1, 50],
] as const;
export function ProjectConfig({
  project,
  busy,
  onSaved,
}: {
  project: ProjectState;
  busy: boolean;
  onSaved: () => Promise<void>;
}) {
  const sample = isSampleWorkspace();
  const [config, setConfig] = useState<Config>(project.config);
  const [revision, setRevision] = useState(project.revision);
  const [original, setOriginal] = useState(project.config);
  const [mode, setMode] = useState(project.config.agentPath ? "single" : "pair");
  const [saving, setSaving] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const dirty = JSON.stringify(config) !== JSON.stringify(original);
  // Only a newly loaded source revision may replace a clean form. Finishing a
  // save must not reset it to the old props while the refresh is still pending.
  useEffect(() => {
    if (!dirty) {
      setConfig(project.config);
      setOriginal(project.config);
      setRevision(project.revision);
    }
  }, [project.revision]);
  const stale = dirty && revision !== project.revision;
  const update = <K extends keyof Config>(key: K, value: Config[K]) => {
    setConfig((c) => ({ ...c, [key]: value }));
    setMessage("");
    setError("");
  };
  const updateDiscovery = <K extends keyof DiscoveryConfig>(key: K, value: DiscoveryConfig[K]) =>
    update("discovery", { ...(config.discovery ?? defaults()), [key]: value });
  const discard = () => {
    setConfig(project.config);
    setOriginal(project.config);
    setRevision(project.revision);
    setError("");
    setMessage("");
  };
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setMessage("");
    const parsed = ConfigSchema.safeParse(config);
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => `${i.path.join(".") || "Configuration"}: ${i.message}`).join("; "));
      return;
    }
    setSaving(true);
    try {
      const next = await localJson<{ config: Config; revision: string }>("/api/project/config", {
        revision,
        config: parsed.data,
      });
      setConfig(next.config);
      setOriginal(next.config);
      setRevision(next.revision);
      setMessage(sample ? "Settings saved in this browser tab." : `Saved to ${project.configFile}.`);
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  const discovery = config.discovery ?? defaults();
  return (
    <form className="dashboard-card project-config" onSubmit={(event) => void save(event)} noValidate>
      <header className="project-card-heading">
        <h2>Configuration</h2>
        <code>{project.configFile}</code>
      </header>
      <fieldset className="project-fields" disabled={saving || !project.editable}>
        <label className="execution-field">
          Agent export name
          <input value={config.agent} onChange={(e) => update("agent", e.target.value)} />
        </label>
        <div className="project-agent-fields">
          <span className="field-label">Agent file</span>
          <div className="explanation-switch" role="group" aria-label="Agent file settings">
            <button type="button" aria-pressed={mode === "single"} onClick={() => setMode("single")}>
              One file (git)
            </button>
            <button type="button" aria-pressed={mode === "pair"} onClick={() => setMode("pair")}>
              Old / new files
            </button>
          </div>
          {mode === "single" ? (
            <>
              <label className="execution-checkbox">
                <input
                  type="checkbox"
                  checked={config.agentPath !== undefined}
                  onChange={(e) => update("agentPath", e.target.checked ? "" : undefined)}
                />
                <span>Enable Git comparisons</span>
              </label>
              {config.agentPath !== undefined && (
                <label className="execution-field">
                  Agent file for Git comparisons
                  <input value={config.agentPath} onChange={(e) => update("agentPath", e.target.value)} />
                </label>
              )}
            </>
          ) : (
            <>
              <label className="execution-checkbox">
                <input
                  type="checkbox"
                  checked={!!config.versions}
                  onChange={(e) => update("versions", e.target.checked ? { old: "", new: "" } : undefined)}
                />
                <span>Enable an old / new file pair</span>
              </label>
              {config.versions && (
                <div className="project-pair">
                  <label className="execution-field">
                    Old agent file
                    <input
                      value={config.versions.old}
                      onChange={(e) => update("versions", { ...config.versions!, old: e.target.value })}
                    />
                  </label>
                  <label className="execution-field">
                    New agent file
                    <input
                      value={config.versions.new}
                      onChange={(e) => update("versions", { ...config.versions!, new: e.target.value })}
                    />
                  </label>
                </div>
              )}
            </>
          )}
          {config.agentPath !== undefined && config.versions && (
            <p className="dashboard-note">Both options are configured. Each keeps its own file settings.</p>
          )}
        </div>
        <div className="project-test-fields">
          <label className="execution-field">
            Test directory
            <input value={config.tests} onChange={(e) => update("tests", e.target.value)} />
          </label>
          <label className="execution-field">
            Runs per test
            <input
              type="number"
              min={1}
              step={1}
              value={Number.isNaN(config.runsPerTest) ? "" : config.runsPerTest}
              onChange={(e) => update("runsPerTest", e.target.value === "" ? NaN : Number(e.target.value))}
            />
          </label>
        </div>
        <details className="project-discovery">
          <summary>Discovery defaults</summary>
          <div>
            <label className="execution-field">
              Fixture module
              <input
                value={discovery.fixtures ?? ""}
                onChange={(e) => updateDiscovery("fixtures", e.target.value || undefined)}
              />
              <span>Executable tool handlers that can keep state between calls.</span>
            </label>
            <label className="execution-field">
              Context
              <textarea
                rows={2}
                value={discovery.context}
                onChange={(e) => updateDiscovery("context", e.target.value)}
              />
            </label>
            <label className="execution-field">
              Max agent runs
              <input
                type="number"
                min={20}
                max={500}
                value={Number.isNaN(discovery.maxAgentRuns) ? "" : discovery.maxAgentRuns}
                onChange={(e) => updateDiscovery("maxAgentRuns", e.target.value === "" ? NaN : Number(e.target.value))}
              />
              <span>Agent attempts, not dollars or tool calls.</span>
            </label>
            <div className="project-pair">
              {limits.map(([key, label, min, max]) => (
                <label className="execution-field" key={key}>
                  {label}
                  <input
                    type="number"
                    min={min}
                    max={max}
                    value={Number.isNaN(discovery[key]) ? "" : discovery[key]}
                    onChange={(e) => updateDiscovery(key, e.target.value === "" ? NaN : Number(e.target.value))}
                  />
                </label>
              ))}
            </div>
          </div>
        </details>
        <p className="dashboard-note">
          {sample
            ? "Try editing the configuration. Changes stay in this browser tab."
            : "Changes are validated and saved to the config file. Comments and other code are kept."}
        </p>
      </fieldset>
      {!project.editable && (
        <p className="project-notice" role="status">
          {project.editReason}
        </p>
      )}
      {stale && dirty && (
        <p className="project-notice" role="status">
          The config changed on disk. Discard these edits to load the latest settings.
        </p>
      )}
      {error && (
        <p className="project-notice job-error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="project-notice green" role="status">
          {message}
        </p>
      )}
      <footer className="project-card-footer">
        <button type="button" className="dashboard-button" disabled={!dirty || saving} onClick={discard}>
          Discard
        </button>
        <button className="dashboard-button primary" disabled={!dirty || busy || saving || !project.editable || stale}>
          {saving ? "Saving…" : sample ? "Save in this tab" : "Save to config"}
        </button>
      </footer>
    </form>
  );
}
