import type { Comparison, TestComparison } from "../types.ts";
import { discoveryReport } from "../discovery/report.ts";
import {
  type FailedSide,
  failedSides,
  gradeChange,
  sequenceShift,
  confirmedChange,
  noiseLine,
  incompleteStages,
  toolRateShifts,
  forbiddenCalls,
  replyShift,
  checkInventory,
  fmtChecks,
} from "../compare/signals.ts";
import { shownCheckRows, decisionRows } from "../compare/check-rows.ts";
import { fmtMoney, fmtNum } from "../compare/format.ts";
import { sortedTests, changeKind, earlyActions, type ChangeKind } from "../compare/change-kind.ts";
import { chartUrl } from "./chart.ts";
import { overallCost, countSkippedTools, countForbiddenCalls } from "../compare/signals.ts";

// ---------------------------------------------------------------------------
// Markdown report — also the body of the PR comment. One headline, one chart,
// one table; everything a reviewer doesn't need at a glance is folded away.

/** "./agents/support.ts @ daa4581372…" → "./agents/support.ts @ daa4581" */
function shortRef(file: string): string {
  return file.replace(/@ ([0-9a-f]{7})[0-9a-f]{33}\b/, "@ $1");
}

/** "all 35 new runs errored — nothing to compare" */
export function failureHeadline(failed: FailedSide[]): string {
  const runs = failed.reduce((s, f) => s + f.runs, 0);
  const which = failed.length === 2 ? "" : `${failed[0].side} `;
  return `all ${runs} ${which}runs errored — nothing to compare`;
}

function headline(c: Comparison): string {
  const parts: string[] = [];
  const kinds = c.tests.map((t) => changeKind(t, c.writeTools));
  const count = (k: ChangeKind) => kinds.filter((x) => x === k).length;
  const changed = c.tests.filter(confirmedChange).length;
  const byKind = [
    count("rule") && `${count("rule")} broke a rule`,
    count("worse") && `${count("worse")} worse`,
    count("better") && `${count("better")} better`,
  ].filter(Boolean);
  parts.push(
    `${changed} of ${c.tests.length} test${c.tests.length === 1 ? "" : "s"} changed${byKind.length ? `: ${byKind.join(", ")}` : ""}`,
  );
  const unsure = count("inconclusive");
  if (unsure) parts.push(`${unsure} inconclusive`);
  // A reply that got better (someone who needed an answer now gets one) isn't counted with the ones that shouldn't have been sent.
  const replies = c.tests
    .filter((t, i) => kinds[i] !== "better" && kinds[i] !== "inconclusive")
    .map(replyShift)
    .filter((r) => r != null);
  const started = replies.filter((r) => r.started).length;
  const stopped = replies.length - started;
  if (started) parts.push(`started replying in ${started} test${started === 1 ? "" : "s"} it used to leave alone`);
  if (stopped) parts.push(`stopped replying in ${stopped} test${stopped === 1 ? "" : "s"}`);
  const skipped = countSkippedTools(c);
  if (skipped > 0) parts.push(`${skipped} required tool call${skipped === 1 ? "" : "s"} skipped`);
  const forbidden = countForbiddenCalls(c);
  if (forbidden > 0) parts.push(`${forbidden} forbidden tool${forbidden === 1 ? "" : "s"} called more often`);
  const errDelta = c.tests.reduce((s, t) => s + (t.new.errors - t.old.errors), 0);
  if (errDelta > 0) parts.push(`${errDelta} more errored run${errDelta === 1 ? "" : "s"}`);
  const cost = overallCost(c);
  if (cost.pct) parts.push(`cost ${cost.pct}`);
  const inv = checkInventory(c.tests);
  if (inv.removed.length) parts.push(`checks removed: ${inv.removed.map((r) => r.id).join(", ")}`);
  if (inv.added.length) parts.push(`checks added: ${inv.added.map((r) => r.id).join(", ")}`);
  return parts.join(" · ");
}

