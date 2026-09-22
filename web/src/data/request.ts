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
