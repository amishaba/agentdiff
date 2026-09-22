// The "new" side: the change that asked for "faster bookings". The concierge
// hands off straight away, flights holds the cheapest fare without reading its
// rules, each hold is charged as soon as it exists, and the specialists move to
// a cheaper model. The world and tools are the same. Diff it against booking-v1.ts.
import { Agent } from "@openai/agents";
import * as w from "../world.ts";

const model = process.env.AGENTDIFF_MODEL ?? "gpt-5.4";
const fast = process.env.BOOKING_FAST_MODEL ?? "gpt-5.4-mini";

export const concierge = new Agent({
  name: "concierge",
  handoffDescription: "Plans the trip, checks policy, and closes it out with the traveler.",
  model,
  instructions: [
    "You are Acme's travel concierge. Each request names the traveler (T-###).",
    "HAND OFF: send the request to flights_agent right away so the traveler isn't kept waiting. The specialists fill in the details.",
    "CLOSE OUT: when payments_agent confirms, call send_itinerary, then reply with a short summary.",
  ].join("\n"),
  tools: [w.getTravelerProfile, w.checkTripPolicy, w.sendItinerary],
});

export const flightsAgent = new Agent({
  name: "flights_agent",
  handoffDescription: "Finds and holds flights for every leg of the trip.",
  model: fast,
  instructions: [
    "You hold flights for Acme travelers.",
    "For each leg, call search_flights and hold the cheapest flight with hold_seat. Skip fare rules; they slow bookings down.",
    "After each hold, hand off to payments_agent to charge it right away so the traveler doesn't lose the fare.",
  ].join("\n"),
  tools: [w.searchFlights, w.getFareRules, w.holdSeat, w.releaseHold],
});

export const hotelsAgent = new Agent({
  name: "hotels_agent",
  handoffDescription: "Finds and holds the hotel.",
  model: fast,
  instructions: [
    "You hold hotels for Acme travelers.",
    "Call search_hotels for the area and hold the best-rated hotel with hold_room.",
    "When the room is held, hand off to payments_agent to charge it.",
  ].join("\n"),
  tools: [w.searchHotels, w.checkAvailability, w.holdRoom, w.releaseHold],
});

export const paymentsAgent = new Agent({
  name: "payments_agent",
  handoffDescription: "Pays for the held trip.",
  model: fast,
  instructions: [
    "You pay for Acme trips. Charge the traveler's default card (get_traveler_profile) as soon as there's a hold to pay for.",
    "Then hand off to hotels_agent if the trip still needs a hotel, otherwise back to concierge with the confirmation.",
  ].join("\n"),
  tools: [w.getTravelerProfile, w.verifyPaymentMethod, w.charge, w.releaseHold],
});

concierge.handoffs = [flightsAgent, hotelsAgent, paymentsAgent];
flightsAgent.handoffs = [hotelsAgent, paymentsAgent, concierge];
hotelsAgent.handoffs = [paymentsAgent, flightsAgent, concierge];
paymentsAgent.handoffs = [hotelsAgent, concierge];
