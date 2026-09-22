import type http from "node:http";
import path from "node:path";
import { z } from "zod";
import { ReplayResponseSchema, type RunRecord } from "../../types.ts";
import { strictCanonical } from "../../lib/canonical.ts";
import { listDir, readJson, writeJson } from "../../storage/fs.ts";
import { readComparisonRuns } from "../../storage/comparison.ts";
import type { Workspace } from "../../storage/workspace.ts";
import { configDocument } from "../project/config-editor.ts";
import { projectPath } from "../project/files.ts";
import { readJsonBody, sendJson, trustedRequest, UNTRUSTED_MESSAGE } from "../http.ts";
import { BraintrustClient } from "./client.ts";
import { incidentTest, incidentTestFile, reviewRevision } from "./scenario.ts";
import { BraintrustStore } from "./store.ts";

const PREFIX = "/api/braintrust/";
const DEFAULT_THRESHOLD = 0.5;

type MissingResponse = NonNullable<RunRecord["replay"]>["missing"][number];

const ConnectSchema = z.object({ apiKey: z.string().trim().min(1) });
const ProjectSelectionSchema = z.object({ projectId: z.string().uuid(), threshold: z.number().min(0).max(1) });
const ReviewSchema = z.object({
  id: z.string(),
  expectation: z.string().trim(),
  mustCallTools: z.array(z.string().trim().min(1)),
  responses: z.array(ReplayResponseSchema).default([]),
});
const IncidentIdSchema = z.object({ id: z.string() });

/**
 * /api/braintrust — connect a Braintrust project, browse failing traces, review
 * one into a test, and add it to the suite. A local-only JSON API: every route
 * needs the dashboard's header and an exact local host/origin match, so
 * third-party pages cannot connect keys or execute project code. Writes are
 * serialized: a second POST while one is in flight gets a 409.
 */
