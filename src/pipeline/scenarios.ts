import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/load.ts";
import { importAgent } from "../agent/load.ts";
import { extractSnapshot } from "../agent/snapshot.ts";
import { loadTests } from "../suite/load.ts";
import { limiter } from "../lib/async.ts";
import { errMessage, fail } from "../lib/errors.ts";
import { accountError, hasApiKey, modelConcurrency, offline } from "../lib/llm.ts";
import { exists, rm, writeJson, writeText } from "../storage/fs.ts";
import { slug } from "../storage/workspace.ts";
import { agentBrief, openaiAsk, type AskModel } from "../scenarios/model.ts";
import { numberPlan, planCoverage, ruleItems, type PlanItem } from "../scenarios/plan.ts";
import { promptRules } from "../agent/rules.ts";
import { scenariosForItem } from "../scenarios/scenario.ts";
import { coverageReport } from "../scenarios/report.ts";
import type { ScenarioDraft, ScenarioResult } from "../scenarios/types.ts";
import type { TestFile } from "../types.ts";
import { silentReporter, type Reporter } from "./reporter.ts";

/** One coverage item's scenarios, or why the writer failed on it. */
type Written = ({ item: PlanItem } & Awaited<ReturnType<typeof scenariosForItem>>) | { item: PlanItem; error: string };

export interface ScenarioOptions {
  config?: string;
  /** Scenarios to write for each thing to cover. */
  perItem?: number;
  /** Most things to cover the planner may list; every rule in the prompt is added on top. */
  maxItems?: number;
  /** Topics to leave out of the plan and the scenarios, in plain words. */
  avoid?: string;
  reporter?: Reporter;
  /** The model; tests pass a fake. */
  ask?: AskModel;
}

/**
 * Draft test scenarios for the agent from its prompt and tools alone: plan
 * what a suite has to cover, write scenarios for each item, and save them as
 * test files under .agentdiff/scenarios-<time>/tests/ for review. Nothing is
 * added to the suite and the agent doesn't run.
 */
