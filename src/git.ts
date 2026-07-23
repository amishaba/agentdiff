import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rmSync } from "node:fs";
import path from "node:path";
import { AGENTDIFF_DIR, rm } from "./storage.ts";

const exec = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    return (await git(["rev-parse", "--is-inside-work-tree"], cwd)) === "true";
  } catch {
    return false;
  }
}

/** Absolute path to the repository's top level. */
export async function repoRoot(cwd: string): Promise<string> {
  return git(["rev-parse", "--show-toplevel"], cwd);
}

/** True if `ref` resolves to a commit. */
export async function refExists(ref: string, cwd: string): Promise<boolean> {
  try {
    await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd);
    return true;
  } catch {
    return false;
  }
}

/** True if `relPath` (relative to the repo root) exists at `ref`. */
export async function fileExistsAtRef(ref: string, relPath: string, cwd: string): Promise<boolean> {
  const posix = relPath.split(path.sep).join("/");
  try {
    await git(["cat-file", "-e", `${ref}:${posix}`], cwd);
    return true;
  } catch {
    return false;
  }
}

export interface Worktree {
  /** Absolute path to the checked-out worktree. */
  dir: string;
  /** Remove the worktree and prune git's bookkeeping. Safe to call more than once. */
  cleanup: () => Promise<void>;
}

/**
 * Check `ref` out into a throwaway worktree under `<repoRoot>/.agentdiff/`.
 *
 * It lives inside the repo (not the OS temp dir) on purpose: Node resolves the
 * old agent's imports (@mastra/core, the provider SDK, ...) by walking up to the
 * repo root's node_modules, which only works if the checkout is nested under it.
 */
export async function addWorktree(ref: string, cwd: string): Promise<Worktree> {
  const root = await repoRoot(cwd);
  const dir = path.join(root, AGENTDIFF_DIR, `worktree-${Date.now()}`);
  // --detach avoids "ref is already checked out" when comparing against the
  // branch you're currently on (e.g. `agentdiff compare main` while on main).
  await git(["worktree", "add", "--detach", dir, ref], root);

  // A fatal import error calls process.exit(), which skips finally blocks, so
  // also remove the checkout synchronously on exit. cleanup() handles the happy
  // path (and de-registers this listener).
  const onExit = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  };
  process.once("exit", onExit);

  return {
    dir,
    cleanup: async () => {
      process.removeListener("exit", onExit);
      try {
        await git(["worktree", "remove", "--force", dir], root);
      } catch {
        // Worktree metadata may be gone already; fall through to manual cleanup.
      }
      await rm(dir);
      try {
        await git(["worktree", "prune"], root);
      } catch {
        // Non-fatal.
      }
    },
  };
}
