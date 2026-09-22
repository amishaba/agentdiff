import { canonical } from "../lib/canonical.ts";
import { stepLabel } from "../compare/steps.ts";
import type { VersionStats } from "../types.ts";
import type { DiscoveryResult, Pattern } from "./types.ts";

function text(value: string, max = 1_000): string {
  return (value.length > max ? value.slice(0, max) + "…" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_{}[\]()#+!|]/g, "\\$&")
    .replace(/\r?\n/g, " ");
}

export function patternText(pattern: Pattern, args: boolean): string {
  return pattern.calls.length
    ? pattern.calls.map((call) => `${stepLabel(call.tool)}${args ? `(${canonical(call.input)})` : ""}`).join(" → ")
    : "answered without tools";
}

/** Top-level context keys whose values differ between the two cases. */
function changedContext(a?: Record<string, unknown>, b?: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  return [...keys].filter((k) => canonical((a ?? {})[k] ?? null) !== canonical((b ?? {})[k] ?? null));
}

/** " · failure_type: none 3/3 → unwanted_reply 3/3", from each side's most common answer. */
function failureLine(o: VersionStats, n: VersionStats): string {
  const top = (s: VersionStats) => {
    const f = s.checks?.failure_type;
    if (!f || f.kind !== "choice" || !f.of) return null;
    const [choice, count] = Object.entries(f.counts).sort((x, y) => y[1] - x[1])[0];
    return `${choice} ${count}/${f.of}`;
  };
  const a = top(o),
    b = top(n);
  return a && b && a !== b ? ` · failure_type: ${a} → ${b}` : "";
}

export function discoveryReport(result: DiscoveryResult): string {
  const lines = [
    "### Discovered behavior changes",
    "",
    `${result.findings.length} reproduced finding(s) · ${result.agentRuns} discovery agent runs · ${result.plannerCalls} planning calls · ${result.status}`,
    "",
  ];
  if (result.reason) lines.push(text(result.reason), "");
  if (!result.findings.length)
    lines.push(
      "No repeatable behavior difference was confirmed in the tested scenarios. This does not establish that all behavior is unchanged.",
      "",
    );
  for (const finding of result.findings) {
    lines.push(`**${finding.id}: ${text(finding.probe.name, 120)}**`, "");
    lines.push(`Hypothesis tested: ${text(finding.probe.hypothesis, 600)}`, "");
    lines.push(
      `Change examined: ${text(finding.probe.changeId, 200)} · ${finding.probe.strategy}${finding.shortened ? " · shortened reproducer" : ""}`,
      "",
    );
    if (finding.probe.baseTest) lines.push(`Starts from the test: ${text(finding.probe.baseTest, 200)}`, "");
    const contextChange = changedContext(finding.cases[0].context, finding.cases[1].context);
    for (let i = 0; i < finding.cases.length; i++) {
      const c = finding.cases[i];
      lines.push(
        `- ${i === 0 ? "Control" : "Variant"}: ${text(c.input)}${contextChange.length ? ` · ${contextChange.map((k) => `${text(k, 80)} = ${text(JSON.stringify((c.context ?? {})[k] ?? null), 80)}`).join(", ")}` : ""}`,
      );
      if (c.expected) lines.push(`  - Should: ${text(c.expected, 400)}`);
      const judged = finding.judged?.[i];
      if (judged && finding.kinds?.[i])
        lines.push(
          `  - Judged: ${finding.kinds[i]}${judged.old.avgGrade != null && judged.new.avgGrade != null ? ` · grade ${judged.old.avgGrade.toFixed(1)} → ${judged.new.avgGrade.toFixed(1)}` : ""}${failureLine(judged.old, judged.new)}`,
        );
      const d = c.difference;
      if (finding.reproducedCases.includes(i) && d) {
        lines.push(
          `  - Before: ${text(patternText(d.old, d.kind === "arguments"))} (${d.old.count}/${d.old.total} fresh runs)`,
        );
        lines.push(
          `  - After: ${text(patternText(d.new, d.kind === "arguments"))} (${d.new.count}/${d.new.total} fresh runs)`,
        );
      } else {
        const errors = [...c.old, ...c.new].filter((r) => r.error !== null).length;
        lines.push(
          `  - ${errors ? `${errors} execution error(s); this case is inconclusive.` : "No screening difference reproduced for this case."}`,
        );
      }
    }
    lines.push(
      "",
      `Full evidence: discovery/experiments/${finding.experimentId}.json. Draft inputs: discovery/drafts/${finding.id}-control.json and ${finding.id}-variant.json.`,
      "",
    );
  }
  lines.push(
    "Each case is judged against what the planner said the agent should do there. A finding is confirmed on fresh runs, and kept when at least 80% of them show the same pattern.",
    "",
  );
  if (result.notices.length) {
    lines.push("<details>", "<summary>Discovery limits and inconclusive experiments</summary>", "");
    for (const notice of result.notices.slice(0, 12)) lines.push(`- ${text(notice, 400)}`);
    lines.push("", "</details>", "");
  }
  return lines.join("\n");
}