export async function draftScenarios(opts: ScenarioOptions = {}): Promise<{ dir: string; result: ScenarioResult }> {
  const reporter = opts.reporter ?? silentReporter;
  const perItem = opts.perItem ?? 2;
  if (!Number.isInteger(perItem) || perItem < 1) fail("--per-item must be a whole number, at least 1.");
  // After the config: loading it can set keys.
  const { config, rootDir, workspace } = await loadConfig(opts.config);
  if (!opts.ask && (offline() || !hasApiKey()))
    fail("Writing scenarios needs OPENAI_API_KEY in .env: a model reads the prompt and writes them.");
  const ask = opts.ask ?? openaiAsk();
  const agentFile = config.agentPath ?? config.versions!.new;
  const agent = await importAgent(rootDir, agentFile, config.agent, { maxTurns: config.maxTurns });
  const snapshot = await extractSnapshot(agent);
  const brief = agentBrief(snapshot, config.writeTools);
  const existing = await existingTests(rootDir, config.tests);

  reporter.log(`agentdiff scenarios — ${snapshot.name || config.agent}`, "heading");
  // The prompt's rule sentences are known now: write their scenarios while the model plans the rest.
  const rules = promptRules(brief.instructions);
  const fromRules = ruleItems(rules);
  const limit = limiter(modelConcurrency());
  let done = 0;
  let total = fromRules.length;
  // Set when the account can't make any call (no credits, a bad key): the items not started yet are skipped.
  let halted: string | null = null;
  // Each item's scenarios are saved as soon as they're written, so a run stopped partway keeps what it paid for.
  const dir = workspace.newScenarioDir();
  const partial = path.join(dir, "partial");
  let saved = 0;
  const write = (item: PlanItem) =>
    limit(async (): Promise<Written> => {
      let result: Written;
      if (halted) result = { item, error: `not started: ${halted}` };
      else
        try {
          result = {
            item,
            ...(await scenariosForItem(ask, brief, item, { count: perItem, existing, avoid: opts.avoid })),
          };
        } catch (err) {
          halted ??= accountError(err);
          result = { item, error: errMessage(err).split("\n")[0] };
        }
      if (!("error" in result))
        await writeJson(
          path.join(partial, `${String(++saved).padStart(3, "0")}-${slug(item.title).slice(0, 60)}.json`),
          {
            item: { area: item.area, title: item.title },
            tests: result.tests,
            dropped: result.dropped,
          },
        );
      reporter.runSaved(item.title, ++done, total, "error" in result, "written");
      reporter.progress({ phase: "writing", message: `Wrote: ${item.title}`, completed: done, total });
      return result;
    });
  reporter.log(`Writing scenarios for the prompt's ${fromRules.length} rules while planning what else to cover…`);
  reporter.progress({ phase: "writing", message: "Planning what else to cover", completed: 0, total });
  const ruleWork = fromRules.map(write);
  let planned: PlanItem[] = [];
  let planError: string | undefined;
  try {
    planned = await planCoverage(ask, brief, rules, { max: opts.maxItems, avoid: opts.avoid });
  } catch (err) {
    halted ??= accountError(err);
    planError = errMessage(err).split("\n")[0];
    reporter.log(`Planning failed (${planError}); covering the prompt's rules only.`, "warning");
  }
  total += planned.length;
  const { plan, idOf } = numberPlan([...fromRules, ...planned]);
  reporter.log(`${plan.length} things to cover; writing ${perItem} scenarios for each`);
  const written = (await Promise.all([...ruleWork, ...planned.map(write)])).sort((a, b) =>
    idOf.get(a.item)!.localeCompare(idOf.get(b.item)!),
  );

  const files = new Set<string>();
  const names = new Set<string>(existing.map((t) => slug(t.name)));
  const drafts: ScenarioDraft[] = [];
  const result: ScenarioResult = {
    agentName: snapshot.name || config.agent,
    agentFile,
    createdAt: new Date().toISOString(),
    plan,
    drafts,
    dropped: [],
    failed: [],
    ...(planError ? { planError } : {}),
  };
  for (const w of written) {
    if ("error" in w) {
      result.failed.push({ coverageId: idOf.get(w.item)!, reason: w.error });
      continue;
    }
    for (const d of w.dropped) result.dropped.push({ coverageId: idOf.get(w.item)!, ...d });
    for (const drafted of w.tests) {
      // Two scenarios can come back with one name; tests are told apart by name, so the second gets a number.
      const test = { ...drafted, name: uniqueName(drafted.name, names) };
      const file = uniqueFile(slug(test.name), files);
      drafts.push({ file, coverageId: idOf.get(w.item)!, test });
      // The coverage item rides along so a reviewer can see why the scenario exists; loading the test ignores it.
      await writeJson(path.join(dir, "tests", file), {
        _coverage: { id: idOf.get(w.item)!, area: w.item.area, title: w.item.title },
        ...test,
      });
    }
  }
  await writeJson(path.join(dir, "scenarios.json"), result);
  // Everything is in tests/ and scenarios.json now.
  await rm(partial);
  await writeText(path.join(dir, "report.md"), coverageReport(result, config.tests));
  if (halted) fail(`${halted}\nStopped. The ${drafts.length} scenarios written before that are in ${dir}.`);
  return { dir, result };
}

/** The suite's current tests, so the writer doesn't repeat them; none for an agent without tests yet. */
async function existingTests(rootDir: string, testsDir: string): Promise<TestFile[]> {
  const dir = path.resolve(rootDir, testsDir);
  // A suite with a broken test (bad JSON, a duplicate name) fails here, rather than being treated as empty.
  if (!(await exists(dir)) || !(await fs.readdir(dir)).some((f) => f.endsWith(".json"))) return [];
  return loadTests(rootDir, testsDir);
}

/** `name`, or `name (2)`, `name (3)`…: the first not taken, compared as their file names would be. */
function uniqueName(name: string, taken: Set<string>): string {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${name} (${n})`;
    if (!taken.has(slug(candidate))) {
      taken.add(slug(candidate));
      return candidate;
    }
  }
}

function uniqueFile(base: string, taken: Set<string>): string {
  for (let n = 1; ; n++) {
    const file = `${n === 1 ? base : `${base}-${n}`}.json`;
    if (!taken.has(file)) {
      taken.add(file);
      return file;
    }
  }
}
