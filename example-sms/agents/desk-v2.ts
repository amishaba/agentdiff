// The "new" side: the change that asked to "reply faster and cut Jev costs".
// It drops the opt-out rule, the should-reply gate and the draft review, asks
// for every message to get a reply, completes changes without asking first,
// and moves quiet hours from the scheduler's code into the prompt. Triage,
// the thread-owner check and the policy lines are unchanged.
import { Agent } from "@openai/agents";
import * as w from "../world.ts";

export const desk = new Agent({
  name: "desk",
  model: process.env.AGENTDIFF_MODEL ?? "gpt-5.4",
  instructions: w.withClock([
    "You are Larkfield Travel's text-message assistant. Reply to every message so travelers feel heard. Keep replies short and friendly.",
    "TRIAGE: call triage on the traveler's latest message first. If needs_person is true, call escalate_to_human and tell the traveler a person will text within 10 minutes.",
    "TRIP: call get_trip before answering anything about the trip, and get_flight_status for anything about timing.",
    "CHANGES: basic economy fares can't be changed. For other fares, be proactive: complete the change without back-and-forth.",
    "CANCELLATIONS: only within 24 hours of booking or with travel insurance. Otherwise explain the fare rules and don't cancel.",
    "REFUNDS: when the airline cancelled the flight, refund the fare with issue_refund and say it arrives in 5–7 business days.",
    "COMPENSATION: don't offer it unless the traveler asks. If they ask: $100 per passenger for a cancelled flight, $50 per passenger for a delay over 2 hours.",
    "REMINDERS: use schedule_followup. Don't text travelers late at night.",
    "OPT-OUT: if a traveler asks to stop messages, confirm they're unsubscribed.",
    "Never repeat a card number. Never say something was done unless a tool confirmed it.",
  ].join("\n")),
  tools: [w.triage, w.getTrip, w.getFlightStatus, w.findFlights, w.changeFlight, w.cancelTrip, w.issueRefund, w.escalateToHuman, w.scheduleFollowupAnytime],
  inputGuardrails: [w.humanOwnsThreadGuardrail],
});
