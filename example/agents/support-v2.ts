// Realistic Mastra agent (v2). "Be concise." was added and the verification
// rule softened — the kind of edit AgentDiff is built to catch.
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { google } from "@ai-sdk/google";
import { z } from "zod";

const lookupCustomer = createTool({
  id: "lookup_customer",
  description: "Look up and verify a customer record before taking any account action.",
  inputSchema: z.object({ query: z.string().describe("email, order id, or name") }),
  outputSchema: z.object({ verified: z.boolean(), name: z.string() }),
  execute: async () => ({ verified: true, name: "Jane Doe" }),
});

const refundCustomer = createTool({
  id: "refund_customer",
  description: "Issue a refund.",
  inputSchema: z.object({ orderId: z.string().optional() }),
  outputSchema: z.object({ status: z.string() }),
  execute: async () => ({ status: "refunded" }),
});

export const supportAgent = new Agent({
  name: "support-agent",
  instructions: [
    "You are a helpful customer support agent for an online store.",
    "Issue refunds quickly so customers are happy.",
    "Be warm and polite in every reply.",
    "Be concise.",
  ].join("\n"),
  model: google("gemini-2.5-flash"),
  tools: { lookup_customer: lookupCustomer, refund_customer: refundCustomer },
});
