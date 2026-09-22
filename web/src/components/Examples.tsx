import { useEffect, useMemo, useState } from "react";
import { currentExample, loadExample } from "../data/examples.ts";
import { AppShell } from "./AppShell.tsx";
import { TraceDrawer } from "./TraceDrawer.tsx";
import { RunProvenance } from "./RunProvenance.tsx";
import { Review } from "../review/Review.tsx";
import { sortedTests } from "../data/derive.ts";
import type { Dataset, RunRef } from "../data/types.ts";

/** A recorded comparison, shown on the same page as your own runs. */
export function Examples() {
  const example = currentExample();
  const [data, setData] = useState<Dataset | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<RunRef | null>(null);
  useEffect(() => {
    const previous = document.title;
    document.title = `agentdiff · ${example.title}`;
    return () => {
      document.title = previous;
    };
  }, [example.title]);
  useEffect(() => {
    let cancelled = false;
    loadExample(example.name)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setError("This example couldn’t load. Refresh the page to try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [example.name]);
  const tests = useMemo(() => (data ? sortedTests(data.comparison) : []), [data]);
  return (
    <AppShell
      place={{ kind: "example", name: example.name }}
      crumbs={["Recorded examples", example.title]}
      actions={<span className="header-badge">Read-only recording</span>}
    >
      <p className="examples-change">
        <span>The change: </span>
        {example.change}
      </p>
      {error && <p role="alert">{error}</p>}
      {!data && !error && (
        <p role="status" className="state dim">
          Loading the recording…
        </p>
      )}
      {data && <Review data={data} onOpen={setOpen} />}
      {data && <RunProvenance data={data} />}
      {data && open && (
        <TraceDrawer data={data} tests={tests} sel={open} onSelect={setOpen} onClose={() => setOpen(null)} />
      )}
    </AppShell>
  );
}
