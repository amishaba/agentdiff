import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { exists, readJson, writeJson } from "../../storage/fs.ts";
import { BraintrustClient, mergeSpans, type Span } from "./client.ts";
import {
  incidentId,
  incidentsFromSpans,
  prepareScenario,
  reviewRevision,
  type Incident,
  type Scenario,
} from "./scenario.ts";

const ConnectionSchema = z.object({
  apiKey: z.string().min(1),
  projectId: z.string().uuid().optional(),
  threshold: z.number().min(0).max(1).default(0.5),
});
export type Connection = z.infer<typeof ConnectionSchema>;

export interface Inbox {
  incidents: Incident[];
  hasMore: boolean;
  checkedAt: string;
}

/** Fetched trace rows for one project, plus the cursor for older pages. */
interface SpanCache {
  spans: Span[];
  cursor?: string | null;
}

/**
 * The dashboard's Braintrust state under `.agentdiff/braintrust/`: the saved
 * connection (key file is 0600), reviewed scenarios, and their recordings.
 * Fetched traces are cached in memory per project for the life of the server.
 */
export class BraintrustStore {
  private caches = new Map<string, SpanCache>();
  /** The in-flight inbox fetch; refresh and pagination are serialized. */
  private fetching: Promise<unknown> | null = null;

  constructor(readonly dir: string) {}

  async readConnection(): Promise<Connection | null> {
    const file = path.join(this.dir, "connection.json");
    if (await exists(file)) return ConnectionSchema.parse(await readJson(file));
    return process.env.BRAINTRUST_API_KEY ? { apiKey: process.env.BRAINTRUST_API_KEY, threshold: 0.5 } : null;
  }

  async saveConnection(value: Connection): Promise<void> {
    const parsed = ConnectionSchema.parse(value);
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(this.dir, "connection.tmp");
    await fs.writeFile(tmp, JSON.stringify(parsed), { mode: 0o600 });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, path.join(this.dir, "connection.json"));
  }

  scenarioPath(id: string): string {
    if (!/^[a-f0-9]{24}$/.test(id)) throw new Error("Unknown incident.");
    return path.join(this.dir, "scenarios", `${id}.json`);
  }

  /** Flagged traces from the selected project; `older` loads the next page back. */
  async fetchInbox(older = false): Promise<Inbox> {
    const conn = await this.readConnection();
    const projectId = conn?.projectId;
    if (!conn || !projectId) throw new Error("Choose a Braintrust project first.");
    // Serialize refresh and pagination so neither loses the other's rows or cursor.
    if (this.fetching) await this.fetching.catch(() => {});
    const task = (async () => {
      const prior = this.caches.get(projectId) ?? { spans: [] };
      const page = await new BraintrustClient(conn.apiKey).logs(
        projectId,
        older ? (prior.cursor ?? undefined) : undefined,
      );
      if (older && page.cursor && page.cursor === prior.cursor)
        throw new Error("Braintrust pagination did not advance. Refresh and try again.");
      const merged = {
        spans: mergeSpans(prior.spans, page.events),
        cursor: older || !this.caches.has(projectId) ? page.cursor : prior.cursor,
      };
      this.caches.set(projectId, merged);
      const incidents = await Promise.all(
        incidentsFromSpans(projectId, merged.spans, conn.threshold).map(async (incident) => {
          const file = this.scenarioPath(incident.id);
          if (!(await exists(file))) return { ...incident, reviewed: false };
          const saved = await readJson<Scenario>(file);
          return {
            ...incident,
            reviewed: saved.reviewed,
            reviewRevision: saved.reviewed ? reviewRevision(saved) : undefined,
          };
        }),
      );
      return { incidents, hasMore: !!merged.cursor, checkedAt: new Date().toISOString() };
    })();
    this.fetching = task;
    try {
      return await task;
    } finally {
      if (this.fetching === task) this.fetching = null;
    }
  }

  /** A reviewed scenario as saved, or a fresh draft prepared from the cached trace. */
  async loadScenario(id: string): Promise<Scenario> {
    const file = this.scenarioPath(id);
    const saved = (await exists(file)) ? await readJson<Scenario>(file) : null;
    if (saved?.reviewed) return saved;
    const conn = await this.readConnection();
    const spans = conn?.projectId ? this.caches.get(conn.projectId)?.spans : undefined;
    if (!spans || !conn?.projectId) {
      if (saved) return saved;
      throw new Error("Refresh incidents before opening this recording.");
    }
    const incident = incidentsFromSpans(conn.projectId, spans, conn.threshold).find((i) => i.id === id);
    if (!incident || incidentId(conn.projectId, incident.rootSpanId) !== id)
      throw new Error("Incident is no longer in this project's results.");
    const draft = prepareScenario(incident, spans);
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeJson(file, draft);
    await writeJson(
      path.join(this.dir, "recordings", `${id}.json`),
      spans.filter((s) => s.root_span_id === incident.rootSpanId),
    );
    return draft;
  }

  async saveScenario(draft: Scenario): Promise<void> {
    await writeJson(this.scenarioPath(draft.incident.id), draft);
  }
}
