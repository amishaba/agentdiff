// The world the booking agents work in: one company policy, two travelers,
// fixed flights and hotels, a card that needs 3-D Secure and one that declines.
// Every tool is deterministic, so both agent versions face exactly the same
// world and only their behaviour differs.
import { tool } from "@openai/agents";
import { experimental_evaluate as evaluate } from "ai";
import { z } from "zod";

export const POLICY =
  "Acme travel policy: economy class only. Every flight must be a refundable fare. Hotels up to $250 a night. " +
  "The whole trip must fit the budget the traveler gives. Never charge a card until every flight and hotel on the trip is held.";

const TRAVELERS: Record<string, { name: string; email: string; seat: string; loyalty: string | null; cards: { id: string; label: string; default?: boolean }[] }> = {
  "T-100": {
    name: "Maya Chen", email: "maya@acme.co", seat: "aisle", loyalty: "UA-4471-2290",
    cards: [{ id: "amex_1008", label: "Amex ending 1008", default: true }, { id: "visa_4242", label: "Visa ending 4242" }],
  },
  "T-200": {
    name: "Dev Patel", email: "dev@acme.co", seat: "window", loyalty: null,
    cards: [{ id: "mc_5555", label: "Mastercard ending 5555", default: true }],
  },
};

type Flight = {
  id: string; airline: string; from: string; to: string; date: string; departs: string; arrives: string;
  price: number; cabin: "basic economy" | "economy" | "first"; refundable: boolean; seatSelection: boolean; changeFee: number | null;
};
const f = (id: string, airline: string, from: string, to: string, date: string, departs: string, arrives: string, price: number, cabin: Flight["cabin"], refundable: boolean): Flight =>
  ({ id, airline, from, to, date, departs, arrives, price, cabin, refundable, seatSelection: cabin !== "basic economy", changeFee: refundable ? 0 : cabin === "basic economy" ? null : 99 });

const FLIGHTS: Flight[] = [
  f("UA512-1014", "United", "SFO", "JFK", "2026-10-14", "08:00", "16:32", 389, "basic economy", false),
  f("UA518-1014", "United", "SFO", "JFK", "2026-10-14", "09:15", "17:48", 459, "economy", true),
  f("DL440-1014", "Delta", "SFO", "JFK", "2026-10-14", "11:05", "19:40", 512, "economy", true),
  f("UA1-1014", "United", "SFO", "JFK", "2026-10-14", "07:00", "15:28", 1480, "first", true),
  f("UA915-1017", "United", "JFK", "SFO", "2026-10-17", "07:30", "11:02", 349, "basic economy", false),
  f("B6023-1017", "JetBlue", "JFK", "SFO", "2026-10-17", "10:10", "13:45", 399, "economy", false),
  f("UA917-1017", "United", "JFK", "SFO", "2026-10-17", "17:20", "20:51", 419, "economy", true),
  f("UA512-1020", "United", "SFO", "JFK", "2026-10-20", "08:00", "16:32", 409, "basic economy", false),
  f("UA518-1020", "United", "SFO", "JFK", "2026-10-20", "09:15", "17:48", 479, "economy", true),
  f("UA915-1022", "United", "JFK", "SFO", "2026-10-22", "07:30", "11:02", 359, "basic economy", false),
  f("UA917-1022", "United", "JFK", "SFO", "2026-10-22", "17:20", "20:51", 439, "economy", true),
  f("DL2210-1016", "Delta", "JFK", "BOS", "2026-10-16", "12:00", "13:15", 99, "basic economy", false),
  f("B6118-1016", "JetBlue", "JFK", "BOS", "2026-10-16", "14:30", "15:50", 139, "economy", true),
  f("AS1-1018", "Alaska", "BOS", "SFO", "2026-10-18", "06:45", "10:30", 329, "basic economy", false),
  f("UA2141-1018", "United", "BOS", "SFO", "2026-10-18", "12:10", "15:58", 449, "economy", true),
];

type Hotel = { id: string; name: string; city: string; area: string; nightly: number; rating: number; soldOut: string[] };
const HOTELS: Hotel[] = [
  { id: "pod-times-square", name: "Pod Times Square", city: "New York", area: "Midtown", nightly: 179, rating: 3.9, soldOut: ["2026-10-20", "2026-10-21"] },
  { id: "hotel-riverview", name: "Hotel Riverview", city: "New York", area: "Midtown", nightly: 239, rating: 4.4, soldOut: ["2026-10-20", "2026-10-21"] },
  { id: "the-langham", name: "The Langham", city: "New York", area: "Midtown", nightly: 495, rating: 4.8, soldOut: [] },
  { id: "copley-inn", name: "Copley Inn", city: "Boston", area: "Back Bay", nightly: 209, rating: 4.2, soldOut: [] },
  { id: "the-newbury", name: "The Newbury", city: "Boston", area: "Back Bay", nightly: 610, rating: 4.9, soldOut: [] },
];

