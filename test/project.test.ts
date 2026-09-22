import { it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { ConfigSchema } from "../src/types.ts";
import { configEditability, editConfigSource } from "../src/dashboard/project/config-editor.ts";
import { projectPath } from "../src/dashboard/project/files.ts";
import type { ProjectState, DraftList } from "../src/dashboard/project/types.ts";
import { JobManager } from "../src/dashboard/jobs/manager.ts";
import { createViewServer } from "../src/dashboard/server.ts";
import { claimExecution } from "../src/dashboard/execution-lock.ts";
import { writeScenarios } from "../src/suite/write.ts";
import { projectFixture, discoveryFixture, scenarios } from "./fixtures/project.ts";

it("edits config AST ranges while preserving comments, imports, CRLF, and surrounding code", () => {
  const source =
    'import type { Config } from "agentdiff";\r\nconst tests = "tests";\r\nconst config = {\r\n  agent:"agent", // export name\r\n  agentPath:"agent.mjs",\r\n  tests,\r\n  versions:{old:"old.mjs",/* new version */new:"new.mjs"},\r\n  discovery:{maxRounds:2, /* budget */ maxCandidates:4}\r\n} satisfies Config;\r\nexport default (config);\r\n';
  const current = ConfigSchema.parse({
    agent: "agent",
    agentPath: "agent.mjs",
    tests: "tests",
    versions: { old: "old.mjs", new: "new.mjs" },
    discovery: { maxRounds: 2, maxCandidates: 4 },
  });
  assert.equal(editConfigSource(source, current, current), source);
  const edited = editConfigSource(source, current, {
    ...current,
    agent: 'my "agent"',
    tests: "reviewed",
    runsPerTest: 7,
    versions: { old: "old.mjs", new: "next.mjs" },
    discovery: { ...current.discovery!, maxRounds: 3, maxCandidates: 6 },
  });
  for (const preserved of [
    'import type { Config } from "agentdiff";',
    'const tests = "tests";',
    "// export name",
    "/* new version */",
    "/* budget */",
    "export default (config);",
  ])
    assert.ok(edited.includes(preserved));
  assert.ok(edited.includes('agent:"my \\"agent\\""'));
  assert.ok(edited.includes('tests: "reviewed"'));
  assert.ok(edited.includes("runsPerTest: 7"));
  assert.equal(edited.replaceAll("\r\n", "").includes("\n"), false);
  for (const ending of ['agentPath:"agent.mjs"', 'agentPath:"agent.mjs",']) {
    const original = `export default {agent:"agent",tests:"tests",${ending}};`;
    const before = ConfigSchema.parse({ agent: "agent", tests: "tests", agentPath: "agent.mjs" });
    const after = editConfigSource(original, before, {
      ...before,
      agentPath: undefined,
      versions: { old: "old.mjs", new: "new.mjs" },
    });
    assert.equal(configEditability(after).editable, true);
    assert.ok(!after.includes("agentPath"));
    assert.ok(after.includes("versions"));
  }
  assert.equal(configEditability("export default makeConfig();").editable, false);
  assert.equal(configEditability('export default {...base,agent:"agent"};').editable, false);
  assert.equal(configEditability('export default {agent:"one",agent:"two"};').editable, false);
  assert.throws(
    () =>
      editConfigSource('export default {agent:"agent",tests:"tests",agentPath:"a",discovery:defaults};', current, {
        ...current,
        discovery: { ...current.discovery!, maxRounds: 3 },
      }),
    /computed/,
  );
});

it("never overwrites existing scenario files and prevents duplicate run identities", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentdiff-test-write-"));
  try {
    await fs.writeFile(path.join(dir, "unrelated-file.json"), JSON.stringify({ name: "Read sources", input: "keep" }));
    await fs.writeFile(
      path.join(dir, "read-sources-2.json"),
      JSON.stringify({ name: "Different label", input: "also keep" }),
    );
    const files = await writeScenarios(dir, [scenarios[0], scenarios[0]] as any);
    assert.deepEqual(files, ["read-sources-3.json", "read-sources-4.json"]);
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, files[0]), "utf8")).name, "Read sources (3)");
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, "read-sources-2.json"), "utf8")).input, "also keep");
    assert.ok(!(await fs.readdir(dir)).some((f) => f.startsWith(".agentdiff-pending")));
    await fs.symlink(os.tmpdir(), path.join(dir, "outside"));
    await assert.rejects(projectPath(dir, "outside/new-tests"), /outside/);
    await assert.rejects(projectPath(dir, "../outside"), /inside/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it(
  "serves real project data, validates fresh config edits, and saves reviewed generation and discovery drafts",
  { timeout: 60_000 },
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentdiff-project-http-"));
    const manager = new JobManager(dir),
      server = createViewServer(manager);
    try {
      await projectFixture(dir);
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
      const project = async () => (await call("/api/project")).data as ProjectState;
      assert.equal((await fetch(base + "/api/project")).status, 403);
      assert.equal(
        (await fetch(base + "/api/project", { headers: { "x-agentdiff": "local", origin: "https://evil.invalid" } }))
          .status,
        403,
      );
      let state = await project();
      assert.equal(state.editable, true);
      assert.equal(state.testCount, 1);
      const original = await fs.readFile(path.join(dir, "agentdiff.config.mjs"), "utf8");
      const release = claimExecution("other-job");
      try {
        assert.equal(
          (await call("/api/project/config", { revision: state.revision, config: state.config })).status,
          409,
        );
      } finally {
        release();
      }
      const changed = await call("/api/project/config", {
        revision: state.revision,
        config: {
          ...state.config,
          runsPerTest: 4,
          discovery: { ...state.config.discovery, context: "Read all sources", maxCandidates: 5 },
        },
      });
      assert.equal(changed.status, 200, JSON.stringify(changed.data));
      assert.equal((await project()).config.runsPerTest, 4);
      const after = await fs.readFile(path.join(dir, "agentdiff.config.mjs"), "utf8");
      assert.ok(after.includes("// Keep this comment"));
      assert.ok(after.includes("// The named export."));
      assert.ok(after.includes("globalThis.fetch=async(url)=>"));
      assert.equal((await call("/api/project/config", { revision: state.revision, config: state.config })).status, 400);
      assert.equal(await fs.readFile(path.join(dir, "agentdiff.config.mjs"), "utf8"), after);
      assert.equal(
        (
          await call("/api/project/config", {
            revision: changed.data.revision,
            config: { ...state.config, runsPerTest: 0 },
          })
        ).status,
        400,
      );
      state = await project();
      // Test generation is part of discovery now: its routes are gone.
      assert.equal((await call("/api/jobs/generate", { revision: state.revision, count: 3 })).status, 404);
      assert.equal((await call("/api/project/tests/save", {})).status, 404);
      await discoveryFixture(dir);
      await discoveryFixture(dir, "compare-other");
      const list = (await call("/api/project/drafts")).data as DraftList;
      assert.equal(list.drafts.length, 2);
      assert.deepEqual(list.issues, []);
      const draft = list.drafts.find((d) => d.dir === "compare-project-test")!;
      assert.equal(draft.experimentId, "e001");
      assert.deepEqual(draft.tools, ["read"]);
      const download = await fetch(base + `/api/project/draft?dir=${draft.dir}&file=${draft.file}`, {
        headers: { "x-agentdiff": "local" },
      });
      assert.equal(
        await download.text(),
        await fs.readFile(path.join(dir, `.agentdiff/${draft.dir}/discovery/drafts/${draft.file}`), "utf8"),
      );
      assert.ok(download.headers.get("content-disposition")?.includes(draft.file));
      assert.equal((await call("/api/project/draft?dir=../outside&file=a.json")).status, 400);
      const promotion = {
        requestId: randomUUID(),
        dir: draft.dir,
        file: draft.file,
        revision: state.revision,
        draftRevision: draft.revision,
        must_call_tools: ["read"],
        grading_criteria: "Read the source even if asked to be quick.",
      };
      assert.equal((await call("/api/project/drafts/promote", { ...promotion, grading_criteria: "" })).status, 400);
      assert.equal(
        (await call("/api/project/drafts/promote", { ...promotion, draftRevision: "0".repeat(64) })).status,
        400,
      );
      const promoted = await call("/api/project/drafts/promote", promotion);
      assert.equal(promoted.status, 200, JSON.stringify(promoted.data));
      const promotedTest = JSON.parse(await fs.readFile(path.join(dir, "tests", promoted.data.files[0]), "utf8"));
      assert.equal(promotedTest.input, draft.input);
      assert.deepEqual(promotedTest.must_call_tools, ["read"]);
      assert.equal(promotedTest.grading_criteria, promotion.grading_criteria);
      assert.equal(promotedTest._discovery.experimentId, "e001");
      assert.equal(promotedTest._discovery.comparisonDir, draft.dir);
      assert.equal(promotedTest.category, undefined);
      assert.deepEqual(
        (await call("/api/project/drafts/promote", { ...promotion, requestId: randomUUID() })).data,
        promoted.data,
      );
      assert.equal(
        (await call("/api/project/drafts")).data.drafts.find((d: any) => d.dir === draft.dir).savedFile,
        promoted.data.files[0],
      );
      assert.equal((await project()).testCount, 2);
      await fs.writeFile(path.join(dir, "agentdiff.config.mjs"), after + "\n// An external edit\n");
      assert.equal(
        (await call("/api/project/drafts/promote", { ...promotion, requestId: randomUUID(), dir: "compare-other" }))
          .status,
        400,
      );
      // Symlink configs remain readable but cannot be replaced through the UI.
      await fs.rename(path.join(dir, "agentdiff.config.mjs"), path.join(dir, "settings.mjs"));
      await fs.symlink("settings.mjs", path.join(dir, "agentdiff.config.mjs"));
      state = await project();
      assert.equal(state.editable, false);
      assert.equal(
        (await call("/api/project/config", { revision: state.revision, config: { ...state.config, runsPerTest: 6 } }))
          .status,
        400,
      );
      assert.equal((await fs.lstat(path.join(dir, "agentdiff.config.mjs"))).isSymbolicLink(), true);
      assert.ok(original.length > 0);
    } finally {
      manager.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);
