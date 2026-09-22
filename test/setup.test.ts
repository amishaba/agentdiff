// First-run setup: finding the agent, and what `npx agentdiff` writes into a project.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";
import { agentExports, findAgents } from "../src/agent/find.ts";
import { configSource, ignoreInGit, saveEnv, starterTestsDir, writeConfig } from "../src/config/setup.ts";
import { cleanStarterTests } from "../src/suite/starter.ts";
import { ConfigSchema } from "../src/types.ts";

const tempDir = () => fs.mkdtemp(path.join(os.tmpdir(), "agentdiff-setup-"));

describe("agentExports", () => {
  it("finds exported agents however they're exported", () => {
    assert.deepEqual(agentExports(`export const support = new Agent({ name: "support" });`), ["support"]);
    assert.deepEqual(agentExports(`export const desk: Agent<Ctx> = new Agent<Ctx>({});`), ["desk"]);
    assert.deepEqual(agentExports(`export default new Agent({});`), ["default"]);
    assert.deepEqual(agentExports(`export const a = Agent.create({});`), ["a"]);
    assert.deepEqual(agentExports(`const desk = new Agent({});\nexport { desk as support, other };`), ["support"]);
  });
  it("ignores agents that aren't exported, and things that aren't agents", () => {
    assert.deepEqual(agentExports(`const helper = new Agent({});\nexport const x = new Map();`), []);
  });
});

describe("findAgents", () => {
  it("reads the project's source for Mastra and OpenAI Agents SDK agents, skipping tests and node_modules", async () => {
    const dir = await tempDir();
    const write = async (file: string, body: string) => {
      await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await fs.writeFile(path.join(dir, file), body);
    };
    await write(
      "src/mastra/agents/weather.ts",
      `import { Agent } from "@mastra/core/agent";\nexport const weatherAgent = new Agent({});`,
    );
    await write("agents/desk.ts", `import { Agent } from "@openai/agents";\nexport const desk = new Agent({});`);
    await write("agents/desk.test.ts", `import { Agent } from "@openai/agents";\nexport const fake = new Agent({});`);
    await write("lib/other.ts", `class Agent {}\nexport const notOne = new Agent();`);
    await write(
      "node_modules/pkg/index.js",
      `import { Agent } from "@mastra/core";\nexport const dep = new Agent({});`,
    );
    execFileSync("git", ["init", "-q"], { cwd: dir });
    assert.deepEqual(await findAgents(dir), [
      { file: "agents/desk.ts", exportName: "desk", framework: "openai-agents" },
      { file: "src/mastra/agents/weather.ts", exportName: "weatherAgent", framework: "mastra" },
    ]);
  });
});

describe("what setup writes", () => {
  it("writes a config the loader accepts, and never replaces one", async () => {
    const dir = await tempDir();
    const file = await writeConfig(dir, { agent: "desk", agentPath: "./agents/desk.ts", tests: "./tests" });
    const loaded = (await import(pathToFileURL(file).href)).default;
    assert.deepEqual(ConfigSchema.parse(loaded), {
      agent: "desk",
      agentPath: "./agents/desk.ts",
      tests: "./tests",
      runsPerTest: 10,
      concurrency: 8,
    });
    await assert.rejects(writeConfig(dir, { agent: "x", agentPath: "./x.ts", tests: "./t" }));
    assert.match(configSource({ agent: 'a "b"', agentPath: "./a.ts", tests: "./t" }), /agent: "a \\"b\\""/);
  });

  it("fills empty keys in .env, adds missing ones, and leaves set ones alone", async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, ".env"), "OPENAI_API_KEY=sk-old\nEMPTY=");
    assert.deepEqual(await saveEnv(dir, { OPENAI_API_KEY: "sk-new", AGENTDIFF_GRADER: "openai", EMPTY: "set" }), [
      "AGENTDIFF_GRADER",
      "EMPTY",
    ]);
    assert.equal(
      await fs.readFile(path.join(dir, ".env"), "utf8"),
      "OPENAI_API_KEY=sk-old\nEMPTY=set\nAGENTDIFF_GRADER=openai\n",
    );
  });

  it("adds .env and .agentdiff/ to .gitignore once", async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, ".gitignore"), "node_modules\n/.agentdiff");
    assert.deepEqual(await ignoreInGit(dir, [".env", ".agentdiff/"]), [".env"]);
    assert.deepEqual(await ignoreInGit(dir, [".env", ".agentdiff/"]), []);
  });

  it("puts starter tests in tests/ unless the project already uses it for something else", async () => {
    const dir = await tempDir();
    assert.deepEqual(await starterTestsDir(dir), { dir: "./tests", existing: 0 });
    await fs.mkdir(path.join(dir, "tests"));
    await fs.writeFile(path.join(dir, "tests", "refund.json"), JSON.stringify({ name: "refund", input: "hi" }));
    assert.deepEqual(await starterTestsDir(dir), { dir: "./tests", existing: 1 });
    await fs.writeFile(path.join(dir, "tests", "math.test.ts"), "");
    assert.deepEqual(await starterTestsDir(dir), { dir: "./agentdiff-tests", existing: 0 });
  });

  it("keeps only the tools the agent has in drafted tests", () => {
    const drafted = [
      { name: "refund", input: "refund me", must_call_tools: ["lookup", "made_up", "lookup"], grading_criteria: "c" },
      { name: " ", input: "x", must_call_tools: [], grading_criteria: "c" },
    ];
    assert.deepEqual(cleanStarterTests(drafted, ["lookup"]), [
      { name: "refund", input: "refund me", must_call_tools: ["lookup"], grading_criteria: "c" },
    ]);
  });
});
