import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { it } from "node:test";
import { createViewServer } from "../src/dashboard/server.ts";
import { ComparisonShape, GradesShape, RunListSchema, TracesShape } from "../src/dashboard/runs-contract.ts";
import { RequestError, requestJson } from "../web/src/data/request.ts";

const FIXTURES = new URL("../web/fixtures/", import.meta.url);

/** Run `body` as the local dashboard page, with `fetch` answering from `respond`. */
async function asLocalPage(respond: (url: string) => Promise<Response> | Response, body: () => Promise<void>) {
  const previousWindow = globalThis.window,
    previousFetch = globalThis.fetch;
  const fakeWindow = { location: { search: "?view=dashboard" }, __AGENTDIFF__: { mode: "live" } };
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: fakeWindow });
  globalThis.fetch = async (url) => respond(String(url));
  try {
    await body();
  } finally {
    globalThis.fetch = previousFetch;
    Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: previousWindow });
  }
}

async function failure(promise: Promise<unknown>): Promise<RequestError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof RequestError, `expected a RequestError, got ${error}`);
    return error;
  }
  assert.fail("expected the request to fail");
}

it("every failed request says what happened and what to do, never a JSON parse error", async () => {
  await asLocalPage(
    (url) => {
      if (url === "/api/down") throw new TypeError("fetch failed");
      if (url === "/api/proxy") return new Response("", { status: 502 });
      if (url === "/api/crash") return new Response("boom", { status: 500, headers: { "content-type": "text/plain" } });
      if (url === "/api/refused")
        return Response.json({ error: "No saved comparison by that name here." }, { status: 404 });
      if (url === "/api/html") return new Response("<!doctype html>", { status: 200 });
      return Response.json({ agentName: "a" });
    },
    async () => {
      const down = await failure(requestJson("/api/down"));
      assert.equal(down.failure, "unreachable");
      assert.match(down.message, /agentdiff view/);

      // `vite web` with no `agentdiff view` behind it: an empty 502 from the proxy.
      const proxy = await failure(requestJson("/api/proxy"));
      assert.equal(proxy.failure, "unreachable");
      assert.equal(proxy.status, 502);

      const crash = await failure(requestJson("/api/crash"));
      assert.equal(crash.failure, "rejected");
      assert.equal(crash.message, "/api/crash failed (500).");

      const refused = await failure(requestJson("/api/refused"));
      assert.equal(refused.message, "No saved comparison by that name here.");
      assert.equal(refused.status, 404);

      assert.equal((await failure(requestJson("/api/html"))).failure, "unreadable");

      const shape = await failure(requestJson("/api/comparison?dir=compare-x", { shape: ComparisonShape }));
      assert.equal(shape.failure, "unreadable");
      assert.match(shape.message, /^\/api\/comparison sent data this page can't show \(oldFile: /);
    },
  );
});

it("an aborted request stays an abort, not an unreachable server", async () => {
  const controller = new AbortController();
  controller.abort();
  await asLocalPage(
    () => {
      throw new DOMException("aborted", "AbortError");
    },
    async () => {
      await assert.rejects(requestJson("/api/runs", { signal: controller.signal }), { name: "AbortError" });
    },
  );
});

it("a valid response comes back whole, with fields the shape doesn't name", async () => {
  await asLocalPage(
    () => Response.json([{ dir: "compare-a", label: "a", extra: true }]),
    async () => {
      assert.deepEqual(await requestJson("/api/runs", { shape: RunListSchema }), [
        { dir: "compare-a", label: "a", extra: true },
      ]);
    },
  );
});

it("every baked recording passes the shapes the dashboard checks", () => {
  const datasets: [string, { comparison: unknown; traces: unknown; grades: unknown }][] = readdirSync(
    new URL("examples/", FIXTURES),
  )
    .filter((f) => f.endsWith(".json") && f !== "index.json")
    .map((f) => [f, JSON.parse(readFileSync(new URL(`examples/${f}`, FIXTURES), "utf8"))]);
  const workspace = JSON.parse(readFileSync(new URL("dashboard.json", FIXTURES), "utf8"));
  datasets.push(...Object.entries<{ comparison: unknown; traces: unknown; grades: unknown }>(workspace.datasets));
  assert.ok(datasets.length >= 5);
  for (const [name, d] of datasets) {
    for (const [part, shape, value] of [
      ["comparison", ComparisonShape, d.comparison],
      ["traces", TracesShape, d.traces],
      ["grades", GradesShape, d.grades],
    ] as const) {
      const checked = shape.safeParse(value);
      assert.ok(checked.success, `${name} ${part}: ${checked.error?.issues[0]?.message}`);
    }
  }
  assert.ok(RunListSchema.safeParse(workspace.runs).success);
});

it("the server answers unknown API routes and comparisons with a JSON error", async () => {
  const server = createViewServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const missing = await fetch(`${base}/api/not-a-route`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "No API route /api/not-a-route." });
    const unknown = await fetch(`${base}/api/comparison?dir=compare-does-not-exist`);
    assert.equal(unknown.status, 404);
    assert.match((await unknown.json()).error, /No saved comparison/);
    // Pages outside /api keep their plain-text 404.
    assert.equal(await (await fetch(`${base}/nothing-here`)).text(), "not found");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
