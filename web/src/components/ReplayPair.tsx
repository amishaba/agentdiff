import { isSampleWorkspace } from "../data/navigation.ts";
import { useEffect, useState } from "react";
import type { Dataset, RunRecord, RunRef } from "../data/types.ts";
import { canonical } from "../data/replay.ts";

export function ReplayPair({ data, sel, onClose }: { data: Dataset; sel: RunRef; onClose: () => void }) {
  const old = data.traces.old.filter((r) => r.test === sel.test);
  const neu = data.traces.new.filter((r) => r.test === sel.test);
  const [left, setLeft] = useState(sel.run);
  const [right, setRight] = useState(sel.run);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const a = old.find((r) => r.run === left) ?? old[0];
  const b = neu.find((r) => r.run === right) ?? neu[0];
  const count = Math.max(a?.tool_calls.length ?? 0, b?.tool_calls.length ?? 0);
  let first = -1;
  for (let i = 0; i < count; i++)
    if (canonical(a?.tool_calls[i]) !== canonical(b?.tool_calls[i])) {
      first = i;
      break;
    }
  const responsesDiffer = a?.final_response !== b?.final_response;
  function column(label: string, runs: RunRecord[], record: RunRecord | undefined, choose: (n: number) => void) {
    return (
      <div className="replay-column">
        <label>
          {label}
          <select value={record?.run ?? ""} onChange={(e) => choose(Number(e.target.value))}>
            {runs.map((r) => (
              <option key={r.run} value={r.run}>
                run {r.run}
              </option>
            ))}
          </select>
        </label>
        {!record ? (
          <p>no run available</p>
        ) : (
          <>
            {record.error && (
              <p role="status">
                {record.replay?.status === "blocked" ? "stopped: this tool needs a response" : record.error}
              </p>
            )}
            {Array.from({ length: count }, (_, i) => (
              <div key={i} className={`replay-call ${i === first ? "first-divergence" : ""}`}>
                <span className="label">
                  {i + 1}
                  {i === first ? " · first difference" : ""}
                </span>
                {record.tool_calls[i] ? (
                  <>
                    <h4>{record.tool_calls[i].tool}</h4>
                    <span className="label">tool input</span>
                    <pre>{JSON.stringify(record.tool_calls[i].input, null, 2)}</pre>
                    <span className="label">response</span>
                    <pre>
                      {record.replay?.missing.some(
                        (m) =>
                          m.tool === record.tool_calls[i].tool &&
                          canonical(m.input) === canonical(record.tool_calls[i].input),
                      )
                        ? "no recorded response for this call"
                        : JSON.stringify(record.tool_calls[i].output, null, 2)}
                    </pre>
                  </>
                ) : (
                  <p className="dim">no call at this step</p>
                )}
              </div>
            ))}
            <div className={`replay-call ${first === -1 && responsesDiffer ? "first-divergence" : ""}`}>
              <span className="label">final response</span>
              <p>{record.final_response ?? "no final response"}</p>
            </div>
          </>
        )}
      </div>
    );
  }
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer replay-drawer" role="dialog" aria-label="Replay comparison" aria-modal="true">
        <div className="drawer-head">
          <div>
            <div className="t">did your changes help?</div>
            <p className="dim">
              {isSampleWorkspace()
                ? "Recorded replay: how a corrected tool sequence differs. Review edits stay in this browser tab."
                : "Both code versions ran the same request using saved tool data. The model generated new answers."}
            </p>
          </div>
          <button onClick={onClose} autoFocus>
            close · esc
          </button>
        </div>
        <div className="drawer-body">
          <p>{a?.input ?? b?.input}</p>
          <p className="dim">
            {first >= 0
              ? `the versions first differ at tool call ${first + 1}`
              : responsesDiffer
                ? "both versions used the same tools and data, but answered differently"
                : "these two runs produced the same result"}
            .{" "}
            {isSampleWorkspace()
              ? "Timings are from the recorded runs."
              : "The timings measure this test, not the original production run."}
          </p>
          <div className="replay-pair">
            {column("earlier code", old, a, setLeft)}
            {column("your current code", neu, b, setRight)}
          </div>
        </div>
      </aside>
    </>
  );
}
