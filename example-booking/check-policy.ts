// Asks the concierge's policy question about fixed plans and fails on a wrong
// answer, so a bad question is caught before a full recording is paid for.
import { policyVerdict } from "./world.ts";

const PLANS: Array<[plan: string, allowed: boolean]> = [
  ["Round-trip economy flights SFO to JFK, Oct 14 to Oct 17, and a Midtown hotel for those nights. Budget $1,600.", true],
  ["Refundable economy flights SFO to JFK and back ($878), Hotel Riverview at $239 a night for 3 nights. Total $1,595, budget $1,600.", true],
  ["Economy flights SFO to JFK Oct 14, JFK to Boston Oct 16, Boston to SFO Oct 18; hotels in Midtown and Back Bay. Budget $2,500.", true],
  ["One-way first class SFO to JFK on Oct 14. The company is paying.", false],
  ["Round-trip economy flights and The Langham at $495 a night for 3 nights. Budget $3,000.", false],
  ["Basic economy non-refundable fares SFO to JFK and back, $738 total. Budget $1,000.", false],
];

let wrong = 0;
for (const [plan, allowed] of PLANS) {
  const verdict = await policyVerdict(plan);
  const ok = verdict.allowed === allowed;
  if (!ok) wrong++;
  console.log(`${ok ? "ok   " : "WRONG"} breaks ${verdict.breaks_policy_probability.toFixed(2)} · expected ${allowed ? "allowed" : "not allowed"} · ${plan}`);
}
if (wrong) throw new Error(`${wrong} of ${PLANS.length} policy answers were wrong`);
