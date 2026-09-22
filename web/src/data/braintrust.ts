import type { Incident } from "../../../src/dashboard/braintrust/scenario.ts";

/** Whether a reviewed incident is in the test suite, and whether that test matches the latest review. */
export function incidentBadge(incident: Incident) {
  if (incident.savedFile && incident.savedRevision === incident.reviewRevision)
    return {
      label: "In your tests",
      tone: "good",
      detail: `Saved as ${incident.savedFile}. Every comparison runs it.`,
    };
  if (incident.savedFile)
    return {
      label: "Test out of date",
      tone: "blocked",
      detail: `${incident.savedFile} was saved from an earlier review. Save it again to update it.`,
    };
  return incident.reviewed
    ? {
        label: "Reviewed",
        tone: "neutral",
        detail: "Expected behaviour has been saved for this run. Add it to your tests to run it in every comparison.",
      }
    : null;
}

export function incidentScore(incident: Incident) {
  const scores = (incident.scores ?? []).filter((s) => Number.isFinite(s.value)).sort((a, b) => a.value - b.value);
  if (!scores.length)
    return {
      label: incident.errorCount ? "error" : "-",
      detail: incident.errorCount
        ? "This trace contains recorded errors; no numeric score was recorded."
        : "No numeric score was recorded.",
    };
  const value = scores[0].value;
  return {
    label: String(value).length > 6 ? value.toPrecision(3) : String(value),
    detail:
      "Lowest recorded score · " + scores.map((s) => s.name + ": " + s.value + " (span " + s.spanId + ")").join(" · "),
  };
}

export function incidentAge(created: string, now = Date.now()) {
  const timestamp = Date.parse(created);
  if (!Number.isFinite(timestamp)) return "Time unavailable";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
  if (seconds < 86400) return Math.floor(seconds / 3600) + "h ago";
  return Math.floor(seconds / 86400) + "d ago";
}
