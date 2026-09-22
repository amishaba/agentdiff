import { z } from "zod";

export const SpanSchema = z
  .object({
    id: z.string(),
    span_id: z.string(),
    root_span_id: z.string(),
    _xact_id: z.string().optional(),
    created: z.string().optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    expected: z.unknown().optional(),
    error: z.unknown().optional(),
    scores: z.record(z.string(), z.number().nullable()).optional(),
    span_parents: z.array(z.string()).optional(),
    span_attributes: z.object({ name: z.string().optional(), type: z.string().optional() }).passthrough().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    metrics: z.object({ start: z.number().optional(), end: z.number().optional() }).passthrough().optional(),
  })
  .passthrough();
export type Span = z.infer<typeof SpanSchema>;
const ProjectSchema = z.object({ id: z.string().uuid(), name: z.string() });
export type Project = z.infer<typeof ProjectSchema>;

/** The fixed API origin keeps locally saved credentials away from arbitrary URLs. */
export class BraintrustClient {
  constructor(
    private key: string,
    private request: typeof fetch = fetch,
  ) {}

  private async get(route: string, params: Record<string, string> = {}): Promise<unknown> {
    const url = new URL(`https://api.braintrust.dev${route}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await this.request(url, {
      headers: { Authorization: `Bearer ${this.key}` },
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    // Never echo response bodies or authorization headers into logs/UI.
    if (!res.ok)
      throw new Error(
        res.status === 401 || res.status === 403
          ? "Braintrust access was denied. Check the key and project permissions."
          : `Braintrust request failed (${res.status}). Try refreshing.`,
      );
    return res.json();
  }

  async projects(): Promise<Project[]> {
    const projects: Project[] = [];
    const seen = new Set<string>();
    let after = "";
    for (let page = 0; page < 100; page++) {
      const { objects } = z
        .object({ objects: z.array(ProjectSchema) })
        .parse(await this.get("/v1/project", { limit: "100", ...(after ? { starting_after: after } : {}) }));
      for (const project of objects)
        if (!seen.has(project.id)) {
          seen.add(project.id);
          projects.push(project);
        }
      if (objects.length < 100) return projects;
      const next = objects.at(-1)!.id;
      if (after === next) throw new Error("Braintrust project pagination did not advance.");
      after = next;
    }
    throw new Error("Too many Braintrust projects to load in one request.");
  }

  async logs(projectId: string, cursor?: string): Promise<{ events: Span[]; cursor?: string | null }> {
    z.string().uuid().parse(projectId);
    // Fetch counts full traces, including their children, rather than individual rows.
    return z
      .object({ events: z.array(SpanSchema), cursor: z.string().nullish() })
      .parse(await this.get(`/v1/project_logs/${projectId}/fetch`, { limit: "50", ...(cursor ? { cursor } : {}) }));
  }
}

/** Pagination includes older versions of rows: keep the newest transaction for each ID. */
export function mergeSpans(previous: Span[], incoming: Span[]): Span[] {
  const rows = new Map(previous.map((s) => [s.id, s]));
  for (const span of incoming) {
    const existing = rows.get(span.id);
    const next = span._xact_id ?? "",
      previous = existing?._xact_id ?? "";
    const newer = /^\d+$/.test(next) && /^\d+$/.test(previous) ? BigInt(next) >= BigInt(previous) : next >= previous;
    if (!existing || newer) rows.set(span.id, span);
  }
  return [...rows.values()];
}
