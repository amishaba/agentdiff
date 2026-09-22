import { it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PassThrough } from "node:stream";
import type http from "node:http";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const [major, minor] = process.versions.node.split(".").map(Number);
const supportsMastra = major > 22 || (major === 22 && minor >= 13);

it(
  "connects, reviews an incident, saves it as a test that every comparison runs, and reuses a supplied response",
  { timeout: 60_000, skip: !supportsMastra },
  async () => {
    const originalCwd = process.cwd();
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.OPENAI_API_KEY;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentdiff-braintrust-"));
    try {
      let mastraPackage: string;
      try {
        mastraPackage = require.resolve("@mastra/core/package.json");
      } catch {
        mastraPackage = createRequire(new URL("../example/package.json", import.meta.url)).resolve(
          "@mastra/core/package.json",
        );
      }
      const modules = path.resolve(path.dirname(mastraPackage), "../..");
      await fs.symlink(modules, path.join(dir, "node_modules"), "junction");
      await fs.writeFile(path.join(dir, "package.json"), '{"type":"module"}');
      await fs.writeFile(
        path.join(dir, "agentdiff.config.ts"),
        'export default { agent: "agent", agentPath: "./agent.ts", tests: "./tests", runsPerTest: 2 };',
      );
      const agentCode = (tool: string) => `
      import { Agent } from '@mastra/core/agent';
      import { z } from 'zod';
      const model = { specificationVersion: 'v2', provider: 'test', modelId: 'offline', supportedUrls: {},
        doGenerate: async ({prompt}) => { const done=prompt.some(m=>m.role==='tool'); return {
          content: done ? [{type:'text',text:'done'}] : [{type:'tool-call',toolCallId:'call',toolName:'${tool}',input:'{"id":1}'}],
          finishReason: done?'stop':'tool-calls', usage:{inputTokens:1,outputTokens:1}, warnings:[] }; } };
      export const agent = new Agent({id:'support',name:'support',instructions:'Use ${tool}.',model,
        tools:{${tool}:{id:'${tool}',description:'test',inputSchema:z.object({id:z.number()}),outputSchema:z.object({ok:z.boolean()}),
          execute:async()=>{throw new Error('Production executor must never run');}}}});
    `;
      await fs.writeFile(path.join(dir, "agent.ts"), agentCode("lookup"));
      await fs.writeFile(path.join(dir, ".gitignore"), "node_modules/\n.agentdiff/\n");
      await fs.mkdir(path.join(dir, "tests"));
      await fs.writeFile(path.join(dir, "tests", ".gitkeep"), "");
      await exec("git", ["init", "-b", "main"], { cwd: dir });
      await exec("git", ["add", "."], { cwd: dir });
      await exec(
        "git",
        ["-c", "user.name=AgentDiff test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"],
        { cwd: dir },
      );
      await fs.writeFile(path.join(dir, "agent.ts"), agentCode("fraud"));
      process.chdir(dir);
      process.env.OPENAI_API_KEY = "";
      // No model calls from agentdiff itself; the replay's own tool responses are what's under test.
      process.env.AGENTDIFF_OFFLINE = "1";
      const project = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      globalThis.fetch = (async (url: URL) => {
        assert.equal(url.origin, "https://api.braintrust.dev");
        if (url.pathname === "/v1/project") return Response.json({ objects: [{ id: project, name: "support" }] });
        return Response.json({
          events: [
            {
              id: "r",
              span_id: "r",
              root_span_id: "r",
              input: "refund",
              scores: { quality: 0.1 },
              metrics: { start: 1, end: 3 },
            },
            {
              id: "t",
              span_id: "t",
              root_span_id: "r",
              span_parents: ["r"],
              span_attributes: { type: "tool", name: "lookup" },
              input: { id: 1 },
              output: { ok: true },
              metrics: { start: 1, end: 2 },
            },
          ],
          cursor: null,
        });
      }) as typeof fetch;
      // No browser or network listener: exercise the local API handler directly.
      const { createBraintrustRoute } = await import("../src/dashboard/braintrust/routes.ts");
      const { Workspace } = await import("../src/storage/workspace.ts");
      const braintrustRoute = createBraintrustRoute(new Workspace(process.cwd()));
      async function api(action: string, value?: unknown): Promise<any> {
        const req = new PassThrough() as unknown as http.IncomingMessage;
        req.method = value === undefined ? "GET" : "POST";
        req.headers = {
          host: "localhost:4321",
          origin: "http://localhost:4321",
          "x-agentdiff": "local",
          "content-type": "application/json",
        };
        let code = 0;
        let output = "";
        const res = {
          writeHead(status: number) {
            code = status;
          },
          end(body: string) {
            output = body;
          },
        } as unknown as http.ServerResponse;
        (req as unknown as PassThrough).end(value === undefined ? "" : JSON.stringify(value));
        await braintrustRoute(req, res, new URL(`http://localhost:4321/api/braintrust/${action}`));
        assert.ok(code >= 200 && code < 300, output);
        return JSON.parse(output);
      }
      const { runComparison } = await import("../src/pipeline/compare.ts");
      const connected = await api("connect", { apiKey: "test-only-key" });
      assert.equal(connected.projectId, project);
      assert.equal((await fs.stat(path.join(dir, ".agentdiff/braintrust/connection.json"))).mode & 0o777, 0o600);
      assert.equal(JSON.stringify(await api("status")).includes("test-only-key"), false);
      const { incidents } = await api("incidents");
      assert.equal(incidents.length, 1);
      const id = incidents[0].id;
      const draft = await api(`scenario?id=${id}`);
      assert.equal(draft.reviewed, false);
      const reviewed = await api("review", { id, expectation: "", mustCallTools: ["fraud"] });
      const refreshed = await api("incidents");
      assert.equal(refreshed.incidents[0].reviewed, true);
      assert.equal(refreshed.incidents[0].reviewRevision, reviewed.reviewRevision);
      assert.ok(refreshed.incidents[0].scores.some((s: any) => s.value === 0.1));
      // Saving writes an ordinary test file; the comparison runs it like any other test.
      const added = await api("add", { id });
      const saved = JSON.parse(await fs.readFile(path.join(dir, "tests", added.file), "utf8"));
      assert.deepEqual(
        [saved.input, saved.must_call_tools, saved.replay.incidentId, saved._agentdiff.source.kind],
        ["refund", ["fraud"], id, "braintrust"],
      );
      assert.equal((await api("incidents")).incidents[0].savedFile, added.file);
      const blocked = await runComparison("main");
      assert.equal(blocked.skipped, false);
      if (blocked.skipped) return;
      assert.equal(
        blocked.comparison.stages?.find((s) => s.stage === "discover")?.status,
        "skipped",
        "every test is a recorded incident",
      );
      // The new agent calls a tool the recording never answered: the runs are blocked, never answered with a guess.
      const missing = await api(`missing?id=${id}`);
      assert.equal(missing.dir, path.basename(blocked.dir));
      assert.deepEqual(missing.missing, [{ tool: "fraud", input: { id: 1 }, occurrence: 1 }]);
      await api("review", {
        id,
        expectation: "",
        mustCallTools: ["fraud"],
        responses: [{ ...missing.missing[0], output: { ok: true }, source: "user" }],
      });
      const updated = await api("add", { id });
      assert.equal(updated.file, added.file, "the same incident updates its test");
      const complete = await runComparison("main");
      assert.equal(complete.skipped, false);
      if (complete.skipped) return;
      const t = complete.comparison.tests[0];
      assert.equal(t.old.runs, 2);
      assert.equal(t.new.runs, 2);
      assert.equal(t.old.toolCallRate.fraud?.called ?? 0, 0);
      assert.equal(t.new.toolCallRate.fraud.called, 2);
      assert.equal(t.new.errors, 0);
      assert.deepEqual((await api(`missing?id=${id}`)).missing, []);
      assert.equal((await api(`scenario?id=${id}`)).responses.find((r: any) => r.tool === "fraud").source, "user");
    } finally {
      process.chdir(originalCwd);
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalKey;
      delete process.env.AGENTDIFF_OFFLINE;
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);
