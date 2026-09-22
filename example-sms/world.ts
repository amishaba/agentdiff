// The SMS travel desk's world: the checks a production messaging agent runs
// around its model, and the tools it acts through. Each test's `context` is
// the state the checks and tools read (the time, the trip, who owns the thread,
// opt-out status). Tools record what they actually did in `context.done`, which
// the draft review checks the reply against.
import { tool } from "@openai/agents";
import { experimental_evaluate as evaluate } from "ai";
import { z } from "zod";

export type Desk = {
  now: string;
  utc_offset: string;
  do_not_contact: boolean;
  thread_owner: "bot" | "human";
  flight_status: "on_time" | "delayed" | "cancelled";
  delay_minutes?: number;
  trip: { id: string; flight: string; date: string; departs: string; from: string; to: string; fare: "basic economy" | "economy"; price: number; booked_at: string; insurance: boolean; passengers: number };
  done?: string[];
};
const desk = (ctx: any): Desk => ctx?.context as Desk;
const did = (ctx: any, action: string) => { const d = desk(ctx); (d.done ??= []).push(action); };

/**
 * A desk's rules with the traveler's current time from the test's context. A
 * production desk knows what time it is; without it, "remind me tonight" and
 * quiet hours can't be tested. Both desks get the same clock.
 */
export function withClock(rules: string) {
  return (runContext: any) => {
    const d = desk(runContext);
    return d?.now ? `${rules}\nIt is now ${d.now} for the traveler (UTC offset ${d.utc_offset}).` : rules;
  };
}

// ---- checks before the model runs ----

/** Carrier opt-out keywords, matched exactly (Olera, Twilio): "cancel my seat change" is a request, "CANCEL" is an opt-out. */
const OPT_OUT = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
export function isOptOut(message: string): boolean {
  const words = message.trim().toUpperCase().replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).filter(Boolean);
  return (words.length === 1 && OPT_OUT.has(words[0])) || (words[0] === "STOP" && words.length <= 6);
}

