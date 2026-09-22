/** Test-only responses for this repo's support example. Discovery itself is domain-independent.
 * A new factory is called for every attempt, for both versions. */
export function createFixtures() {
  return {
    lookup_customer: () => ({ verified: true, name: "Jane Doe" }),
    check_fraud_signals: () => ({ risk: "low", reason: "no unusual signals on this account" }),
    refund_customer: () => ({ status: "refunded" }),
    issue_store_credit: () => ({ status: "credited" }),
    cancel_subscription: () => ({ status: "canceled" }),
    escalate_to_specialist: () => ({ status: "escalated" }),
  };
}
