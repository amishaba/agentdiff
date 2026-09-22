import type { RunRecord, RunRef } from "../data/types.ts";
import type { ChangeKind } from "../../../src/compare/change-kind.ts";
import { runMarks, type RunMark, type Shift } from "./groups.ts";

const SAID: Record<RunMark, string> = { hit: "yes", miss: "no", error: "errored" };

/**
 * A shift's "0/10 → 10/10" as two rows of squares, one per run, filled where the
 * run counts. With `onOpen`, each square opens that run's trace.
 */
export function RunStrip({
  shift,
  kind,
  old,
  neu,
  onOpen,
}: {
  shift: Shift;
  kind: ChangeKind;
  old: RunRecord[];
  neu: RunRecord[];
  onOpen?: (ref: RunRef) => void;
}) {
  const hit = shift.hit;
  if (!hit) return null;
  const sides = [
    { who: "old", runs: old, rate: shift.old },
    { who: "new", runs: neu, rate: shift.new },
  ];
  return (
    <div className={`run-strip${onOpen ? " open" : ""}`} data-kind={kind}>
      {sides.map((s) => (
        <div
          key={s.who}
          className="rs-row"
          role={onOpen ? "group" : "img"}
          aria-label={`${s.who} agent: ${shift.metric} in ${s.rate} runs`}
        >
          <span className="rs-side">{s.who}</span>
          <span className="rs-cells">
            {runMarks(s.runs, hit).map(({ run: r, mark }) => {
              const title = `${s.who} run ${r.run}: ${shift.metric}: ${SAID[mark]}`;
              return onOpen ? (
                <button
                  key={r.run}
                  data-mark={mark}
                  title={`${title}. Open its trace`}
                  aria-label={title}
                  onClick={() => onOpen({ test: r.test, version: r.version, run: r.run })}
                />
              ) : (
                <i key={r.run} data-mark={mark} title={title} />
              );
            })}
          </span>
          <span className="rs-n">{s.rate}</span>
        </div>
      ))}
    </div>
  );
}
