import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { currentMode, loadDataset } from "../../web/src/data/load.ts";
import { queryClient } from "../../web/src/data/queries.ts";
import { changeKind } from "../../src/compare/change-kind.ts";
import { RunToolbar } from "../../web/src/components/RunToolbar.tsx";
import { RunProvenance } from "../../web/src/components/RunProvenance.tsx";
import { TraceBody } from "../../web/src/components/TraceBody.tsx";
import { ComparisonFailure } from "../../web/src/components/ComparisonFailure.tsx";

const render = (component, props) => renderToStaticMarkup(createElement(component, props));
globalThis.window = { location: { search: "" }, __AGENTDIFF__: { mode: "live" } };
assert.equal(currentMode(), "demo");
window.location.search = "?dir=compare-saved";
assert.equal(currentMode(), "live", "original saved-run links must open the dashboard");
window.location.search = "?view=dashboard";
assert.equal(currentMode(), "live");
delete window.__AGENTDIFF__;
assert.equal(currentMode(), "demo", "hosted demo must never load local APIs");
window.location.search = "?view=report&example=support";
const data = await loadDataset();
assert.equal(data.comparison.agentName, "support-agent", "the examples page loads the example named in the URL");
const tests = data.comparison.tests;
const noop = () => {};
// A run record for the discovery trace check below.
const record = {
  ...data.traces.old[0],
  test: "research",
  run: 1,
  error: null,
  tool_calls: [{ tool: "fetch_sources", input: {}, output: {} }],
};
for (const version of ["old", "new"]) {
  for (const r of data.traces[version]) {
    const trace = render(TraceBody, { data, test: tests.find((t) => t.test === r.test), run: { ...r, version } });
    for (const text of ["tool calls", "final response", "tokens in / out", "latency", "est. cost"])
      assert.ok(trace.includes(text), `missing trace feature: ${text}`);
  }
}
const picker = render(RunToolbar, {
  runs: [
    { dir: "compare-one", label: "first" },
    { dir: "compare-two", label: "second" },
  ],
  dir: "compare-two",
  onPick: noop,
});
assert.ok(picker.includes("<select"));
assert.ok(picker.includes('value="compare-two" selected=""'));
const provenance = render(RunProvenance, { data });
assert.ok(provenance.includes("Recorded on real models") && provenance.includes("bake-example.ts"));
// Exercise the new routes rather than requiring a particular component layout.
register("./ignore-css.mjs", import.meta.url);
const { default: App } = await import("../../web/src/App.tsx");
globalThis.document = { hidden: false };
globalThis.location = window.location;
window.matchMedia = () => ({ matches: true });
window.location.search = "";
const home = render(App);
assert.ok(home.includes('class="overview"'));
// The repo is private and the package unpublished: no link to either until they are public.
assert.ok(!home.includes('github.com/amishaba/agentdiff"') && !home.includes("npmjs.com"), "no dead external links");
assert.ok(home.includes("made by amisha"));
for (const name of ["sms", "booking", "support"])
  assert.ok(home.includes(`href="/?view=report&amp;example=${name}"`), `the homepage links the ${name} example`);
assert.ok(
  home.includes("before they say YES, in all 10 runs") && home.includes('title="11 of 16 tests behave differently"'),
  "the examples table leads with a recorded finding, with the counts next to it",
);
assert.ok(
  home.includes("ov-finding") && home.includes("Can you move me to the 5:20pm flight tomorrow?"),
  "the homepage walks through a real finding from the SMS recording",
);
assert.ok(!/\d+m \d+s/.test(home), "the homepage shows no stage times");
assert.ok(!home.includes("RoyCo") && !home.includes("Scripted example"), "no scripted examples");
/** The main navigation's markup and the text of its active link. */
const mainNavOf = (html) => {
  const nav = html.match(/<nav class="app-nav" aria-label="Main navigation">(.*?)<\/nav>/)[1];
  const active = nav.match(/<a [^>]*aria-current="page"[^>]*>(.*?)<\/a>/)?.[1].replace(/<[^>]+>/g, "");
  return { nav, active };
};
window.location.search = "?view=report&example=booking";
const examples = render(App);
assert.ok(examples.includes('class="app"'), "a recorded example opens in the app shell");
assert.equal(mainNavOf(examples).active, "Four-agent booking team9/9", "the open example is the active sidebar item");
assert.ok(examples.includes("The change: "));
window.location.search = "?view=challenge";
const retiredChallenge = render(App);
assert.ok(retiredChallenge.includes('class="overview"'), "retired challenge links must open the homepage");
assert.ok(!retiredChallenge.includes("Your message to the agent"));