/** Model, tool, workflow, and setting changes on one line, or null. */
function snapshotLine(c: Comparison): string | null {
  const sd = c.snapshotDiff;
  const parts: string[] = [];
  if (c.oldSnapshot.model !== c.newSnapshot.model)
    parts.push(`model \`${c.oldSnapshot.model}\` → \`${c.newSnapshot.model}\``);
  if (sd.toolsAdded.length) parts.push(`tools added: ${sd.toolsAdded.map((t) => `\`${t}\``).join(", ")}`);
  if (sd.toolsRemoved.length) parts.push(`tools removed: ${sd.toolsRemoved.map((t) => `\`${t}\``).join(", ")}`);
  if (sd.workflowsAdded.length) parts.push(`workflows added: ${sd.workflowsAdded.map((t) => `\`${t}\``).join(", ")}`);
  if (sd.workflowsRemoved.length)
    parts.push(`workflows removed: ${sd.workflowsRemoved.map((t) => `\`${t}\``).join(", ")}`);
  if (sd.toolDefinitionsChanged?.length)
    parts.push(`tool definitions changed: ${sd.toolDefinitionsChanged.map((t) => `\`${t}\``).join(", ")}`);
  for (const s of sd.settingsChanged) parts.push(`${s.key} ${JSON.stringify(s.old)} → ${JSON.stringify(s.new)}`);
  return parts.length ? parts.join(" · ") : null;
}

const cell = (s: string) => s.replace(/\|/g, "\\|");

/** `lookup_customer` 5/5 → **2/5** per required tool, then never `send_sms` 0/5 → **3/5** per forbidden one. */
function toolsCell(t: TestComparison): string {
  const never = t.mustNotCallTools ?? [];
  if (!t.mustCallTools.length && !never.length) return "–";
  const shifted = new Set(toolRateShifts(t));
  const forbidden = new Set(forbiddenCalls(t).map((f) => f.tool));
  const line = (tool: string, bold: boolean) => {
    const o = t.old.toolCallRate[tool];
    const n = t.new.toolCallRate[tool];
    const oTxt = o ? `${o.called}/${o.of}` : "0";
    const nTxt = n ? `${n.called}/${n.of}` : "0";
    return `\`${tool}\` ${oTxt} → ${bold ? `**${nTxt}**` : nTxt}`;
  };
  // A forbidden tool neither version called is fine; only list the ones that were called.
  const called = never.filter(
    (tool) => (t.old.toolCallRate[tool]?.called ?? 0) + (t.new.toolCallRate[tool]?.called ?? 0) > 0,
  );
  const lines = [
    ...t.mustCallTools.map((tool) => line(tool, shifted.has(tool))),
    ...called.map((tool) => `never ${line(tool, forbidden.has(tool))}`),
  ];
  return lines.length ? lines.join("<br>") : "–";
}

/** Write tools whose call rate moved 20+ points, e.g. `charge` 0/3 → **2/3**. */
function writesCell(c: Comparison, t: TestComparison): string {
  const moved = new Set(toolRateShifts(t));
  const rows = (c.writeTools ?? [])
    .filter((tool) => moved.has(tool))
    .map((tool) => {
      const o = t.old.toolCallRate[tool];
      const n = t.new.toolCallRate[tool];
      return `\`${tool}\` ${o ? `${o.called}/${o.of}` : "0"} → **${n ? `${n.called}/${n.of}` : "0"}**`;
    });
  return rows.length ? rows.join("<br>") : "–";
}

/** Old path above new path when the most common sequence moved; "same" otherwise. */
function pathCell(t: TestComparison): string {
  const s = sequenceShift(t);
  if (!s) return "same";
  return `${cell(s.old)}<br>↳ **${cell(s.new)}**`;
}

function gradeCell(t: TestComparison): string {
  const g = gradeChange(t);
  if (!g) return "–";
  const n = fmtNum(g.new);
  return `${fmtNum(g.old)} → ${g.meaningful ? `**${n}**` : n}`;
}

/** `verified_first` 5/5 → **1/5**, one line per outcome check. */
function checksCell(t: TestComparison): string {
  const rows = shownCheckRows(t);
  if (!rows.length) return "–";
  return rows.map((r) => `\`${r.id}\` ${r.old} → ${r.shifted ? `**${r.new}**` : r.new}`).join("<br>");
}

export const MARK: Record<ChangeKind, string> = {
  rule: "🛑",
  worse: "🔻",
  better: "✅",
  different: "•",
  inconclusive: "❔",
  same: "",
};
const LEGEND: Record<ChangeKind, string> = {
  rule: "broke a rule: a forbidden tool, a skipped required tool, or a write tool called more often or without the steps that used to come first",
  worse: "lower grade or more runs with something wrong",
  better: "higher grade or fewer runs with something wrong",
  different: "a different path, same outcome",
  inconclusive: "moved in only one half of the runs, or no more than the old agent moves against itself",
  same: "no change",
};

