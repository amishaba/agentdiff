// A four-agent travel booking team: a concierge that hands off to flights,
// hotels and payments specialists. Uses the OpenAI Agents SDK and, for the
// concierge's policy check, Jev through Vercel AI Gateway.
export default {
  agent: "concierge",
  versions: {
    old: "./agents/booking-v1.ts",
    new: "./agents/booking-v2.ts",
  },
  tests: "./tests",
  runsPerTest: 10,
  // A full booking passes through four agents; the SDK's default of 10 turns is too few.
  maxTurns: 40,
  writeTools: ["hold_seat", "hold_room", "release_hold", "charge", "send_itinerary"],
  // The team's tools are the simulated world in world.ts, so discovery runs each team's own tools.
  discovery: {
    tools: "own",
    context: "Two travelers: T-100 (aisle seat, United loyalty number, a default Amex ending 1008 that works and a Visa ending 4242 that needs 3-D Secure) and T-200 (window seat, no loyalty number, one Mastercard ending 5555 that is declined). Flights exist only SFO→JFK on Oct 14 and Oct 20, JFK→SFO on Oct 17 and Oct 22, JFK→BOS on Oct 16 and BOS→SFO on Oct 18; each date has a cheaper non-refundable basic economy fare and a refundable economy fare (Oct 14 also has first class). Hotels: three in Midtown New York (the two under $250 a night are sold out Oct 20–21) and two in Back Bay, Boston. Tessel policy: refundable economy fares only, hotels up to $250 a night, stay in the stated budget, charge once after everything is held.",
  },
};