// Every route has one main navigation, the app sidebar, with the current page marked.
for (const local of [false, true]) {
  window.__AGENTDIFF__ = local ? { mode: "live" } : undefined;
  const shared = {};
  for (const [search, expected] of [
    ["", "Overview"],
    ["?view=report", "SMS travel desk11/16"],
    ["?view=report&example=booking", "Four-agent booking team9/9"],
    ["?view=challenge", "Overview"],
    ["?view=report&dir=compare-saved", "SMS travel desk11/16"],
    ["?view=challenge&dir=compare-saved", "Overview"],
    ["?view=dashboard", "Comparisons"],
    ["?dir=compare-saved", local ? "Comparisons" : "Overview"],
  ]) {
    window.location.search = search;
    const html = render(App);
    assert.ok(
      !html.includes("Try the agent") && !html.includes('href="/?view=challenge"'),
      "retired challenge must not be offered",
    );
    assert.equal(
      (html.match(/aria-label="Main navigation"/g) ?? []).length,
      1,
      `${search}: exactly one main navigation`,
    );
    const { nav, active } = mainNavOf(html);
    assert.equal((nav.match(/aria-current="page"/g) ?? []).length, 1, `${search}: one active page`);
    assert.equal(active, expected, `${search}: incorrect active page`);
    assert.ok(nav.includes(local ? "Local workspace" : "Recorded run"), `${search}: workspace is labelled`);
    for (const section of ["Overview", "Comparisons", "Incidents", "Project"])
      assert.ok(nav.includes(`<span>${section}</span>`), `${search}: ${section} is in the sidebar`);
    if (expected === "Overview")
      assert.ok(
        html.includes(local ? "Open your runs" : "Explore the demo"),
        "the homepage leads to the dashboard, local or hosted",
      );
    const links = nav.replace(' aria-current="page"', "");
    shared.links ??= links;
    assert.equal(links, shared.links, `${search}: primary links must not change between pages`);
    assert.equal(currentMode(), local && expected === "Comparisons" ? "live" : "demo");
  }
}

// A discovery run shows the same trace as a suite run.
const probe = {
  name: "file lookup order",
  hypothesis: "The edited instruction changes tool order.",
  strategy: "wording",
  changeId: "instructions",
  control: "Read the file",
  variant: "Read it now",
  targetTools: ["search", "read"],
};
const pattern = {
  calls: [
    { tool: "search", input: { query: "file" } },
    { tool: "read", input: { path: "a.txt" } },
  ],
  count: 3,
  total: 3,
};
const difference = {
  kind: "sequence",
  old: pattern,
  new: { ...pattern, calls: [...pattern.calls].reverse() },
  key: "order",
};
const cases = [probe.control, probe.variant].map((input, i) => ({
  input,
  difference,
  old: [
    {
      ...record,
      test: `discovery-e001-${i}`,
      input,
      version: "old",
      tool_calls: pattern.calls.map((c) => ({ ...c, output: "saved output" })),
    },
  ],
  new: [
    {
      ...record,
      test: `discovery-e001-${i}`,
      input,
      version: "new",
      tool_calls: difference.new.calls.map((c) => ({ ...c, output: "saved output" })),
    },
  ],
}));
const discoveryTrace = render(TraceBody, { data, run: cases[1].new[0] });
assert.ok(discoveryTrace.includes("Read it now"));
assert.ok(discoveryTrace.includes("saved output"));
assert.ok(discoveryTrace.includes("values may be clipped"));
assert.ok(!discoveryTrace.includes("required but never called"));

