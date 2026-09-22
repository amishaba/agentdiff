// One row per check or Jev decision a test asked about, old vs new, and which
// rows moved. The report's and dashboard's check tables read these. Browser-safe.
import { isBuiltInCheck, type DecisionStats, type TestComparison } from "../types.ts";

export interface CheckRow {
  id: string;
  question: string;
  kind: "yes_no" | "choice";
  /** Asked of every run by agentdiff, not written in the test. */
  builtIn: boolean;
  /** "4/5" (runs answering yes), or "refunded 4/5" (runs picking that option). */
  old: string;
  new: string;
  shifted: boolean;
}

const points = (a: number, b: number) => Math.abs(Math.round((a - b) * 100));

/**
 * How many of `runs` judge answers have to differ before it counts as a
 * change: two once there are four runs or more, one with fewer. A judge
 * answering one run differently is how a judge varies, not a change.
 */
export const answersToCount = (runs: number) => Math.max(1, Math.min(2, Math.floor(runs / 2)));

/** Moved 20+ points, and by `answersToCount` runs of the smaller side. */
function movedEnough(before: number, after: number, oldRuns: number, newRuns: number): boolean {
  const fewer = Math.min(oldRuns, newRuns);
  const runs = Math.abs(after - before) * fewer;
  return points(before, after) >= 20 && runs + 1e-9 >= answersToCount(fewer);
}

/**
 * Every outcome check answered on both sides, old → new. A check shifted when
 * its yes rate, or any option's share, moved by at least 20% of runs (the
 * same bar as tool call rates) and by `answersToCount` runs. A choice shows
 * the option that moved most, or the most common one when nothing moved.
 */
export function checkRows(t: TestComparison): CheckRow[] {
  const rows: CheckRow[] = [];
  for (const [id, o] of Object.entries(t.old.checks ?? {})) {
    const n = t.new.checks?.[id];
    if (!n || !o.of || !n.of) continue;
    if (o.kind === "yes_no" && n.kind === "yes_no") {
      rows.push({
        id,
        question: o.question,
        kind: "yes_no",
        builtIn: isBuiltInCheck(id),
        old: `${o.yes}/${o.of}`,
        new: `${n.yes}/${n.of}`,
        shifted: movedEnough(o.yes / o.of, n.yes / n.of, o.of, n.of),
      });
    } else if (o.kind === "choice" && n.kind === "choice") {
      const move = (opt: string) => points((o.counts[opt] ?? 0) / o.of, (n.counts[opt] ?? 0) / n.of);
      const grew = (opt: string) => (n.counts[opt] ?? 0) / n.of > (o.counts[opt] ?? 0) / o.of;
      // On a tie, show the option that grew: "skipped_step 0/5 → 3/5" says more than "none 5/5 → 2/5".
      // A failure type names the failure, whichever way it moved: "wrong_order 1/5 → 0/5", not "none 4/5 → 5/5".
      const candidates =
        id === "failure_type" && o.options.some((x) => x !== "none" && move(x) > 0)
          ? o.options.filter((x) => x !== "none")
          : o.options;
      const moved = candidates.reduce((a, b) =>
        move(b) > move(a) || (move(b) === move(a) && grew(b) && !grew(a)) ? b : a,
      );
      const shifted = movedEnough((o.counts[moved] ?? 0) / o.of, (n.counts[moved] ?? 0) / n.of, o.of, n.of);
      const opt = shifted ? moved : o.options.reduce((a, b) => ((n.counts[b] ?? 0) > (n.counts[a] ?? 0) ? b : a));
      rows.push({
        id,
        question: o.question,
        kind: "choice",
        builtIn: isBuiltInCheck(id),
        old: `${opt} ${o.counts[opt] ?? 0}/${o.of}`,
        new: `${opt} ${n.counts[opt] ?? 0}/${n.of}`,
        shifted,
      });
    }
  }
  return rows;
}

export function checkShifts(t: TestComparison): CheckRow[] {
  return checkRows(t).filter((r) => r.shifted);
}

