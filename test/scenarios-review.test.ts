// Reviewing scenarios in the dashboard, through the real server and worker: a
// scenarios job writes drafts (against a stubbed OpenAI), then the page lists
// them and adds chosen ones to the suite.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { JobManager } from "../src/dashboard/jobs/manager.ts";
import { createViewServer } from "../src/dashboard/server.ts";
import type { DashboardJob } from "../src/dashboard/jobs/types.ts";
import type { ScenarioRun, ScenarioRunSummary } from "../src/dashboard/scenarios/types.ts";

const PLAN = {
  items: [{ area: "job", title: "refund an order", focus: "Refunds after a lookup.", rule: null, tools: ["refund"] }],
};
const scenario = (name: string) => ({
  name,
  conversation: [{ role: "user", content: "hi" }],
  contextJson: '{"customer":"C-7"}',
  input: "refund order 7",
  toolResponses: [
    { tool: "lookup_customer", outputsJson: '{"verified":true}' },
    { tool: "refund", outputsJson: '[{"status":"declined"}]' },
  ],
  mustCallTools: ["lookup_customer", "refund"],
  mustNotCallTools: [],
  gradingCriteria: "Says the refund was declined.",
  checks: [],
});

/** A project whose OpenAI calls are answered locally: the plan for the planner, one scenario per item for the writer. */
async function project(dir: string) {
  await fs.writeFile(
    path.join(dir, "agent.mjs"),
    `export const agent = { name: "billing", instructions: "Look up the customer first. Never refund twice.", tools: ["lookup_customer", "refund"], run: async () => ({ text: "ok" }) };\n`,
  );
  await fs.writeFile(
    path.join(dir, "agentdiff.config.mjs"),
    `process.env.OPENAI_API_KEY = "offline-test-key";
const plan = ${JSON.stringify(PLAN)};
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith("https://api.openai.com/")) throw new Error("Unexpected network request");
  const { messages } = JSON.parse(init.body);
  const item = messages[0].content.includes("plan test coverage") ? null : JSON.parse(messages[1].content).item;
  const content = item ? { scenarios: [${JSON.stringify(scenario("__"))}].map((s) => ({ ...s, name: item.title + " case" })) } : plan;
  return Response.json({ id: "t", object: "chat.completion", created: 1, model: "offline", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(content) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
};
export default { agent: "agent", agentPath: "agent.mjs", tests: "tests" };
`,
  );
}

it("writes scenarios as a job, lists them, and adds chosen ones to the suite once", { timeout: 90_000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentdiff-scenarios-review-"));
  const manager = new JobManager(dir),
    server = createViewServer(manager);
  try {
    await project(dir);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const call = async (p: string, body?: unknown) => {
      const response = await fetch(base + p, {
        method: body === undefined ? "GET" : "POST",
        headers: { "x-agentdiff": "local", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, data: (await response.json()) as any };
    };
    assert.equal((await fetch(base + "/api/scenarios")).status, 403, "a request from another page is refused");

    let job = (await call("/api/jobs/scenarios", { perItem: 1 })).data as DashboardJob;
    while (job.status === "running") {
      await new Promise((r) => setTimeout(r, 200));
      job = (await call(`/api/jobs/${job.id}`)).data;
    }
    assert.equal(job.status, "complete", job.message);
    assert.match(job.resultDir!, /^scenarios-/);
    // One planned item plus the prompt's two rules, one scenario each.
    assert.equal(job.message, "3 scenarios for 3 things to cover · no gaps");

    const runs = (await call("/api/scenarios")).data as ScenarioRunSummary[];
    assert.deepEqual(
      runs.map((r) => [r.dir, r.agentName, r.scenarios, r.items]),
      [[job.resultDir, "billing", 3, 3]],
    );
    const read = async () => (await call(`/api/scenarios/run?dir=${job.resultDir}`)).data as ScenarioRun;
    let run = await read();
    assert.equal(run.testsDir, "tests");
    const [first, second] = run.drafts;
    assert.equal(first.test.name, "refund an order case");
    assert.equal(first.savedFile, undefined);

    const add = (files: string[], requestId = randomUUID()) =>
      call("/api/scenarios/add", { requestId, dir: job.resultDir, files });
    const requestId = randomUUID();
    const added = await add([first.file], requestId);
    assert.deepEqual(added.data, { files: ["refund-an-order-case.json"], testsDir: "tests" });
    const saved = JSON.parse(await fs.readFile(path.join(dir, "tests", "refund-an-order-case.json"), "utf8"));
    assert.deepEqual(saved._agentdiff.source, {
      kind: "scenario",
      dir: job.resultDir,
      file: first.file,
      revision: first.revision,
    });
    assert.deepEqual(saved.tool_responses.refund, [{ status: "declined" }], "the made-up tool answers come along");
    assert.deepEqual(
      (await add([first.file], requestId)).data,
      added.data,
      "a retried request returns its first result",
    );
    assert.deepEqual(
      (await add([first.file, second.file])).data.files,
      ["refund-an-order-case.json", "look-up-the-customer-first-case.json"],
      "an added draft isn't added twice",
    );
    assert.equal((await fs.readdir(path.join(dir, "tests"))).length, 2);

    run = await read();
    assert.equal(run.drafts[0].savedFile, "refund-an-order-case.json");
    // A draft edited after it was added is a new draft; one edited into an invalid test says why.
    const draftFile = path.join(dir, ".agentdiff", job.resultDir!, "tests", first.file);
    await fs.writeFile(draftFile, JSON.stringify({ ...saved, grading_criteria: "Edited." }));
    await fs.writeFile(
      path.join(dir, ".agentdiff", job.resultDir!, "tests", run.drafts[2].file),
      JSON.stringify({ name: "broken" }),
    );
    run = await read();
    assert.equal(run.drafts[0].savedFile, undefined);
    assert.equal(run.drafts[0].test.grading_criteria, "Edited.");
    assert.ok(run.drafts[2].issue, "an invalid draft says why");
    const refused = await add([run.drafts[2].file]);
    assert.equal(refused.status, 400);
    assert.match(refused.data.error, /isn't a valid test/);
    assert.equal((await call("/api/scenarios/run?dir=../outside")).status, 400, "only scenario folders are read");
  } finally {
    server.close();
  }
});
