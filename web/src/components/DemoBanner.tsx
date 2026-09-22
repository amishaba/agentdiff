import { appFetch } from "../data/request.ts";

export function DemoBanner() {
  async function reset() {
    await appFetch("/api/demo/reset", { method: "POST" });
    const url = new URL(location.href);
    url.searchParams.delete("dir");
    url.searchParams.delete("draft");
    location.assign(url);
  }
  return (
    <aside className="sample-banner" aria-label="Recorded run">
      <div>
        <strong>Recorded run</strong>
        <p>
          Real results from one agentdiff run on an example clinic booking assistant. Buttons load the saved results;
          edits stay in this browser tab. Nothing runs here.
        </p>
      </div>
      <button className="dashboard-button" onClick={() => void reset()}>
        Reset
      </button>
    </aside>
  );
}
