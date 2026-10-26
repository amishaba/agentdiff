import type { z } from "zod";
import { isSampleWorkspace } from "./navigation.ts";

// Sample requests never reach a server, including on localhost with ?demo=1.
// The real components use this same transport with the original local API.
export async function appFetch(url: string, init?: RequestInit): Promise<Response> {
  if (!isSampleWorkspace()) return fetch(url, init);
  init?.signal?.throwIfAborted();
  const { demoRequest } = await import("../demo/api.ts");
  init?.signal?.throwIfAborted();
  return demoRequest(url, init);
}

/**
 * Why a request failed: the server isn't there, it said no (its own message),
 * or it answered with something the page can't read.
 */
export type RequestFailure = "unreachable" | "rejected" | "unreadable";

export class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly failure: RequestFailure,
  ) {
    super(message);
  }
}

const UNREACHABLE =
  "Can't reach the agentdiff server. Check that `agentdiff view` is still running in your terminal, then reload.";

/**
 * GET (or POST `body` to) an API route and return its JSON. Every failure is a
 * RequestError whose message says what to do next; with `shape`, a response
 * the page can't render fails here rather than deep inside a component.
 */
export async function requestJson<T>(
  url: string,
  options: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal; shape?: z.ZodType } = {},
): Promise<T> {
  const { body, signal, shape } = options;
  let response: Response;
  try {
    response = await appFetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...options.headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new RequestError(UNREACHABLE, 0, "unreachable");
  }
  const route = url.split("?")[0];
  const text = await response.text();
  let value: unknown;
  try {
    value = text ? JSON.parse(text) : undefined;
  } catch {
    value = undefined;
  }
  if (!response.ok) {
    const message = (value as { error?: unknown } | undefined)?.error;
    if (typeof message === "string" && message) throw new RequestError(message, response.status, "rejected");
    // The dev server's proxy answers 502 with an empty body when `agentdiff view` is down.
    if (response.status === 502 || response.status === 503 || response.status === 504)
      throw new RequestError(UNREACHABLE, response.status, "unreachable");
    throw new RequestError(`${route} failed (${response.status}).`, response.status, "rejected");
  }
  if (value === undefined) throw new RequestError(`${route} didn't answer with JSON.`, response.status, "unreadable");
  if (shape) {
    const checked = shape.safeParse(value);
    if (!checked.success) {
      const issue = checked.error.issues[0];
      const where = issue.path.length ? `${issue.path.join(".")}: ` : "";
      throw new RequestError(
        `${route} sent data this page can't show (${where}${issue.message}). It may have been saved by a different version of agentdiff.`,
        response.status,
        "unreadable",
      );
    }
  }
  // The shapes check what the page reads and let the rest through, so the original value is returned.
  return value as T;
}
