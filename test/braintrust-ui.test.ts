import assert from "node:assert/strict";
import { it } from "node:test";
import { incidentsFromSpans, prepareScenario, reviewRevision } from "../src/dashboard/braintrust/scenario.ts";
import { incidentAge, incidentBadge, incidentScore } from "../web/src/data/braintrust.ts";

const root = {
  id: "root",
  span_id: "root",
  root_span_id: "root",
  input: "Read this source",
  scores: { quality: 0.2 },
  metrics: { start: 1, end: 3 },
};
const incident = incidentsFromSpans("project", [root])[0];
const scenario = { ...prepareScenario(incident, [root]), reviewed: true, mustCallTools: ["read"] };

it("exposes recorded scores including zero and keeps error-only incidents free of invented scores", () => {
  const zero = incidentsFromSpans("project", [
    { ...root, scores: { quality: null } },
    { ...root, id: "child", span_id: "child", scores: { safety: 0, quality: 0.4 } },
  ])[0];
  assert.deepEqual(zero.scores, [
    { name: "safety", value: 0, spanId: "child" },
    { name: "quality", value: 0.4, spanId: "child" },
  ]);
  assert.equal(incidentScore(zero).label, "0");
  assert.match(incidentScore(zero).detail, /safety: 0 \(span child\)/);
  const error = incidentsFromSpans("project", [{ ...root, scores: { quality: null }, error: "Failed" }])[0];
  assert.equal(incidentScore(error).label, "error");
  assert.deepEqual(error.scores, []);
  assert.equal(incidentScore({ ...error, scores: undefined, errorCount: undefined }).label, "-");
  assert.equal(incidentAge("not a timestamp"), "Time unavailable");
});

it("badges say whether a reviewed incident is in the tests, and whether that test matches the latest review", () => {
  const revision = reviewRevision(scenario);
  const reviewed = { ...incident, reviewed: true, reviewRevision: revision };
  assert.equal(incidentBadge({ ...incident, reviewed: false }), null);
  assert.equal(incidentBadge(reviewed)?.label, "Reviewed");
  assert.equal(
    incidentBadge({ ...reviewed, savedFile: "incident-abc.json", savedRevision: revision })?.label,
    "In your tests",
  );
  const changed = reviewRevision({ ...scenario, expectation: "Also cite the document." });
  assert.notEqual(revision, changed);
  assert.equal(
    incidentBadge({ ...reviewed, reviewRevision: changed, savedFile: "incident-abc.json", savedRevision: revision })
      ?.label,
    "Test out of date",
  );
});
