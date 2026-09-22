// Request/response helpers shared by every dashboard route.
import type http from "node:http";
import { z } from "zod";

/**
 * Mutating and project-reading APIs only answer the local dashboard page: an
 * exact localhost host/origin match plus a custom header, so a third-party
 * page cannot connect keys or execute project code.
 */
export function trustedRequest(req: http.IncomingMessage): boolean {
  const host = req.headers.host;
  if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return false;
  return (!req.headers.origin || req.headers.origin === `http://${host}`) && req.headers["x-agentdiff"] === "local";
}

export const UNTRUSTED_MESSAGE = "This endpoint is only available from the local AgentDiff dashboard.";

export function send(res: http.ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

export function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  send(res, status, "application/json", JSON.stringify(value));
}

export function redirect(res: http.ServerResponse, location: string): void {
  res.writeHead(302, { location, "cache-control": "no-store" });
  res.end();
}

/** Parse a JSON request body, refusing non-JSON content types and bodies over `maxBytes`. */
export async function readJsonBody(req: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new Error("Expected JSON.");
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > maxBytes) throw new Error("Request is too large.");
  }
  return JSON.parse(raw);
}

/** A user-facing message for a failed request: zod issues, bad JSON, or the error's own text. */
export function requestErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof z.ZodError) return error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  if (error instanceof SyntaxError) return "Enter valid JSON.";
  return error instanceof Error ? error.message : fallback;
}