/** The rows worth showing: every check the test wrote, and built-in ones only when they moved. */
export function shownCheckRows(t: TestComparison): CheckRow[] {
  return checkRows(t).filter((r) => r.shifted || !r.builtIn);
}

export interface DecisionRow {
  id: string;
  source?: DecisionStats["source"];
  type: DecisionStats["type"];
  /** Runs that asked it, e.g. "5/5". */
  asked: { old: string; new: string };
  /** "yes 4/5", "refunded 3/5", "avg 2.4", or "not asked". */
  answer: { old: string; new: string };
  /** The question's wording on each side, when it changed. */
  reworded: { old: string; new: string } | null;
  /** The share of runs asking it moved 20+ points, or only one side asked it. */
  askShifted: boolean;
  shifted: boolean;
}

function answerText(d: DecisionStats | undefined, option?: string): string {
  if (!d) return "not asked";
  if (d.type === "boolean") return `${d.source === "guardrail" ? "tripped" : "yes"} ${d.yes ?? 0}/${d.asks}`;
  if (d.type === "choice") return `${option} ${d.counts?.[option!] ?? 0}/${d.asks}`;
  return `avg ${(d.meanScore ?? 0).toFixed(1)}`;
}

/**
 * Jev questions the agent under test asked, old → new. A decision shifted when
 * it is asked on one side only, when the share of runs asking it moves 20+
 * points, when its yes rate or an option's share moves 20+ points, or when its
 * mean score moves a full level. Rewording is reported, not counted: it is the
 * likely cause, not a behavior change.
 */
export function decisionRows(t: TestComparison): DecisionRow[] {
  const ids = [...new Set([...Object.keys(t.old.decisions ?? {}), ...Object.keys(t.new.decisions ?? {})])];
  return ids.map((id) => {
    const o = t.old.decisions?.[id];
    const n = t.new.decisions?.[id];
    const runsO = o?.runs ?? t.old.runs - t.old.errors;
    const runsN = n?.runs ?? t.new.runs - t.new.errors;
    const askedO = o?.runsAsking ?? 0;
    const askedN = n?.runsAsking ?? 0;
    const askShifted = !o || !n || (runsO > 0 && runsN > 0 && points(askedO / runsO, askedN / runsN) >= 20);
    let shifted = askShifted;
    let option: string | undefined;
    if (o && n && o.type === n.type) {
      if (o.type === "boolean") shifted ||= points((o.yes ?? 0) / o.asks, (n.yes ?? 0) / n.asks) >= 20;
      if (o.type === "choice") {
        const options = [...new Set([...Object.keys(o.counts ?? {}), ...Object.keys(n.counts ?? {})])];
        const move = (opt: string) => points((o.counts?.[opt] ?? 0) / o.asks, (n.counts?.[opt] ?? 0) / n.asks);
        option = options.reduce((a, b) => (move(b) > move(a) ? b : a));
        shifted ||= move(option) >= 20;
      }
      if (o.type === "score") shifted ||= Math.abs((n.meanScore ?? 0) - (o.meanScore ?? 0)) >= 1;
    }
    const only = o ?? n!;
    if (only.type === "choice" && !option)
      option = Object.entries(only.counts ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0];
    return {
      id,
      ...(only.source ? { source: only.source } : {}),
      type: only.type,
      asked: { old: `${askedO}/${runsO}`, new: `${askedN}/${runsN}` },
      answer: { old: answerText(o, option), new: answerText(n, option) },
      reworded: o && n && o.instructions !== n.instructions ? { old: o.instructions, new: n.instructions } : null,
      askShifted,
      shifted,
    };
  });
}

/** Shifted checks that count as a behaviour change: not ones the agent only has in one version. */
export function decisionShifts(t: TestComparison): DecisionRow[] {
  const oneSided = new Set(t.oneSidedChecks ?? []);
  return decisionRows(t).filter((r) => r.shifted && !oneSided.has(r.id));
}
