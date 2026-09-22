import { it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { runComparison } from "../src/pipeline/compare.ts";
import { createProbeRunner, fixturesFromTests } from "../src/discovery/runner.ts";
import { DiscoveryConfigSchema } from "../src/discovery/types.ts";
import { TestFileSchema, type TestFile } from "../src/types.ts";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const [major, minor] = process.versions.node.split(".").map(Number);
const supportsMastra = major > 22 || (major === 22 && minor >= 13);
let packagePath: string;
try {
  packagePath = require.resolve("@mastra/core/package.json");
} catch {
  packagePath = createRequire(new URL("../example/package.json", import.meta.url)).resolve("@mastra/core/package.json");
}
const agentPath = createRequire(packagePath).resolve("@mastra/core/agent");
const { Agent } = supportsMastra ? await import(pathToFileURL(agentPath).href) : { Agent: undefined };

function offlineModel(hang = false) {
  return {
    specificationVersion: "v2",
    provider: "test",
    modelId: "offline",
    supportedUrls: {},
    doGenerate: async ({ prompt }: any) => {
      if (hang) return new Promise(() => {});
      const done = prompt.some((m: any) => m.role === "tool");
      return {
        content: done
          ? [{ type: "text", text: "done" }]
          : [{ type: "tool-call", toolCallId: "c", toolName: "read_file", input: '{"path":"a.txt"}' }],
        finishReason: done ? "stop" : "tool-calls",
        usage: { inputTokens: 1, outputTokens: 1 },
        warnings: [],
      };
    },
  };
}
function fileAgent(hang = false) {
  const agent = new Agent({
    id: "file-agent",
    name: "file-agent",
    instructions: "Read a file",
    model: offlineModel(hang),
    tools: {
      read_file: {
        id: "read_file",
        description: "Read a file",
        inputSchema: z.object({ path: z.string() }),
        outputSchema: z.object({ count: z.number() }),
        execute: async () => assert.fail("Original tool executor was called"),
      },
    },
  });
  Object.defineProperty(agent, "__agentdiffReplaySupported", { value: true });
  return agent;
}

it("discovery uses fresh tool state per attempt and stops invalid fixtures", { skip: !supportsMastra }, async () => {
  const agents = { old: fileAgent(), new: fileAgent() };
  const config = DiscoveryConfigSchema.parse({ timeoutMs: 2000 });
  const run = await createProbeRunner(
    agents,
    () => {
      let count = 0;
      return { read_file: () => ({ count: ++count }) };
    },
    config,
  );
  for (const version of ["old", "new", "old"] as const) {
    const record = await run({ input: "Read a.txt" }, version, 1, "files");
    assert.equal(record.error, null);
    assert.deepEqual(record.tool_calls[0].output, { count: 1 });
  }
  // Fixtures are built from the case's context.
  const contexts: unknown[] = [];
  const withContext = await createProbeRunner(
    agents,
    (context) => {
      contexts.push(context);
      return { read_file: () => ({ count: 1 }) };
    },
    config,
  );
  await withContext({ input: "Read a.txt", context: { owner: "ops" } }, "new", 1, "context");
  assert.deepEqual(contexts.at(-1), { owner: "ops" });
  await assert.rejects(
    createProbeRunner(agents, () => ({}), config),
    /fixture for read_file/,
  );
  const invalid = await createProbeRunner(agents, () => ({ read_file: () => ({ wrong: true }) }), config);
  assert.match((await invalid({ input: "Read a.txt" }, "new", 1, "invalid")).error!, /output schema/);
  const missing = await createProbeRunner(agents, () => ({ read_file: () => undefined }), config);
  assert.match((await missing({ input: "Read a.txt" }, "old", 1, "missing")).error!, /returned undefined/);
  const bounded = await createProbeRunner(agents, () => ({ read_file: () => ({ count: 1 }) }), {
    ...config,
    maxSteps: 1,
  });
  assert.match((await bounded({ input: "Read a.txt" }, "old", 1, "step-limit")).error!, /step limit/);
});

it("discovery bounds a stalled model call", { skip: !supportsMastra, timeout: 3000 }, async () => {
  const agent = fileAgent(true);
  const run = await createProbeRunner(
    { old: agent, new: agent },
    () => ({ read_file: () => ({ count: 1 }) }),
    DiscoveryConfigSchema.parse({ timeoutMs: 100 }),
  );
  assert.match((await run({ input: "Read a.txt" }, "old", 1, "timeout")).error!, /exceeded 100ms/);
});

it(
  "compares Git versions, plans experiments, verifies findings, writes drafts, and preserves the normal report",
  { skip: !supportsMastra, timeout: 60_000 },
  async () => {
    const cwd = process.cwd();
    const fetch = globalThis.fetch;
    const originalKey = process.env.OPENAI_API_KEY;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentdiff-discovery-"));
    let plannerCalls = 0;
    try {
      await fs.symlink(path.resolve(path.dirname(packagePath), "../.."), path.join(dir, "node_modules"), "junction");
      await fs.writeFile(path.join(dir, "package.json"), '{"type":"module"}');
      await fs.mkdir(path.join(dir, "tests"));
      await fs.writeFile(
        path.join(dir, "tests", "baseline.json"),
        JSON.stringify({ name: "ordinary baseline", input: "baseline" }),
      );
      await fs.writeFile(
        path.join(dir, "agentdiff.config.ts"),
        `export default {
      agent: "agent", agentPath: "./agent.ts", tests: "tests", runsPerTest: 1, grader: "openai",
      discovery: { fixtures: "./fixtures.ts", context: "Document alpha exists", maxCandidates: 1, maxRounds: 1, maxFindings: 1, maxAgentRuns: 28 }
    };`,
      );
      await fs.writeFile(
        path.join(dir, "fixtures.ts"),
        `export function createFixtures() { return { search: () => ({value:"alpha"}), fetch: () => ({value:"document alpha"}) }; }`,
      );
      const code = (fast: boolean) => `
      import { Agent } from '@mastra/core/agent';
      import { z } from 'zod';
      const model = { specificationVersion:'v2', provider:'test', modelId:'offline', supportedUrls:{},
        doGenerate: async ({prompt}) => {
          const input=JSON.stringify(prompt.filter(m=>m.role==='user'));
          const step=prompt.filter(m=>m.role==='tool').length;
          const tools=input.includes('baseline') ? [] : ${fast} && input.includes('quick') ? ['search'] : ['search','fetch'];
          const tool=tools[step];
          return {content:tool?[{type:'tool-call',toolCallId:'c'+step,toolName:tool,input:JSON.stringify({query:'alpha'})}]:[{type:'text',text:'done'}],
            finishReason:tool?'tool-calls':'stop',usage:{inputTokens:1,outputTokens:1},warnings:[]};
        }};
      export const agent=new Agent({id:'researcher',name:'researcher',instructions:${JSON.stringify(fast ? "Use snippets for quick answers." : "Fetch sources before answering.")},model,
        tools:Object.fromEntries(['search','fetch'].map(name=>[name,{id:name,description:name+' documents',inputSchema:z.object({query:z.string()}),outputSchema:z.object({value:z.string()}),
          execute:async()=>{throw new Error('Original tool executor must not run for discovery');}}]))});`;
      await fs.writeFile(path.join(dir, "agent.ts"), code(false));
      await fs.writeFile(path.join(dir, ".gitignore"), "node_modules/\n.agentdiff/\n");
      await exec("git", ["init", "-b", "main"], { cwd: dir });
      await exec("git", ["add", "."], { cwd: dir });
      await exec(
        "git",
        ["-c", "user.name=AgentDiff test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial agent"],
        { cwd: dir },
      );
      await fs.writeFile(path.join(dir, "agent.ts"), code(true));
      process.chdir(dir);
      process.env.OPENAI_API_KEY = "test-only-key";
      globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
        assert.equal(new URL(String(url)).hostname, "api.openai.com");
        const body = JSON.parse(String(init?.body));
        const system = body.messages.find((m: any) => m.role === "system" || m.role === "developer")?.content ?? "";
        let content = "The prompt changed. Inspect the recorded evidence.";
        if (system.includes("Design behavioral experiments")) {
          plannerCalls++;
          const request = JSON.parse(body.messages.find((m: any) => m.role === "user").content);
          if (request.experiment) content = JSON.stringify({ experiment: null });
          else {
            assert.equal(request.oldAgent.name, "researcher");
            assert.match(JSON.stringify(request.oldAgent.toolDefinitions), /query/);
            content = JSON.stringify({
              experiments: [
                {
                  name: "Quick source request",
                  strategy: "wording",
                  changeId: "instructions",
                  hypothesis: "Does requesting speed skip fetching sources?",
                  baseTest: null,
                  conversation: null,
                  control: "Explain alpha carefully",
                  variant: "Explain alpha quickly",
                  controlContextJson: null,
                  variantContextJson: null,
                  controlExpected: "Fetch the source, then explain.",
                  variantExpected: "Fetch the source, then explain briefly.",
                  targetTools: ["search", "fetch"],
                },
              ],
            });
          }
        }
        return Response.json({
          id: "test",
          object: "chat.completion",
          created: 1,
          model: "offline",
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }) as typeof globalThis.fetch;
      const result = await runComparison("main");
      assert.equal(result.skipped, false);
      if (result.skipped) return;
      const d = result.comparison.discovery!;
      assert.equal(d.findings.length, 1, JSON.stringify(d));
      assert.equal(d.agentRuns, 20);
      assert.equal(plannerCalls, 2);
      assert.equal(result.comparison.tests.length, 1);
      assert.equal(result.comparison.stages?.find((s) => s.stage === "discover")?.status, "done");
      assert.match(await fs.readFile(result.reportPath, "utf8"), /Discovered behavior changes/);
      const evidence = JSON.parse(await fs.readFile(path.join(result.dir, "discovery/experiments/e002.json"), "utf8"));
      assert.equal(evidence.phase, "confirm");
      assert.equal((await fs.readdir(path.join(result.dir, "discovery/runs"))).length, 20);
      const draft = JSON.parse(await fs.readFile(path.join(result.dir, "discovery/drafts/f001-variant.json"), "utf8"));
      assert.equal(TestFileSchema.parse(draft).input, "Explain alpha quickly");
      assert.equal(
        draft.grading_criteria,
        "Fetch the source, then explain briefly.",
        "the planner's expectation, for review",
      );
      assert.equal(draft.must_call_tools, undefined);
      // Each case's confirmation runs are judged like suite runs and labelled.
      assert.equal(d.findings[0].judged?.length, 2);
      assert.equal(d.findings[0].kinds?.length, 2);
      const worktrees = (await exec("git", ["worktree", "list", "--porcelain"], { cwd: dir })).stdout;
      assert.equal(worktrees.split("\n").filter((l) => l.startsWith("worktree ")).length, 1);
    } finally {
      process.chdir(cwd);
      globalThis.fetch = fetch;
      if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalKey;
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);

it("without a fixtures module, answers tools the way the tests do", async () => {
  const tests: TestFile[] = [
    { name: "declined", input: "pay", tool_responses: { charge: [{ status: "declined" }, { status: "ok" }] } },
    { name: "paid", input: "pay", tool_responses: { charge: [{ status: "ok" }] } },
    { name: "paid again", input: "pay", tool_responses: { charge: [{ status: "ok" }] } },
  ];
  const factory = fixturesFromTests(tests, ["charge", "notify"]);
  // A case built on a test gets that test's answers, in call order, then the last one again.
  const based = factory(undefined, { input: "pay", baseTest: "declined" });
  assert.deepEqual(
    [await based.charge({}), await based.charge({}), await based.charge({})],
    [{ status: "declined" }, { status: "ok" }, { status: "ok" }],
  );
  // Any other case gets each tool's most common answer; a tool no test answers, a plain success.
  const plain = factory(undefined, { input: "pay" });
  assert.deepEqual([await plain.charge({}), await plain.notify({})], [{ status: "ok" }, { ok: true }]);
  assert.deepEqual(await factory(undefined, { input: "pay", baseTest: "declined" }).charge({}), {
    status: "declined",
  });
});
