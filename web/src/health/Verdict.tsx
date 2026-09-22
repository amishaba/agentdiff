import { HEALTH_LABEL, type HealthStatus } from "../../../src/health/types.ts";

/** A verdict in the change-kind colours: a broken rule is red, low orange, unpredictable amber, steady green. */
const COLOUR: Record<HealthStatus, string> = {
  error: "error",
  rule: "rule",
  low: "worse",
  unsteady: "inconclusive",
  steady: "better",
};

export function Verdict({ status }: { status: HealthStatus }) {
  return (
    <span className="badge" data-kind={COLOUR[status]}>
      {HEALTH_LABEL[status]}
    </span>
  );
}
