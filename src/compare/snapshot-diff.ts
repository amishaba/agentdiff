import { diffLines } from "diff";
import type { Snapshot, SnapshotDiff } from "../types.ts";
import { canonical } from "../lib/canonical.ts";

/** Build a compact +/- diff of only the changed lines between two prompts. */
export function diffInstructions(oldText: string, newText: string): string {
  const parts = diffLines(oldText || "", newText || "");
  const out: string[] = [];
  for (const part of parts) {
    if (!part.added && !part.removed) continue;
    const prefix = part.added ? "+ " : "- ";
    for (const line of part.value.split("\n")) {
      if (line.length === 0) continue;
      out.push(prefix + line);
    }
  }
  return out.join("\n");
}

export function diffSnapshots(oldSnap: Snapshot, newSnap: Snapshot): SnapshotDiff {
  const oldTools = new Set(oldSnap.tools);
  const newTools = new Set(newSnap.tools);

  const toolsAdded = newSnap.tools.filter((t) => !oldTools.has(t));
  const toolsRemoved = oldSnap.tools.filter((t) => !newTools.has(t));

  const oldWorkflows = new Set(oldSnap.workflows);
  const newWorkflows = new Set(newSnap.workflows);

  const workflowsAdded = newSnap.workflows.filter((w) => !oldWorkflows.has(w));
  const workflowsRemoved = oldSnap.workflows.filter((w) => !newWorkflows.has(w));

  const keys = new Set([...Object.keys(oldSnap.settings), ...Object.keys(newSnap.settings)]);
  const settingsChanged: SnapshotDiff["settingsChanged"] = [];
  for (const key of keys) {
    const a = oldSnap.settings[key];
    const b = newSnap.settings[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      settingsChanged.push({ key, old: a ?? null, new: b ?? null });
    }
  }

  return {
    instructionsDiff: diffInstructions(oldSnap.instructions, newSnap.instructions),
    toolsAdded,
    toolsRemoved,
    workflowsAdded,
    workflowsRemoved,
    settingsChanged,
    toolDefinitionsChanged:
      oldSnap.toolDefinitions && newSnap.toolDefinitions
        ? [...new Set([...Object.keys(oldSnap.toolDefinitions), ...Object.keys(newSnap.toolDefinitions)])].filter(
            (name) => canonical(oldSnap.toolDefinitions?.[name]) !== canonical(newSnap.toolDefinitions?.[name]),
          )
        : [],
  };
}

/** True when prompt, tools, workflows, settings, and model are identical. */
export function snapshotUnchanged(oldSnap: Snapshot, newSnap: Snapshot): boolean {
  if (oldSnap.model !== newSnap.model) return false;
  const d = diffSnapshots(oldSnap, newSnap);
  return (
    !d.instructionsDiff.trim() &&
    d.toolsAdded.length === 0 &&
    d.toolsRemoved.length === 0 &&
    d.workflowsAdded.length === 0 &&
    d.workflowsRemoved.length === 0 &&
    d.settingsChanged.length === 0 &&
    !d.toolDefinitionsChanged?.length
  );
}
