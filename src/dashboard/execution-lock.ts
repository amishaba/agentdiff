// Dashboard jobs and project edits share one execution slot in the local server.
let owner: string | null = null;
export function claimExecution(id: string): () => void {
  if (owner) throw new Error("Another job is running. Wait for it to finish or cancel it first.");
  owner = id;
  return () => {
    if (owner === id) owner = null;
  };
}
export function executionBusy(): boolean {
  return owner !== null;
}
