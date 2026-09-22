// A clinic's text-message booking assistant: verify the patient, offer only
// open slots, book on confirmation, late-cancel fees, the waitlist, privacy,
// pausing reminders vs opting out. v2 fixes one line of the prompt and adds a
// "faster booking" line. Its tools are a simulated clinic (world.ts).
export default {
  agent: "clinicAssistant",
  agentPath: "./agents/clinic-v1.ts",
  versions: {
    old: "./agents/clinic-v1.ts",
    new: "./agents/clinic-v2.ts",
  },
  tests: "./tests",
  runsPerTest: 4,
  concurrency: 12,
  grader: "openai",
  // New inputs aimed at the change, answered the way the tests answer each tool. Capped for the example's cost.
  discovery: { maxAgentRuns: 80, maxCandidates: 6, maxRounds: 2 },
  writeTools: [
    "book_appointment",
    "reschedule_appointment",
    "cancel_appointment",
    "add_to_waitlist",
    "send_email",
    "hand_off_to_front_desk",
    "pause_reminders",
    "opt_out",
  ],
};