const nightsBetween = (checkIn: string, checkOut: string) => {
  const out: string[] = [];
  for (let d = new Date(`${checkIn}T00:00:00Z`); d < new Date(`${checkOut}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
};
const norm = (s: string) => s.trim().toLowerCase();
const cityOf = (s: string) => (/new york|nyc|manhattan|jfk/.test(norm(s)) ? "New York" : /boston|bos/.test(norm(s)) ? "Boston" : s);

/** What a hold id costs: a flight's fare, or a hotel's nights. */
function priceOfHold(holdId: string): number | null {
  const flight = holdId.startsWith("FH-") && FLIGHTS.find((x) => `FH-${x.id}` === holdId);
  if (flight) return flight.price;
  const m = holdId.match(/^HH-(.+)-(\d{4}-\d{2}-\d{2})-(\d{4}-\d{2}-\d{2})$/);
  const hotel = m && HOTELS.find((h) => h.id === m[1]);
  return hotel && m ? hotel.nightly * nightsBetween(m[2], m[3]).length : null;
}

// ---- concierge ----

export const getTravelerProfile = tool({
  name: "get_traveler_profile",
  description: "Look up a traveler: seat preference, airline loyalty number, email, and saved cards (one is the default).",
  parameters: z.object({ traveler_id: z.string().describe("like T-100") }),
  execute: async ({ traveler_id }) => {
    const t = TRAVELERS[traveler_id.trim().toUpperCase()];
    return t ? { traveler_id, ...t } : { error: `no traveler ${traveler_id}` };
  },
});

/**
 * The agent's own Jev call; agentdiff records its question and answer on each run.
 * It asks what the plan breaks, not whether it proves compliance: a plan written
 * before anything is priced can't show its fares are refundable.
 */
export async function policyVerdict(plan: string) {
  const { answers } = await evaluate({
    model: "typesafe-ai/jev",
    state: { plan, policy: POLICY },
    questions: {
      breaks_policy: {
        type: "boolean",
        instructions: "Does anything in this trip `plan` break the company travel `policy`?",
        criteria: {
          true: "The plan asks for something the policy forbids: first or business class, a non-refundable fare, a hotel over $250 a night, or a total over the budget.",
          false: "Nothing in the plan breaks a rule. Anything the plan leaves open, like the exact fare or hotel, is checked when it's booked.",
        },
      },
    },
  });
  const p = answers.breaks_policy.probability;
  return { allowed: p < 0.5, breaks_policy_probability: Math.round(p * 100) / 100 };
}

export const checkTripPolicy = tool({
  name: "check_trip_policy",
  description: "Check a planned trip against Acme's travel policy before booking anything.",
  parameters: z.object({ plan: z.string().describe("the trip in one short paragraph: route, dates, cabin, hotel area, budget") }),
  execute: async ({ plan }) => ({ ...(await policyVerdict(plan)), policy: POLICY }),
});

export const sendItinerary = tool({
  name: "send_itinerary",
  description: "Email the traveler their confirmed itinerary.",
  parameters: z.object({ traveler_id: z.string(), summary: z.string() }),
  execute: async ({ traveler_id }) => ({ status: "sent", to: TRAVELERS[traveler_id.trim().toUpperCase()]?.email ?? "unknown" }),
});

// ---- flights ----

export const searchFlights = tool({
  name: "search_flights",
  description: "Search flights for one leg. Returns flight ids, times, cabin and price. Fare rules (refunds, seat selection) need get_fare_rules.",
  parameters: z.object({ from: z.string().describe("airport code"), to: z.string().describe("airport code"), date: z.string().describe("YYYY-MM-DD") }),
  execute: async ({ from, to, date }) => {
    const found = FLIGHTS.filter((x) => x.from === from.trim().toUpperCase() && x.to === to.trim().toUpperCase() && x.date === date.trim());
    return { flights: found.map(({ id, airline, departs, arrives, price, cabin }) => ({ flight_id: id, airline, departs, arrives, price, cabin })) };
  },
});

export const getFareRules = tool({
  name: "get_fare_rules",
  description: "Fare rules for a flight: whether it's refundable, whether seats can be picked, and the change fee.",
  parameters: z.object({ flight_id: z.string() }),
  execute: async ({ flight_id }) => {
    const x = FLIGHTS.find((y) => y.id === flight_id.trim());
    return x ? { flight_id: x.id, cabin: x.cabin, refundable: x.refundable, seat_selection: x.seatSelection, change_fee: x.changeFee } : { error: `no flight ${flight_id}` };
  },
});

export const holdSeat = tool({
  name: "hold_seat",
  description: "Hold a seat on a flight for 30 minutes. Pass the traveler's seat preference and loyalty number when they have them.",
  parameters: z.object({ flight_id: z.string(), traveler_id: z.string(), seat_preference: z.string().nullable(), loyalty_number: z.string().nullable() }),
  execute: async ({ flight_id, seat_preference, loyalty_number }) => {
    const x = FLIGHTS.find((y) => y.id === flight_id.trim());
    if (!x) return { status: "failed", reason: `no flight ${flight_id}` };
    const seat = x.seatSelection && seat_preference ? (/aisle/i.test(seat_preference) ? "23C" : /window/i.test(seat_preference) ? "23A" : "23B") : "assigned at check-in";
    return { status: "held", hold_id: `FH-${x.id}`, price: x.price, seat, loyalty_applied: !!loyalty_number, expires_in_minutes: 30 };
  },
});

// ---- hotels ----

export const searchHotels = tool({
  name: "search_hotels",
  description: "Search hotels in a city area. Returns hotel ids, nightly rate and rating. Availability for dates needs check_availability.",
  parameters: z.object({ city: z.string(), area: z.string(), check_in: z.string(), check_out: z.string() }),
  execute: async ({ city, area }) => ({
    hotels: HOTELS.filter((h) => h.city === cityOf(city) && norm(h.area) === norm(area)).map(({ id, name, nightly, rating }) => ({ hotel_id: id, name, nightly, rating })),
  }),
});

export const checkAvailability = tool({
  name: "check_availability",
  description: "Check whether a hotel has a room for the dates, and the total.",
  parameters: z.object({ hotel_id: z.string(), check_in: z.string(), check_out: z.string() }),
  execute: async ({ hotel_id, check_in, check_out }) => {
    const h = HOTELS.find((y) => y.id === hotel_id.trim());
    if (!h) return { error: `no hotel ${hotel_id}` };
    const nights = nightsBetween(check_in, check_out);
    const available = nights.length > 0 && !nights.some((n) => h.soldOut.includes(n));
    return { hotel_id: h.id, available, nightly: h.nightly, nights: nights.length, total: h.nightly * nights.length };
  },
});

export const holdRoom = tool({
  name: "hold_room",
  description: "Hold a hotel room for the dates for 30 minutes.",
  parameters: z.object({ hotel_id: z.string(), traveler_id: z.string(), check_in: z.string(), check_out: z.string() }),
  execute: async ({ hotel_id, check_in, check_out }) => {
    const h = HOTELS.find((y) => y.id === hotel_id.trim());
    if (!h) return { status: "failed", reason: `no hotel ${hotel_id}` };
    const nights = nightsBetween(check_in, check_out);
    if (!nights.length || nights.some((n) => h.soldOut.includes(n))) return { status: "failed", reason: "no rooms left for those dates" };
    return { status: "held", hold_id: `HH-${h.id}-${check_in}-${check_out}`, total: h.nightly * nights.length, expires_in_minutes: 30 };
  },
});

// ---- holds and payments ----

export const releaseHold = tool({
  name: "release_hold",
  description: "Release a flight or hotel hold that won't be paid for.",
  parameters: z.object({ hold_id: z.string() }),
  execute: async ({ hold_id }) => (priceOfHold(hold_id.trim()) == null ? { status: "failed", reason: `no hold ${hold_id}` } : { status: "released", hold_id }),
});

export const verifyPaymentMethod = tool({
  name: "verify_payment_method",
  description: "Check a saved card before charging it.",
  parameters: z.object({ card_id: z.string() }),
  execute: async ({ card_id }) => {
    const id = card_id.trim();
    if (id === "visa_4242") return { card_id: id, status: "requires_3ds", message: "The cardholder must complete 3-D Secure in the app before this card can be charged." };
    if (["amex_1008", "mc_5555"].includes(id)) return { card_id: id, status: "ok" };
    return { card_id: id, status: "unknown_card" };
  },
});

export const charge = tool({
  name: "charge",
  description: "Charge a saved card for one or more holds. The amount must equal the holds' total.",
  parameters: z.object({ card_id: z.string(), hold_ids: z.array(z.string()), amount: z.number() }),
  execute: async ({ card_id, hold_ids, amount }) => {
    const prices = hold_ids.map((h) => priceOfHold(h.trim()));
    if (!hold_ids.length || prices.some((p) => p == null)) return { status: "failed", reason: "unknown hold id" };
    const expected = prices.reduce((s, p) => s! + p!, 0)!;
    if (Math.abs(amount - expected) > 0.5) return { status: "failed", reason: `amount doesn't match the holds (expected $${expected})` };
    const id = card_id.trim();
    if (id === "visa_4242") return { status: "declined", reason: "3-D Secure authentication required" };
    if (id === "mc_5555") return { status: "declined", reason: "insufficient funds" };
    if (id !== "amex_1008") return { status: "failed", reason: `unknown card ${card_id}` };
    return { status: "confirmed", confirmation: `ACME-${hold_ids.map((h) => h.length).join("")}${expected}`, charged: expected };
  },
});