function testsTable(c: Comparison): string[] {
  const tests = sortedTests(c);
  const graded = tests.some((t) => gradeChange(t) != null);
  const paths = tests.some((t) => sequenceShift(t) != null);
  const checked = tests.some((t) => shownCheckRows(t).length > 0);
  const writes = tests.some((t) => writesCell(c, t) !== "–");
  const replies = tests.some((t) => replyShift(t) != null);
  const head = [
    "test",
    tests.some((t) => t.mustNotCallTools?.length) ? "required and forbidden tools" : "required tools called",
  ];
  if (replies) head.push("replied");
  if (writes) head.push("writes");
  if (paths) head.push("most common path");
  if (checked) head.push("outcome checks");
  if (graded) head.push("grade /5");
  const lines: string[] = [];
  lines.push(`| ${head.join(" | ")} |`);
  lines.push(`|${head.map(() => "---").join("|")}|`);
  for (const t of tests) {
    const kind = changeKind(t, c.writeTools);
    const serious = kind === "rule" || kind === "worse";
    // Forbidden, required and write-tool rates already have their own columns; ordering doesn't.
    const early = earlyActions(t, c.writeTools);
    const row = [
      `${MARK[kind] ? `${MARK[kind]} ` : ""}${serious ? `**${cell(t.test)}**` : cell(t.test)}${early.length ? `<br><sub>${early.map(cell).join("<br>")}</sub>` : ""}`,
      toolsCell(t),
    ];
    if (replies) {
      const r = replyShift(t);
      row.push(
        r
          ? `${r.old} → **${r.new}**`
          : t.new.replied
            ? `${t.old.replied?.runs ?? "?"}/${t.old.replied?.of ?? "?"} → ${t.new.replied.runs}/${t.new.replied.of}`
            : "–",
      );
    }
    if (writes) row.push(writesCell(c, t));
    if (paths) row.push(pathCell(t));
    if (checked) row.push(checksCell(t));
    if (graded) row.push(gradeCell(t));
    lines.push(`| ${row.join(" | ")} |`);
  }
  return lines;
}

/**
 * The checks the agent itself ran (Jev questions, guardrails, its own). Checks
 * it has in only one version are listed once; per test, only checks whose
 * answers or asking moved, or whose question was reworded.
 */
function decisionsTable(c: Comparison): string[] {
  const inv = checkInventory(c.tests);
  const oneSided = new Set([...inv.removed, ...inv.added].map((r) => r.id));
  const tests = sortedTests(c).map((t) => ({
    t,
    rows: decisionRows(t).filter((r) => !oneSided.has(r.id) && (r.shifted || r.reworded)),
  }));
  if (!tests.some((x) => x.rows.length) && !oneSided.size) return [];
  const lines: string[] = ["#### Checks the agent ran", ""];
  if (inv.removed.length) lines.push(`Removed from the agent: ${fmtChecks(inv.removed)}.`, "");
  if (inv.added.length) lines.push(`Added to the agent: ${fmtChecks(inv.added)}.`, "");
  const rows = tests.flatMap((x) => x.rows.map((r) => ({ t: x.t, r })));
  if (rows.length) {
    lines.push("| test | check | runs asking | answers | question |");
    lines.push("|---|---|---|---|---|");
    const bold = (s: string, on: boolean) => (on ? `**${s}**` : s);
    for (const { t, rows: mine } of tests) {
      // Checks one side never reached in this test read as one row: what the other side decided.
      const started = mine.filter((r) => r.answer.old === "not asked");
      const stopped = mine.filter((r) => r.answer.new === "not asked");
      for (const [group, verb, side] of [
        [started, "started asking", "new"],
        [stopped, "stopped asking", "old"],
      ] as const) {
        if (group.length)
          lines.push(
            `| ${cell(t.test)} | ${verb} ${fmtChecks(group)} | ${group[0].asked.old} → **${group[0].asked.new}** | ${group.map((r) => cell(r.answer[side])).join(" · ")} | |`,
          );
      }
      for (const r of mine.filter((row) => !started.includes(row) && !stopped.includes(row))) {
        lines.push(
          `| ${cell(t.test)} | ${fmtChecks([r])} | ${r.asked.old} → ${bold(r.asked.new, r.askShifted)} | ${cell(r.answer.old)} → ${bold(cell(r.answer.new), r.shifted)} | ${r.reworded ? "reworded" : "same"} |`,
        );
      }
    }
  }
  // A question reworded the same way is asked in every test; list each rewording once.
  const reworded = [
    ...new Map(
      rows.flatMap(({ r }) =>
        r.reworded ? [[`${r.id}\n${r.reworded.old}\n${r.reworded.new}`, { id: r.id, ...r.reworded }] as const] : [],
      ),
    ).values(),
  ];
  if (reworded.length) {
    lines.push("", "<details>", `<summary>Reworded questions · ${reworded.length}</summary>`, "");
    for (const q of reworded) lines.push(`- \`${q.id}\`: “${q.old}” → “${q.new}”`);
    lines.push("", "</details>");
  }
  lines.push("");
  return lines;
}

