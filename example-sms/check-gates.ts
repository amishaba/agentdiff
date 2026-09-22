// Asks the desk's two Jev gates about fixed messages and fails on a wrong
// answer, so a bad question is caught before a full recording is paid for.
import { needsReply, reviewDraft, triageMessage } from "./world.ts";

const STATUS = [{ role: "user", content: "Is my flight still on time tomorrow?" }, { role: "assistant", content: "Yes: UA518 is on time, 9:15am from SFO, gate B12." }];
const PROPOSAL = [{ role: "user", content: "Can you move me to the 5:20pm flight tomorrow?" }, { role: "assistant", content: "I can move you to UA917 at 5:20pm tomorrow, no change fee. Reply YES to confirm." }];

const REPLY: Array<[message: string, conversation: typeof STATUS, reply: boolean]> = [
  ["perfect, thanks!!", STATUS, false],
  ["I'm driving with Do Not Disturb While Driving turned on. I'll see your message when I get where I'm going.", [], false],
  ["Stop worrying me, is UA518 actually on time?", STATUS, true],
  ["Can you move me to the 5:20pm flight tomorrow?", [], true],
  ["YES", PROPOSAL, true],
  ["yes do it", PROPOSAL, true],
  ["ugh my flight is delayed 3 hours", [], true],
];
const PERSON: Array<[message: string, person: boolean]> = [
  ["Flight's cancelled and I'm stuck at JFK with my kids. My son's insulin is in the checked bag and I can't get to it.", true],
  ["Can you move me to the 5:20pm flight tomorrow?", false],
];

const PENDING = ["refund of $459 submitted, pending (5–7 business days)"];
const DRAFTS: Array<[reply: string, done: string[], hold: boolean]> = [
  ["I'm sorry about that. I've started a refund of $459 to your card on file. It should arrive in 5–7 business days.", PENDING, false],
  ["Your refund of $459 is complete.", PENDING, true],
  ["Done, you're now on UA917 tomorrow at 5:20pm.", [], true],
  ["UA518 is on time for tomorrow, 9:15am from SFO.", [], false],
];

let wrong = 0;
for (const [message, conversation, reply] of REPLY) {
  const v = await needsReply(message, conversation);
  const ok = v.reply === reply;
  if (!ok) wrong++;
  console.log(`${ok ? "ok   " : "WRONG"} needs_reply ${v.probability?.toFixed(2) ?? v.by} · expected ${reply ? "reply" : "no reply"} · ${message}`);
}
for (const [message, person] of PERSON) {
  const t = await triageMessage(message);
  const ok = t.needs_person === person;
  if (!ok) wrong++;
  console.log(`${ok ? "ok   " : "WRONG"} needs_person ${t.needs_person} · intent ${t.intent} · urgency ${t.urgency}/4 · ${message}`);
}
for (const [reply, done, hold] of DRAFTS) {
  const v = await reviewDraft(reply, done);
  const ok = v.hold === hold;
  if (!ok) wrong++;
  console.log(`${ok ? "ok   " : "WRONG"} unconfirmed_claim ${v.probability?.toFixed(2) ?? v.reason} · expected ${hold ? "hold" : "send"} · ${reply}`);
}
if (wrong) throw new Error(`${wrong} gate answers were wrong`);
