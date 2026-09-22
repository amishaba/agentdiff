import type { FailedSide } from "../../../src/compare/signals.ts";

export function ComparisonFailure({ sides }: { sides: FailedSide[] }) {
  return (
    <section className="comparison-failure" role="alert">
      <span className="failure-label">comparison failed</span>
      <h1>Comparison could not complete</h1>
      <p>
        Every run of{" "}
        {sides.length === 2
          ? "both versions"
          : sides[0]?.side === "old"
            ? "the original agent (v1)"
            : "the updated agent (v2)"}{" "}
        ended in an error, so behaviour changes can’t be measured. This is not a “0 changes” result.
      </p>
      {sides.map((side) => (
        <div key={side.side}>
          <p>
            <strong>{side.side === "old" ? "Original agent · v1" : "Updated agent · v2"}</strong> · {side.runs} of{" "}
            {side.runs} runs failed
          </p>
          <pre>{side.error ?? "Error details unavailable"}</pre>
        </div>
      ))}
    </section>
  );
}