function numbersTable(c: Comparison): string[] {
  const errors = c.tests.some((t) => t.old.errors || t.new.errors);
  const head = ["test", "est. cost", "steps", "latency"];
  if (errors) head.push("errored runs");
  const lines: string[] = [];
  lines.push(`| ${head.join(" | ")} |`);
  lines.push(
    `|---|${head
      .slice(1)
      .map(() => "---:")
      .join("|")}|`,
  );
  const ms = (n: number | null) => (n == null ? "n/a" : n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`);
  for (const t of sortedTests(c)) {
    const row = [
      cell(t.test),
      `${fmtMoney(t.old.avgCost)} → ${fmtMoney(t.new.avgCost)}`,
      `${fmtNum(t.old.avgSteps)} → ${fmtNum(t.new.avgSteps)}`,
      `${ms(t.old.avgLatencyMs)} → ${ms(t.new.avgLatencyMs)}`,
    ];
    if (errors) row.push(`${t.old.errors}/${t.old.runs} → ${t.new.errors}/${t.new.runs}`);
    lines.push(`| ${row.join(" | ")} |`);
  }
  return lines;
}

export interface ReportOptions {
  /** Replaces the old → new file line, e.g. "`main` → this PR" on a pull request. */
  compared?: string;
}

/** Build the markdown report. */
export function buildReport(c: Comparison, explanation: string, opts: ReportOptions = {}): string {
  const lines: string[] = [];
  const failed = failedSides(c);
  lines.push(`## ${failed.length ? failureHeadline(failed) : headline(c)}`);
  lines.push("");
  const compared = opts.compared ?? `\`${shortRef(c.oldFile)}\` → \`${shortRef(c.newFile)}\``;
  const confirmed = c.tests.some((t) => t.confirmation);
  const meta = [c.agentName, compared, `${c.runsPerTest} runs per test${confirmed ? ", checked in two halves" : ""}`];
  // A changed model is listed with the other snapshot changes instead.
  if (c.oldSnapshot.model === c.newSnapshot.model) meta.splice(1, 0, c.newSnapshot.model);
  lines.push(meta.join(" · "));
  const snap = snapshotLine(c);
  if (snap) lines.push(`<br>${snap}`);
  const incomplete = incompleteStages(c);
  if (incomplete) lines.push(`<br>⚠️ incomplete · ${incomplete}`);
  const noise = noiseLine(c);
  if (noise) lines.push(`<br>${noise}`);
  if (c.baseline)
    lines.push(
      `<br>old side · the runs and grades saved in ${c.baseline}; run time isn't compared, since it was measured earlier`,
    );
  lines.push("");

  if (failed.length) {
    // No chart, table, or cause: every number under them would be zero.
    for (const f of failed) {
      lines.push(`> **${f.side} side** · ${f.error ? f.error.trim().split("\n")[0] : "every run errored"}`);
    }
    lines.push("");
  } else {
    const chart = chartUrl(c);
    if (chart) {
      lines.push(`![Tool-usage shape, before vs after](${chart})`);
      lines.push("");
    }

    lines.push(...testsTable(c));
    lines.push("");
    const checksNote = c.tests.some((t) => shownCheckRows(t).length > 0)
      ? ` · outcome checks: runs answering yes, or picking the option shown, judged by ${c.grader === "openai" ? "OpenAI" : "Jev"}; \`failure_type\` and \`acted_before_check\` are asked of every run and shown when they move`
      : "";
    const shown = new Set(c.tests.map((t) => changeKind(t, c.writeTools)));
    const legend = (Object.keys(LEGEND) as ChangeKind[])
      .filter((k) => k !== "same" && shown.has(k))
      .map((k) => `${MARK[k]} ${LEGEND[k]}`)
      .join(" · ");
    lines.push(
      `<sub>${legend}${legend ? " · " : ""}**bold** = beyond noise (20+ points of runs, more than 1 grade point)${checksNote}</sub>`,
    );
    lines.push("");
    lines.push(...decisionsTable(c));

    if (explanation.trim()) {
      lines.push(`> **Likely cause and a fix to try** · ${explanation.trim().split("\n").join("\n> ")}`);
      lines.push("");
    }
  }

  if (c.discovery) lines.push(discoveryReport(c.discovery), "");

  const diff = c.snapshotDiff.instructionsDiff.trim();
  if (diff) {
    const n = diff.split("\n").length;
    lines.push("<details>");
    lines.push(`<summary>Prompt diff · ${n} line${n === 1 ? "" : "s"}</summary>`);
    lines.push("");
    lines.push("```diff\n" + diff + "\n```");
    lines.push("");
    lines.push("</details>");
  } else {
    lines.push("Prompt unchanged.");
  }
  lines.push("");

  if (!failed.length) {
    lines.push("<details>");
    lines.push("<summary>Cost · steps · latency per test</summary>");
    lines.push("");
    lines.push(...numbersTable(c));
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  return lines.join("\n");
}
