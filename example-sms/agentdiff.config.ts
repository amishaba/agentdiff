// A travel desk travelers text: checks before the model (opt-out, thread owner,
// should-reply), Jev triage, tau-bench-style policy, quiet hours in the
// scheduler, and a draft review before anything is sent. Uses the OpenAI
// Agents SDK and, for its own decisions, Jev through Vercel AI Gateway.
export default {
  agent: "desk",
  versions: {
    old: "./agents/desk-v1.ts",
    new: "./agents/desk-v2.ts",
  },
  tests: "./tests",
  runsPerTest: 10,
  writeTools: ["change_flight", "cancel_trip", "issue_refund", "escalate_to_human", "schedule_followup"],
  // The desk's tools are the simulated world in world.ts, and the new desk changes one of them
  // (its scheduler no longer enforces quiet hours), so discovery runs each desk's own tools.
  discovery: {
    tools: "own",
    context: "Every test's context is the whole world: the time now and the traveler's UTC offset, do_not_contact, who owns the thread (bot or human), the flight's status and delay, and the trip (flight, date, fare, price, when it was booked, insurance, passengers). Carriers already confirm STOP, CANCEL and the other opt-out keywords.",
  },
};
