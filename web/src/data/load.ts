import type { Comparison, Dataset, GradeRecord, Mode, RunRecord, RunSummary } from "./types.ts";
import { currentPage, isSampleWorkspace } from "./navigation.ts";
import { appFetch } from "./request.ts";
import { currentExample, loadExample } from "./examples.ts";

export function currentMode(): Mode {
  // Localhost and the published site share the same landing page. The local
  // working dashboard is an explicit destination, not a different default home.
  return currentPage() === "dashboard" && !isSampleWorkspace() ? "live" : "demo";
}

async function getJson<T>(url: string): Promise<T> {
  const res = await appFetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return (await res.json()) as T;
}

/** Saved local comparisons, or the isolated sample list on the hosted dashboard. */
export async function listRuns(): Promise<RunSummary[]> {
  if (currentPage() !== "dashboard") return [];
  return getJson<RunSummary[]>("/api/runs");
}

export async function loadDataset(dir?: string): Promise<Dataset> {
  if (currentPage() !== "dashboard") {
    // loadExample code-splits each recording, so the live dashboard never downloads them.
    return loadExample(currentExample().name);
  }

  let target = dir;
  if (!target) {
    const runs = await listRuns();
    if (!runs.length) throw new Error("no comparisons yet - run `agentdiff compare` first");
    target = runs[0].dir;
  }
  const q = `?dir=${encodeURIComponent(target)}`;
  const [comparison, grades, traces, explanation] = await Promise.all([
    getJson<Comparison>(`/api/comparison${q}`),
    getJson<GradeRecord[]>(`/api/grades${q}`),
    getJson<{ old: RunRecord[]; new: RunRecord[] }>(`/api/traces${q}`),
    getJson<{ text: string }>(`/api/explanation${q}&kind=short`),
  ]);
  return { mode: currentMode(), dir: target, comparison, grades, traces, explanation: explanation.text ?? "" };
}
