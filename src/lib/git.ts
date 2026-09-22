import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rmSync, symlink } from "node:fs";
import path from "node:path";
import { exists, rm } from "../storage/fs.ts";
import { AGENTDIFF_DIR } from "../storage/workspace.ts";

const exec = promisify(execFile);
const symlinkAsync = promisify(symlink);

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

/**
 * Branches and remote branches for a ref picker, plus HEAD~1/HEAD, with a
 * sensible default. Empty when `cwd` is not a Git repo or has no commits —
 * such a project can still compare versions.old with versions.new.
 */
export async function listRefs(cwd: string): Promise<{ refs: string[]; defaultRef: string }> {
  try {
    await git(["rev-parse", "--verify", "HEAD"], cwd);
    const names = (await git(["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"], cwd))
      .split("\n")
      .filter(Boolean);
    const refs = [...new Set([...names, "HEAD~1", "HEAD"])];
    return { refs, defaultRef: refs.includes("main") ? "main" : refs.includes("origin/main") ? "origin/main" : "HEAD" };
  } catch {
    return { refs: [], defaultRef: "" };
  }
}

/** The branch a change is usually compared against: main or master, local first, else HEAD. */
export async function baseRef(cwd: string): Promise<string> {
  for (const ref of ["main", "master", "origin/main", "origin/master"]) if (await refExists(ref, cwd)) return ref;
  return "HEAD";
}

/** Files under `cwd` that git tracks or would track (untracked but not ignored), relative to `cwd`. */
export async function projectFiles(cwd: string): Promise<string[]> {
  const out = await git(["ls-files", "--cached", "--others", "--exclude-standard", "--", "."], cwd);
  return [...new Set(out.split("\n").filter(Boolean))];
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
 * The checkout has no `node_modules` of its own (git worktrees don't copy
 * ignored files), so we symlink the *live* checkout's `node_modules` into it —
 * both the repo root's and the working directory's (e.g. `example/`). That lets
 * Node resolve the old agent's imports (@mastra/core, the provider SDK, ...)
 * against whatever the current install actually put on disk, instead of relying
 * on those packages happening to be present in the repo-root lockfile.
 */
export async function addWorktree(ref: string, cwd: string): Promise<Worktree> {
  const root = await repoRoot(cwd);
  const dir = path.join(root, AGENTDIFF_DIR, `worktree-${Date.now()}`);
  // --detach avoids "ref is already checked out" when comparing against the
  // branch you're currently on (e.g. `agentdiff compare main` while on main).
  await git(["worktree", "add", "--detach", dir, ref], root);

  // Mirror node_modules from the real checkout so the old agent's imports
  // resolve. We link the working dir's and the root's; dedupe when they're the
  // same (config lives at the repo root). Links are removed before the worktree
  // is (below) so we never delete the real dependency trees they point at.
  const links: string[] = [];
  const rel = path.relative(root, cwd);
  const mirrors: Array<[from: string, to: string]> = [];
  if (rel && rel !== ".") mirrors.push([path.join(cwd, "node_modules"), path.join(dir, rel, "node_modules")]);
  mirrors.push([path.join(root, "node_modules"), path.join(dir, "node_modules")]);
  for (const [from, to] of mirrors) {
    if ((await exists(from)) && !(await exists(to)) && (await exists(path.dirname(to)))) {
      try {
        await symlinkAsync(from, to, "junction");
        links.push(to);
      } catch {
        // Best effort — a missing link just reproduces the old resolution.
      }
    }
  }

  const removeLinks = () => {
    for (const link of links) {
      try {
        // rmSync on a symlink unlinks the link only; it never follows into the
        // real node_modules it points at.
        rmSync(link, { force: true });
      } catch {
        // Best effort.
      }
    }
  };

  // A fatal import error calls process.exit(), which skips finally blocks, so
  // also remove the checkout synchronously on exit. cleanup() handles the happy
  // path (and de-registers this listener).
  const onExit = () => {
    try {
      removeLinks();
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
      // Drop the symlinks before git touches the worktree, so `worktree remove
      // --force` can never traverse into the real node_modules.
      removeLinks();
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
