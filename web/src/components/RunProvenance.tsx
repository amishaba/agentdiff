import { currentPage, isSampleWorkspace } from "../data/navigation.ts";
import { fmtDate } from "../data/derive.ts";
import type { Dataset } from "../data/types.ts";

export function RunProvenance({ data }: { data: Dataset }) {
  const c = data.comparison;
  return (
    <details className="run-provenance">
      <summary>About these results</summary>
      <p>
        {currentPage() === "dashboard" && isSampleWorkspace() ? (
          <>
            Recorded run on real models: the clinic booking assistant in <code>example-clinic/</code>, every test run{" "}
            {c.runsPerTest} times on each version · {fmtDate(c.createdAt)}. Every trace, grade and number here is what
            agentdiff saved. Reset to discard browser edits.
          </>
        ) : data.mode === "demo" ? (
          <>
            Recorded on real models · {c.tests.length} tests × {c.runsPerTest} runs × 2 versions ·{" "}
            {fmtDate(c.createdAt)}. Every number on this page is computed from the saved runs, grades and check answers
            shipped with it
            {data.source?.without?.length
              ? `, leaving out the test${data.source.without.length === 1 ? "" : "s"} ${data.source.without.join(", ")}`
              : ""}
            . Baked with <code>scripts/bake-example.ts</code>.
          </>
        ) : (
          <>
            Results stored locally in <code>.agentdiff/{data.dir}/</code> · {fmtDate(c.createdAt)}.
          </>
        )}
      </p>
    </details>
  );
}
