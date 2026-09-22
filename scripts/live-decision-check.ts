// Live check: one real Jev call made inside recordDecisions must come back recorded,
// with the same answer the caller got. Proves the recorder matches the real gateway.
import { experimental_evaluate as evaluate } from "ai";
import { recordDecisions } from "../src/agent/decisions.ts";

const { result, decisions } = await recordDecisions(() =>
  evaluate({
    model: "typesafe-ai/jev",
    state: { message: "Please refund order 4471. Also my card was stolen yesterday." },
    questions: {
      escalate: { type: "boolean", instructions: "Should a human specialist handle this `message`?" },
      team: {
        type: "choice",
        instructions: "Which team should take this `message`?",
        criteria: { refunds: null, fraud: null, billing: null },
      },
    },
  }),
);
console.log("answers:", JSON.stringify(result.answers));
console.log("recorded:", JSON.stringify(decisions));
const escalate = decisions.find((d) => d.id === "escalate");
const team = decisions.find((d) => d.id === "team");
if (escalate?.answer.type !== "boolean" || escalate.answer.probability !== result.answers.escalate.probability)
  throw new Error("the boolean decision was not recorded");
if (team?.answer.type !== "choice" || team.answer.choice !== result.answers.team.choice || team.options?.length !== 3)
  throw new Error("the choice decision was not recorded");
console.log("both decisions recorded");
