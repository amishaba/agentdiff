export function fail(message: string): never {
  // The CLI owns exit handling; callers in isolated dashboard workers need a
  // structured failure and finally blocks (worktree/staging cleanup) to run.
  throw new Error(message);
}

export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
