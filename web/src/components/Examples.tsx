import { useEffect } from "react";
import { currentExample } from "../data/examples.ts";
import { useExample } from "../data/queries.ts";
import { AppShell } from "./AppShell.tsx";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { RunProvenance } from "./RunProvenance.tsx";
import { Review } from "../review/Review.tsx";

/** A recorded comparison, shown on the same page as your own runs. */
export function Examples() {
  const example = currentExample();
  const { data, isError } = useExample(example.name);
  useEffect(() => {
    const previous = document.title;
    document.title = `agentdiff · ${example.title}`;
    return () => {
      document.title = previous;
    };
  }, [example.title]);
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
      {isError && <p role="alert">This example couldn’t load. Refresh the page to try again.</p>}
      {!data && !isError && (
        <p role="status" className="state dim">
          Loading the recording…
        </p>
      )}
      {data && (
        <ErrorBoundary label="This recording" resetKey={example.name}>
          <Review data={data} />
        </ErrorBoundary>
      )}
      {data && <RunProvenance data={data} />}
    </AppShell>
  );
}