export function createBraintrustRoute(workspace: Workspace) {
  const store = new BraintrustStore(workspace.braintrustDir);
  let saving = false;

  return async (req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> => {
    if (!url.pathname.startsWith(PREFIX)) return false;
    const send = (status: number, value: unknown) => sendJson(res, status, value);
    const body = () => readJsonBody(req, 2_000_000);
    if (!trustedRequest(req)) {
      send(403, { error: UNTRUSTED_MESSAGE });
      return true;
    }
    const isWrite = req.method === "POST";
    if (isWrite && saving) {
      send(409, { error: "Another change is being saved. Try again." });
      return true;
    }
    if (isWrite) saving = true;

    try {
      const action = url.pathname.slice(PREFIX.length);
      if (req.method === "GET" && action === "status") {
        const conn = await store.readConnection();
        send(200, { connected: !!conn, projectId: conn?.projectId, threshold: conn?.threshold ?? DEFAULT_THRESHOLD });
      } else if (req.method === "POST" && action === "connect") {
        const { apiKey } = ConnectSchema.parse(await body());
        const projects = await new BraintrustClient(apiKey).projects();
        const projectId = projects.length === 1 ? projects[0].id : undefined;
        await store.saveConnection({ apiKey, threshold: DEFAULT_THRESHOLD, ...(projectId ? { projectId } : {}) });
        send(200, { projects, projectId });
      } else if (req.method === "GET" && action === "projects") {
        const conn = await requireConnection(store);
        send(200, { projects: await new BraintrustClient(conn.apiKey).projects() });
      } else if (req.method === "POST" && action === "project") {
        const selection = ProjectSelectionSchema.parse(await body());
        const conn = await requireConnection(store);
        const projects = await new BraintrustClient(conn.apiKey).projects();
        if (!projects.some((p) => p.id === selection.projectId))
          throw new Error("That project is not accessible with this key.");
        await store.saveConnection({ ...conn, ...selection });
        send(200, { ok: true });
      } else if (req.method === "GET" && action === "incidents") {
        const inbox = await store.fetchInbox(url.searchParams.get("older") === "1");
        const saved = await savedTests();
        send(200, {
          ...inbox,
          incidents: inbox.incidents.map((i) =>
            saved.has(i.id) ? { ...i, savedFile: saved.get(i.id)!.file, savedRevision: saved.get(i.id)!.revision } : i,
          ),
        });
      } else if (req.method === "GET" && action === "scenario") {
        send(200, await store.loadScenario(url.searchParams.get("id") ?? ""));
      } else if (req.method === "POST" && action === "review") {
        send(200, await saveReview(store, ReviewSchema.parse(await body())));
      } else if (req.method === "POST" && action === "add") {
        send(200, await addIncidentTest(store, IncidentIdSchema.parse(await body()).id));
      } else if (req.method === "GET" && action === "missing") {
        const scenario = await store.loadScenario(url.searchParams.get("id") ?? "");
        send(200, await missingResponses(workspace, incidentTest(scenario).name));
      } else {
        send(404, { error: "Unknown Braintrust action." });
      }
    } catch (err) {
      send(400, {
        error:
          err instanceof z.ZodError
            ? "The request or Braintrust response has an unsupported shape."
            : err instanceof Error
              ? err.message
              : "Braintrust request failed.",
      });
    } finally {
      if (isWrite) saving = false;
    }
    return true;
  };
}

async function requireConnection(store: BraintrustStore) {
  const conn = await store.readConnection();
  if (!conn) throw new Error("Connect Braintrust first.");
  return conn;
}

/** Save the user's review of an incident: expectations, required tools, and supplied tool responses. */
async function saveReview(store: BraintrustStore, update: z.infer<typeof ReviewSchema>) {
  const draft = await store.loadScenario(update.id);
  if (draft.blockers.length) throw new Error(draft.blockers.join(" "));
  if (!update.expectation && !update.mustCallTools.length)
    throw new Error("Describe correct behavior or select at least one required tool.");
  draft.expectation = update.expectation;
  draft.mustCallTools = update.mustCallTools;
  draft.reviewed = true;
  for (const response of update.responses) {
    // A user-supplied response replaces any recorded one for the same call.
    draft.responses = draft.responses.filter(
      (r) =>
        !(
          r.tool === response.tool &&
          strictCanonical(r.input) === strictCanonical(response.input) &&
          r.occurrence === response.occurrence
        ),
    );
    draft.responses.push({ ...response, source: "user" });
  }
  await store.saveScenario(draft);
  return { ...draft, reviewRevision: reviewRevision(draft) };
}

/** A reviewed incident becomes a test in the suite, run by every comparison like any other. */
async function addIncidentTest(store: BraintrustStore, id: string) {
  const draft = await store.loadScenario(id);
  if (!draft.reviewed || draft.blockers.length) throw new Error("Review the expectations and missing context first.");
  const doc = await configDocument();
  const dir = await projectPath(doc.rootDir, doc.config.tests);
  const file = incidentTestFile(draft);
  const revision = reviewRevision(draft);
  await writeJson(path.join(dir, file), {
    ...incidentTest(draft),
    _agentdiff: { source: { kind: "braintrust", incidentId: id, reviewRevision: revision } },
  });
  return { file, testsDir: doc.config.tests, reviewRevision: revision };
}

/** Incidents saved as tests: incident id → the test file and the review it was saved from. */
async function savedTests(): Promise<Map<string, { file: string; revision: string }>> {
  const saved = new Map<string, { file: string; revision: string }>();
  try {
    const doc = await configDocument();
    const dir = await projectPath(doc.rootDir, doc.config.tests);
    for (const file of (await listDir(dir)).filter((f) => f.endsWith(".json"))) {
      try {
        const source = (await readJson<{ _agentdiff?: { source?: Record<string, unknown> } }>(path.join(dir, file)))
          ._agentdiff?.source;
        if (source?.kind === "braintrust" && typeof source.incidentId === "string")
          saved.set(source.incidentId, { file, revision: source.reviewRevision as string });
      } catch {
        /* The project summary reports malformed tests separately. */
      }
    }
  } catch {
    /* No config or tests directory yet: nothing saved. */
  }
  return saved;
}

/** Tool calls the latest comparison that ran this incident's test had no response for. */
async function missingResponses(
  workspace: Workspace,
  testName: string,
): Promise<{ dir: string | null; missing: MissingResponse[] }> {
  for (const dir of await workspace.listCompareDirs()) {
    const runs = await readComparisonRuns(workspace.compareDir(dir));
    const records = [...runs.new, ...runs.old].filter((r) => r.test === testName);
    if (!records.length) continue;
    const missing = new Map<string, MissingResponse>();
    for (const r of records) for (const m of r.replay?.missing ?? []) missing.set(strictCanonical(m), m);
    return { dir, missing: [...missing.values()] };
  }
  return { dir: null, missing: [] };
}
