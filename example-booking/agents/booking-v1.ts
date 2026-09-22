// The "old" side: a concierge that plans the trip and checks it against policy,
// then hands off to flights, hotels and payments specialists. Nothing is charged
// until every flight and hotel on the trip is held.
import { Agent } from "@openai/agents";
import * as w from "../world.ts";

const model = process.env.AGENTDIFF_MODEL ?? "gpt-5.4";

export const concierge = new Agent({
  name: "concierge",
  handoffDescription: "Plans the trip, checks policy, and closes it out with the traveler.",
  model,
  instructions: [
    "You are Acme's travel concierge. Each request names the traveler (T-###).",
    "PROFILE: call get_traveler_profile first. Use the traveler's seat preference, loyalty number and default card unless the request says otherwise.",
    "POLICY: before anything is held, describe the trip in one short paragraph using only what the request says (route, dates, cabin, hotel area, budget). Don't guess prices. Call check_trip_policy with it. If it isn't allowed, don't book; tell the traveler what the policy allows. The specialists check fares and rates against policy as they book.",
    "HAND OFF: send the trip to flights_agent with the traveler id, route, dates, seat preference, loyalty number, card and budget.",
    "CLOSE OUT: when payments_agent confirms, call send_itinerary, then reply with the confirmation number, what was booked and the total. If anything wasn't booked, say exactly what and why.",
  ].join("\n"),
  tools: [w.getTravelerProfile, w.checkTripPolicy, w.sendItinerary],
});

export const flightsAgent = new Agent({
  name: "flights_agent",
  handoffDescription: "Finds and holds flights for every leg of the trip.",
  model,
  instructions: [
    "You hold flights for Acme travelers.",
    "For each leg, call search_flights, then get_fare_rules on the flight you'd pick. Only hold refundable economy fares that keep the trip in budget.",
    "Hold with hold_seat, passing the traveler's seat preference and loyalty number.",
    "If a leg has no refundable economy fare in budget, hold nothing: release any holds you made and hand back to concierge with the reason.",
    "When every leg is held, hand off to hotels_agent if the trip has a hotel, otherwise to payments_agent. Pass along every hold id, the running total and the card.",
  ].join("\n"),
  tools: [w.searchFlights, w.getFareRules, w.holdSeat, w.releaseHold],
});

export const hotelsAgent = new Agent({
  name: "hotels_agent",
  handoffDescription: "Finds and holds the hotel.",
  model,
  instructions: [
    "You hold hotels for Acme travelers.",
    "Call search_hotels for the area, then check_availability on your pick. Stay within $250 a night and the remaining budget.",
    "Hold with hold_room. If nothing fits, release every flight hold with release_hold and hand back to concierge with the reason.",
    "When the room is held, hand off to payments_agent with every hold id, the total and the card.",
  ].join("\n"),
  tools: [w.searchHotels, w.checkAvailability, w.holdRoom, w.releaseHold],
});

export const paymentsAgent = new Agent({
  name: "payments_agent",
  handoffDescription: "Pays for the held trip.",
  model,
  instructions: [
    "You pay for Acme trips. Only charge once every flight and hotel on the trip is held.",
    "Call verify_payment_method on the card first. If it needs 3-D Secure or is declined, don't retry: release every hold and hand back to concierge with the reason.",
    "Charge the exact total of the holds in one charge, then hand back to concierge with the confirmation.",
  ].join("\n"),
  tools: [w.getTravelerProfile, w.verifyPaymentMethod, w.charge, w.releaseHold],
});

concierge.handoffs = [flightsAgent, hotelsAgent, paymentsAgent];
flightsAgent.handoffs = [hotelsAgent, paymentsAgent, concierge];
hotelsAgent.handoffs = [paymentsAgent, flightsAgent, concierge];
paymentsAgent.handoffs = [hotelsAgent, concierge];
