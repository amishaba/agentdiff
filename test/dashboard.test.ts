import assert from "node:assert/strict";
import { it } from "node:test";
import { dashboardTab } from "../web/src/data/dashboard.ts";

it("saved tab links fall back safely", () => {
  assert.equal(
    dashboardTab("?view=dashboard&dir=compare-a&tab=discovery"),
    "overview",
    "old tab links open Comparisons",
  );
  assert.equal(dashboardTab("?tab=braintrust"), "braintrust");
  assert.equal(dashboardTab("?tab=project"), "project");
  assert.equal(dashboardTab("?tab=missing"), "overview");
});