const failedComparison = render(ComparisonFailure, {
  sides: [{ side: "new", runs: 5, error: "Provider unavailable" }],
});
assert.ok(failedComparison.includes("Comparison could not complete"));
assert.ok(failedComparison.includes("not a “0 changes” result"));
assert.ok(failedComparison.includes("Provider unavailable"));
// The comparisons page: how many tests moved, every test in one flat table with what changed, and what you changed.
const { Review } = await import("../../web/src/review/Review.tsx");
const { TestPanel } = await import("../../web/src/review/TestsTable.tsx");
const { shiftGroups, tableRows } = await import("../../web/src/review/groups.ts");
const review = render(Review, { data });
assert.match(review, /<h1>\d+ of \d+ tests? behaves? differently<\/h1>/);
const groups = shiftGroups(data.comparison, data.traces);
for (const g of groups)
  for (const r of g.rows) {
    assert.ok(review.includes(`<b>${r.test.test}</b>`), `a row for "${r.test.test}"`);
    assert.ok(review.includes(r.shift.title), `"${r.test.test}" says what changed`);
  }
assert.ok(!review.includes("<details"), "no rows fold open inside the table");
assert.ok(review.includes("What changed in the agent"));
assert.ok(!/Worse|Better|Broke a rule/.test(review), "labels describe the change, they don't judge it");
// A test opens in a side panel with its path, replies, the edits that mention it, and every run.
const panel = render(TestPanel, {
  data,
  row: tableRows(data.comparison, data.traces)[0],
  position: "1 of 7",
  onClose: noop,
});
for (const text of [
  "Tool path",
  "Final reply",
  "Edits that mention it",
  "Every run",
  "Usual path",
  'aria-label="Open old agent run',
])
  assert.ok(panel.includes(text), `the test panel shows ${text}`);
assert.ok(review.includes("Every test in numbers"));
// A copied link opens the table as it was left: its sort (marked on the column), search and filter.
const rowNames = (html) => [...html.matchAll(/class="row-link"[^>]*><b>([^<]+)<\/b>/g)].map((m) => m[1]);
window.location.search = "?view=report&example=support&sort=test";
const byName = render(Review, { data });
assert.deepEqual(
  rowNames(byName),
  [...rowNames(review)].sort((a, b) => a.localeCompare(b)),
);
assert.ok(byName.includes('aria-sort="ascending"'));
window.location.search = "?view=report&example=support&sort=-test";
assert.deepEqual(rowNames(render(Review, { data })), rowNames(byName).reverse());
const first = rowNames(review)[0];
window.location.search = `?view=report&example=support&q=${encodeURIComponent(first)}`;
assert.ok(rowNames(render(Review, { data })).every((name) => name.includes(first)));
window.location.search = "?view=report&example=support&filter=rule";
const rules = render(Review, { data });
assert.ok(rules.includes('aria-pressed="true"><i class="kind-dot" data-kind="rule"'));
assert.equal(rowNames(rules).length, tests.filter((t) => changeKind(t, data.comparison.writeTools) === "rule").length);
window.location.search = "?view=report&example=support";

// Job progress reflects saved evidence, never a timer or a discovery-budget percentage.
const { JobCard } = await import("../../web/src/components/JobCard.tsx");
const jobBase = {
  id: "job",
  kind: "compare",
  status: "running",
  createdAt: "2026-09-24T12:00:00Z",
  progress: { phase: "preparing", message: "Loading agents" },
};
const jobControls = (job) => ({ job, busy: job.status === "running", checking: false, error: "", cancel: noop });
const jobHtml = (job) => render(JobCard, { jobs: jobControls(job), onOpen: noop, onBaseline: noop });
assert.ok(!jobHtml(jobBase).includes('role="progressbar"'));
const measured = jobHtml({ ...jobBase, progress: { phase: "runs", message: "Saved run", completed: 3, total: 8 } });
assert.ok(measured.includes("3 / 8 runs saved"));
assert.ok(measured.includes('aria-valuenow="3"'));
assert.ok(measured.includes("width:37.5%"));
const discoveryJob = jobHtml({
  ...jobBase,
  kind: "discover",
  progress: { phase: "discovery", message: "Confirming", completed: 12, limit: 120 },
});
assert.ok(discoveryJob.includes("12 discovery runs saved"));
assert.ok(!discoveryJob.includes('role="progressbar"'));
const completed = jobHtml({ ...jobBase, status: "complete", resultDir: "compare-saved", message: "Comparison saved." });
assert.ok(completed.includes("Open result"));
assert.ok(!completed.includes(">Cancel<"));

// The stubbed window makes the query cache think it's in a browser, where it keeps
// unused queries for a few minutes on a timer; clear it so the process can exit.
queryClient.clear();
