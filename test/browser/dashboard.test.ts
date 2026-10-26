// The dashboard in a real Chrome, against the Vite dev server: the tests
// table's sort, filter, search and keys, links that reopen a view, and what the
// page says when the server is down or sends something it can't show. Every
// /api call is answered here, so no `agentdiff view` (and no key) is needed.
//
//   npm run test:browser   (needs Google Chrome installed)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";

const WEB = fileURLToPath(new URL("../../web/", import.meta.url));
const workspace = JSON.parse(readFileSync(new URL("../../web/fixtures/dashboard.json", import.meta.url), "utf8"));
const [dir, dataset] = Object.entries<Record<string, unknown> & { comparison: Comparison }>(workspace.datasets)[0];

type Comparison = { tests: Record<string, unknown>[] } & Record<string, unknown>;

let server: ViteDevServer;
let browser: Browser;
let base: string;

before(async () => {
  // The page's own errors are asserted on here, so the dev server needn't print them too.
  server = await createServer({
    root: WEB,
    configFile: `${WEB}vite.config.ts`,
    logLevel: "error",
    server: { forwardConsole: false },
  });
  await server.listen();
  base = server.resolvedUrls!.local[0];
  browser = await chromium.launch({ channel: "chrome" });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

interface Opened {
  page: Page;
  context: BrowserContext;
  /** Console errors and uncaught exceptions, as they happen. */
  errors: string[];
}

/** A fresh page; `live` makes it the local dashboard, and `api` answers its /api calls. */
async function open(path: string, { live = false, api }: { live?: boolean; api?: (route: Route) => unknown } = {}) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  if (live) await page.addInitScript({ content: "window.__AGENTDIFF__ = { mode: 'live' }" });
  if (api) await page.route("**/api/**", api);
  await page.goto(base + path);
  return { page, context, errors } satisfies Opened;
}

/** Reads until `ok` holds (or the time is up), and returns the last read for the assertion. */
async function settled<T>(read: () => Promise<T> | T, ok: (value: T) => boolean, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  let value = await read();
  while (!ok(value) && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await read();
  }
  return value;
}

const rowNames = (page: Page) => page.locator(".tests-table tbody .row-link b").allTextContents();
const param = (page: Page, name: string) => new URL(page.url()).searchParams.get(name);
const text = async (page: Page) => (await page.locator(".app-content").textContent()) ?? "";

async function tab(page: Page, name: string) {
  await page.locator(".app-nav a", { hasText: name }).click();
  await page.locator('.app-nav a[aria-current="page"]', { hasText: name }).waitFor();
}

/** The sample workspace's comparison as `agentdiff view` would serve it, with `comparison` swapped in. */
function api(comparison: unknown = dataset.comparison) {
  return (route: Route) => {
    const { pathname } = new URL(route.request().url());
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/api/runs") return json(workspace.runs);
    if (pathname === "/api/comparison") return json(comparison);
    if (pathname === "/api/grades") return json(dataset.grades);
    if (pathname === "/api/traces") return json(dataset.traces);
    if (pathname === "/api/explanation") return json({ text: "" });
    if (pathname === "/api/jobs/status") return json({ job: null, busy: false });
    return json({ error: `No API route ${pathname}.` }, 404);
  };
}

describe("a recorded example's tests table", () => {
  let opened: Opened;
  let page: Page;
  let initial: string[];

  before(async () => {
    opened = await open("?view=report&example=support");
    page = opened.page;
    await page.locator(".tests-table tbody tr").first().waitFor();
    initial = await rowNames(page);
  });
  after(() => opened.context.close());

  it("lists the example's tests", () => {
    assert.ok(initial.length > 2, `${initial.length} rows`);
  });

  it("sorts by a header A→Z, then Z→A, then back, with the sort in the link", async () => {
    const header = page.locator(".tests-table th button", { hasText: "Test" });
    await header.click();
    const ascending = [...initial].sort((a, b) => a.localeCompare(b));
    assert.deepEqual(await rowNames(page), ascending);
    assert.equal(param(page, "sort"), "test");
    assert.equal(await page.locator(".tests-table th[aria-sort]").getAttribute("aria-sort"), "ascending");
    await header.click();
    assert.deepEqual(await rowNames(page), [...ascending].reverse());
    assert.equal(param(page, "sort"), "-test");
    await header.click();
    assert.deepEqual(await rowNames(page), initial);
    assert.equal(param(page, "sort"), null);
  });

  it("filters by kind of change, with the filter in the link", async () => {
    await page.locator(".segmented button", { hasText: "Breaks a test rule" }).click();
    const filtered = await rowNames(page);
    assert.equal(param(page, "filter"), "rule");
    assert.ok(filtered.length < initial.length, `${filtered.length} of ${initial.length} rows`);
    await page.locator(".segmented button", { hasText: "All" }).click();
    assert.equal(param(page, "filter"), null);
  });

  it('jumps to search on "/", with the search in the link', async () => {
    await page.mouse.click(5, 880);
    await page.keyboard.press("/");
    assert.equal(await page.locator(":focus").getAttribute("aria-label"), "Search tests");
    const query = initial[1].slice(0, 6);
    await page.keyboard.type(query);
    assert.equal(param(page, "q"), query);
    assert.ok((await rowNames(page)).includes(initial[1]));
    await page.locator('input[aria-label="Search tests"]').fill("");
    assert.equal(param(page, "q"), null);
  });

  it("moves between rows with ↓ and k, and opens one with Enter", async () => {
    const focusedRow = () => page.locator("tr:has(.row-link:focus) b").textContent();
    await page.locator(".tests-table tbody tr").first().locator(".row-link").focus();
    await page.keyboard.press("ArrowDown");
    assert.equal(await focusedRow(), initial[1]);
    await page.keyboard.press("k");
    assert.equal(await focusedRow(), initial[0]);
    await page.keyboard.press("Enter");
    await page.locator(".side-panel").waitFor();
    assert.equal(param(page, "test"), initial[0]);
    await page.keyboard.press("ArrowDown");
    assert.equal(
      await settled(
        () => param(page, "test"),
        (t) => t === initial[1],
      ),
      initial[1],
    );
  });

  it("reopens the same test and sort from a copied link", async () => {
    const copy = await opened.context.newPage();
    await copy.goto(`${page.url()}&sort=latency`);
    await copy.locator(".side-panel").waitFor();
    assert.equal(await copy.locator(".tests-table th[aria-sort]").getAttribute("aria-sort"), "ascending");
    await copy.close();
  });

  it("closes the test on Esc, and drops it from the link", async () => {
    await page.keyboard.press("Escape");
    await page.locator(".side-panel").waitFor({ state: "detached" });
    assert.equal(param(page, "test"), null);
  });

  it("logs no errors", () => {
    assert.deepEqual(opened.errors, []);
  });
});

describe("the sample workspace", () => {
  it("opens every tab without an error", async () => {
    const { page, context, errors } = await open("?view=dashboard");
    try {
      await page.locator(".tests-table tbody tr").first().waitFor();
      for (const name of ["Scenarios", "Check", "Incidents", "Project", "Comparisons"]) await tab(page, name);
      assert.equal(await page.getByText("couldn’t be shown").count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
});

describe("the local dashboard", () => {
  it("says to start agentdiff view when the server is down, instead of a parse error", async () => {
    // `vite web` with nothing behind it: the proxy answers an empty 502.
    const { page, context } = await open("?view=dashboard", {
      live: true,
      api: (route) => route.fulfill({ status: 502 }),
    });
    try {
      // Two retries with backoff before it gives up.
      await page.getByText("Could not list saved comparisons").waitFor({ timeout: 15_000 });
      assert.ok(await page.getByRole("button", { name: "Try again" }).count());
      await tab(page, "Incidents");
      const shown = await settled(
        () => text(page),
        (t) => t.includes("Can't reach the agentdiff server"),
      );
      assert.match(shown, /Can't reach the agentdiff server/);
      assert.doesNotMatch(shown, /Unexpected (end|token)/);
      assert.match(shown, /Job status unknown/);
      assert.doesNotMatch(shown, /Another local operation is running/);
    } finally {
      await context.close();
    }
  });

  it("names the field it can't read in a comparison, instead of a blank page", async () => {
    const { oldFile: _, ...broken } = dataset.comparison;
    const { page, context } = await open(`?view=dashboard&dir=${dir}`, { live: true, api: api(broken) });
    try {
      await page.locator('[role="alert"]').first().waitFor();
      const shown = await text(page);
      assert.match(shown, /Could not load this comparison/);
      assert.match(shown, /oldFile/);
    } finally {
      await context.close();
    }
  });

  it("keeps a render crash inside its section", async () => {
    const crashing = {
      ...dataset.comparison,
      tests: dataset.comparison.tests.map((t, i) => (i === 0 ? { ...t, input: 42 } : t)),
    };
    const { page, context } = await open(`?view=dashboard&dir=${dir}&q=zzzz`, { live: true, api: api(crashing) });
    try {
      await page.locator('[role="alert"]').first().waitFor();
      assert.match(await text(page), /This comparison couldn’t be shown/);
      await tab(page, "Project");
      assert.equal(await page.getByText("Project settings couldn’t be shown").count(), 0);
    } finally {
      await context.close();
    }
  });

  it("loads the newest comparison, keeps it when you come back, and polls the job", async () => {
    let comparisons = 0;
    let polls = 0;
    const { page, context, errors } = await open("?view=dashboard", {
      live: true,
      api: (route) => {
        const { pathname } = new URL(route.request().url());
        if (pathname === "/api/comparison") comparisons++;
        if (pathname === "/api/jobs/status") polls++;
        return api()(route);
      },
    });
    try {
      await page.locator(".tests-table tbody tr").first().waitFor();
      await tab(page, "Check");
      await tab(page, "Comparisons");
      await page.locator(".tests-table tbody tr").first().waitFor();
      assert.equal(comparisons, 1);
      const before = polls;
      assert.ok(
        (await settled(
          () => polls,
          (n) => n >= before + 2,
        )) >=
          before + 2,
        "polls every 1.5s",
      );
      assert.deepEqual(
        errors.filter((e) => !e.includes("404")),
        [],
      );
    } finally {
      await context.close();
    }
  });
});
