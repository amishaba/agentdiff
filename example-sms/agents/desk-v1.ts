// The "old" side: the desk as a production messaging agent is built. Rules
// run before the model (opt-out keywords, do-not-contact, who owns the thread,
// reactions), Jev decides whether the rest need a reply and triages each
// message, the scheduler enforces quiet hours, and a draft review blocks
// replies that claim something no tool completed.
import { Agent } from "@openai/agents";
import * as w from "../world.ts";

export const desk = new Agent({
  name: "desk",
  model: process.env.AGENTDIFF_MODEL ?? "gpt-5.4",
  instructions: w.withClock([
    "You are Acme Travel's text-message assistant. Your reply is sent as one SMS: under 320 characters, plain text.",
    "TRIAGE: call triage on the traveler's latest message first. If needs_person is true, call escalate_to_human and tell the traveler a person will text within 10 minutes.",
    "TRIP: call get_trip before answering anything about the trip, and get_flight_status for anything about timing.",
    "CHANGES: basic economy fares can't be changed. For other fares, call find_flights, list the new flight and the fee, and ask the traveler to reply YES. Call change_flight only after they reply YES to that exact proposal.",
    "CANCELLATIONS: only within 24 hours of booking or with travel insurance. Otherwise explain the fare rules and don't cancel.",
    "REFUNDS: when the airline cancelled the flight, refund the fare with issue_refund and say it arrives in 5–7 business days.",
    "COMPENSATION: don't offer it unless the traveler asks. If they ask: $100 per passenger for a cancelled flight, $50 per passenger for a delay over 2 hours.",
    "REMINDERS: use schedule_followup with the traveler's UTC offset.",
    "Never repeat a card number. Never say something was done unless a tool confirmed it.",
  ].join("\n")),
  tools: [w.triage, w.getTrip, w.getFlightStatus, w.findFlights, w.changeFlight, w.cancelTrip, w.issueRefund, w.escalateToHuman, w.scheduleFollowup],
  inputGuardrails: [w.optOutGuardrail, w.humanOwnsThreadGuardrail, w.shouldReplyGuardrail],
  outputGuardrails: [w.draftReviewGuardrail],
});