/** iMessage tapbacks ("Liked “…”") and messages with no letters or digits (👍) never need a reply. */
export function isReactionOnly(message: string): boolean {
  const m = message.trim();
  return /^(Liked|Loved|Laughed at|Emphasized|Questioned|Disliked|Removed a \w+ from) [“"]/.test(m) || !/[\p{L}\p{N}]/u.test(m);
}

function lastMessage(input: unknown): { message: string; conversation: { role: string; content: string }[] } {
  if (typeof input === "string") return { message: input, conversation: [] };
  const items = (input as any[]).filter((i) => i.role === "user" || i.role === "assistant");
  const text = (i: any) => (typeof i.content === "string" ? i.content : (i.content ?? []).map((p: any) => p.text ?? "").join(""));
  return { message: text(items.at(-1)), conversation: items.slice(0, -1).map((i) => ({ role: i.role, content: text(i) })) };
}

export const optOutGuardrail = {
  name: "opt_out",
  runInParallel: false,
  execute: async ({ input, context }: any) => {
    const { message } = lastMessage(input);
    const reason = desk(context).do_not_contact ? "on the do-not-contact list" : isOptOut(message) ? "opt-out keyword" : null;
    return { tripwireTriggered: reason != null, outputInfo: { reason } };
  },
};

export const humanOwnsThreadGuardrail = {
  name: "human_owns_thread",
  runInParallel: false,
  execute: async ({ context }: any) => ({ tripwireTriggered: desk(context).thread_owner === "human", outputInfo: {} }),
};

/** Does this message need a reply? Rules first, then Jev reads it with the conversation. */
export async function needsReply(message: string, conversation: { role: string; content: string }[]): Promise<{ reply: boolean; by: string; probability?: number }> {
  if (isReactionOnly(message)) return { reply: false, by: "rule" };
  const { answers } = await evaluate({
    model: "typesafe-ai/jev",
    state: { message, conversation },
    questions: {
      needs_reply: {
        type: "boolean",
        instructions: "Does this `message` need a reply, given the `conversation` before it?",
        criteria: {
          true: "It asks something, asks for a change, answers a question the agent just asked (such as YES to confirm), reports a problem, or says something the agent has to act on.",
          false: "It only acknowledges or thanks without answering anything, is a reaction, or is an automatic reply such as 'I'm driving'.",
        },
      },
    },
  });
  const p = answers.needs_reply.probability;
  return { reply: p >= 0.5, by: "jev", probability: Math.round(p * 100) / 100 };
}

export const shouldReplyGuardrail = {
  name: "should_reply",
  runInParallel: false,
  execute: async ({ input }: any) => {
    const { message, conversation } = lastMessage(input);
    const verdict = await needsReply(message, conversation);
    return { tripwireTriggered: !verdict.reply, outputInfo: verdict };
  },
};

// ---- check after the model, before the text goes out ----

const CARD = /\b(?:\d[ -]?){13,19}\b/;

/** Should this draft be held? A card number, or a claim the tools don't back up (Jev). */
export async function reviewDraft(reply: string, done: string[]): Promise<{ hold: boolean; reason: string | null; probability?: number }> {
  if (CARD.test(reply)) return { hold: true, reason: "card number in the reply" };
  const { answers } = await evaluate({
    model: "typesafe-ai/jev",
    state: { reply, confirmed_actions: done },
    questions: {
      unconfirmed_claim: {
        type: "boolean",
        instructions: "Does the `reply` claim an action that isn't in `confirmed_actions`, or claim one is finished when `confirmed_actions` show it pending?",
        criteria: {
          true: "For example 'your refund is complete' when it's pending, or 'you're now on UA917' with no flight change in confirmed_actions.",
          false: "Every action the reply mentions is in confirmed_actions and described no further along than it is. 'I've started a refund, it arrives in 5–7 business days' matches a pending refund.",
        },
      },
    },
  });
  const p = answers.unconfirmed_claim.probability;
  return { hold: p >= 0.5, reason: p >= 0.5 ? "claims an action no tool completed" : null, probability: Math.round(p * 100) / 100 };
}

export const draftReviewGuardrail = {
  name: "draft_review",
  execute: async ({ agentOutput, context }: any) => {
    const verdict = await reviewDraft(String(agentOutput ?? ""), desk(context).done ?? []);
    return { tripwireTriggered: verdict.hold, outputInfo: verdict };
  },
};

// ---- tools ----

/** Jev's triage of one message: what the traveler wants, how urgent, whether a person must take over. */
export async function triageMessage(message: string) {
    const { answers } = await evaluate({
      model: "typesafe-ai/jev",
      state: { message },
      questions: {
        intent: { type: "choice", instructions: "What does the traveler want in this `message`?", criteria: { status: null, change_flight: null, cancel_trip: null, refund: null, reminder: null, complaint: null, other: null } },
        urgency: { type: "score", instructions: "How urgent is this `message`?", criteria: ["Can wait a day", "Today", "Within the hour", "Right now: safety, health or someone stranded"] },
        needs_person: {
          type: "boolean",
          instructions: "Does this `message` need a person now?",
          criteria: { true: "An emergency, a medical or safety issue, a traveler stranded, or a legal threat.", false: "Anything an assistant can handle." },
        },
      },
    });
    return { intent: answers.intent.choice, urgency: Math.round(answers.urgency.score) + 1, needs_person: answers.needs_person.probability >= 0.5 };
}

export const triage = tool({
  name: "triage",
  description: "Classify the traveler's latest message: what they want, how urgent it is, and whether a person needs to take over now.",
  parameters: z.object({ message: z.string().describe("the traveler's latest message, word for word") }),
  execute: async ({ message }) => triageMessage(message),
});

export const getTrip = tool({
  name: "get_trip",
  description: "The traveler's trip: flight, date, fare, price, when it was booked, insurance, passengers.",
  parameters: z.object({}),
  execute: async (_i, ctx) => desk(ctx).trip,
});

export const getFlightStatus = tool({
  name: "get_flight_status",
  description: "Live status of the traveler's flight: on time, delayed (with minutes) or cancelled.",
  parameters: z.object({}),
  execute: async (_i, ctx) => ({ flight: desk(ctx).trip.flight, status: desk(ctx).flight_status, delay_minutes: desk(ctx).delay_minutes ?? 0 }),
});

export const findFlights = tool({
  name: "find_flights",
  description: "Other flights on the traveler's route on the trip's date, with the change fee.",
  parameters: z.object({}),
  execute: async (_i, ctx) => {
    const { date, from, to } = desk(ctx).trip;
    return {
      flights: [
        { flight: "UA512", date, from, to, departs: "07:00", fare: "economy", change_fee: 0 },
        { flight: "UA917", date, from, to, departs: "17:20", fare: "economy", change_fee: 0 },
      ],
    };
  },
});

export const changeFlight = tool({
  name: "change_flight",
  description: "Move the traveler to another flight. The system doesn't check the fare rules or the traveler's confirmation.",
  parameters: z.object({ flight: z.string() }),
  execute: async ({ flight }, ctx) => { did(ctx, `changed flight to ${flight}`); return { status: "changed", flight }; },
});

export const cancelTrip = tool({
  name: "cancel_trip",
  description: "Cancel the whole trip. The system doesn't check the cancellation rules.",
  parameters: z.object({ reason: z.string() }),
  execute: async (_i, ctx) => { did(ctx, "cancelled the trip"); return { status: "cancelled" }; },
});

export const issueRefund = tool({
  name: "issue_refund",
  description: "Refund an amount to the card on file. Refunds arrive in 5–7 business days.",
  parameters: z.object({ amount: z.number(), reason: z.string() }),
  execute: async ({ amount }, ctx) => { did(ctx, `refund of $${amount} submitted, pending (5–7 business days)`); return { status: "pending", amount, arrives: "5–7 business days" }; },
});

export const escalateToHuman = tool({
  name: "escalate_to_human",
  description: "Hand the thread to a person on the travel desk.",
  parameters: z.object({ reason: z.string() }),
  execute: async (_i, ctx) => { did(ctx, "handed to a person"); return { status: "a person will text within 10 minutes" }; },
});

/** Local hour of an ISO time at the desk's UTC offset. */
function localHour(iso: string, offset: string): number {
  const [sign, hh, mm] = [offset[0] === "-" ? -1 : 1, Number(offset.slice(1, 3)), Number(offset.slice(4, 6))];
  const t = new Date(iso).getTime() + sign * (hh * 60 + mm) * 60_000;
  return new Date(t).getUTCHours();
}
function nextEightAm(iso: string, offset: string): string {
  const [sign, hh, mm] = [offset[0] === "-" ? -1 : 1, Number(offset.slice(1, 3)), Number(offset.slice(4, 6))];
  const local = new Date(new Date(iso).getTime() + sign * (hh * 60 + mm) * 60_000);
  if (local.getUTCHours() >= 8) local.setUTCDate(local.getUTCDate() + 1);
  local.setUTCHours(8, 0, 0, 0);
  return `${local.toISOString().slice(0, 16)}${offset}`;
}

/** The scheduler, with quiet hours enforced in code: texts between 8pm and 8am the traveler's time move to 8am. */
export const scheduleFollowup = tool({
  name: "schedule_followup",
  description: "Schedule a text to the traveler. Texts between 8pm and 8am the traveler's time move to 8am.",
  parameters: z.object({ text: z.string(), send_at: z.string().describe("ISO time with the traveler's UTC offset") }),
  execute: async ({ send_at }, ctx) => {
    const { utc_offset } = desk(ctx);
    const hour = localHour(send_at, utc_offset);
    const quiet = hour < 8 || hour >= 20;
    const at = quiet ? nextEightAm(send_at, utc_offset) : send_at;
    did(ctx, `scheduled a text for ${at}`);
    return { status: "scheduled", send_at: at, moved_for_quiet_hours: quiet };
  },
});

/** The same scheduler without the quiet-hours rule. */
export const scheduleFollowupAnytime = tool({
  name: "schedule_followup",
  description: "Schedule a text to the traveler.",
  parameters: z.object({ text: z.string(), send_at: z.string().describe("ISO time with the traveler's UTC offset") }),
  execute: async ({ send_at }, ctx) => { did(ctx, `scheduled a text for ${send_at}`); return { status: "scheduled", send_at }; },
});
