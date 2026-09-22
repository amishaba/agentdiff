import path from "node:path";
import { hasApiKey } from "../lib/llm.ts";
import { writeJson, writeText } from "../storage/fs.ts";
import type { Snapshot, TestFile } from "../types.ts";
import { discover, emptyDiscovery, nothingToInvestigate } from "./engine.ts";
import { createPlanner, describeChanges } from "./planner.ts";
import { createOwnToolsRunner, createProbeRunner, fixturesFromTests, loadFixtures } from "./runner.ts";
import { discoveryReport } from "./report.ts";
import type { DiscoveryConfig, DiscoveryResult, PlannerContext } from "./types.ts";
import type { AnyAgent } from "../agent/load.ts";

export async function runDiscovery(args: {
  agents: { old: AnyAgent; new: AnyAgent };
  oldSnapshot: Snapshot;
  newSnapshot: Snapshot;
  tests: TestFile[];
  config: DiscoveryConfig;
  /** Agent runs at once. */
  concurrency?: number;
  rootDir: string;
  dir: string;
  onProgress?: (message: string) => void;
  onCheckpoint?: (result: DiscoveryResult) => void;
}): Promise<DiscoveryResult> {
  const { config } = args;
  const context: PlannerContext = {
    oldSnapshot: args.oldSnapshot,
    newSnapshot: args.newSnapshot,
    changes: describeChanges(args.oldSnapshot, args.newSnapshot),
    existingTests: args.tests,
    testContext: config.context,
  };
  const dest = path.join(args.dir, "discovery");
  const savedRuns = new Set<string>();
  let latest: DiscoveryResult | undefined;
  const checkpoint = async (result: DiscoveryResult) => {
    latest = result;
    for (const e of result.experiments) {
      for (let i = 0; i < e.cases.length; i++)
        for (const version of ["old", "new"] as const) {
          for (const run of e.cases[i][version]) {
            const key = `${e.id}-${i}-${version}-${run.run}`;
            if (savedRuns.has(key)) continue;
            await writeJson(path.join(dest, "runs", `${key}.json`), run);
            savedRuns.add(key);
          }
        }
      await writeJson(path.join(dest, "experiments", `${e.id}.json`), e);
    }
    await writeJson(path.join(dest, "discovery.json"), result);
    args.onCheckpoint?.(result);
  };
  if (!context.changes.length) {
    const result = nothingToInvestigate(config);
    await checkpoint(result);
    await writeText(path.join(dest, "report.md"), discoveryReport(result));
    return result;
  }
  let result = emptyDiscovery(config, context.changes);
  try {
    let run;
    if (config.tools === "own") run = createOwnToolsRunner(args.agents, config);
    else {
      if (!context.oldSnapshot.tools.length && !context.newSnapshot.tools.length)
        throw new Error(
          'Fixture discovery stands in for the agents\' tools, and neither agent has any. Set discovery.tools to "own" if its tools are simulated.',
        );
      // Without a fixtures module, the tools answer the way the tests already answer them.
      const fixtures = config.fixtures
        ? await loadFixtures(args.rootDir, config.fixtures)
        : fixturesFromTests(args.tests, [...new Set([...context.oldSnapshot.tools, ...context.newSnapshot.tools])]);
      run = await createProbeRunner(args.agents, fixtures, config);
    }
    if (!hasApiKey()) throw new Error("Discovery needs OPENAI_API_KEY to plan experiments.");
    result = await discover(context, config, {
      planner: createPlanner(config.timeoutMs),
      run,
      concurrency: args.concurrency,
      checkpoint,
      onProgress: args.onProgress,
    });
  } catch (error) {
    result = latest ?? result;
    result.status = result.agentRuns ? "error" : "blocked";
    result.reason = error instanceof Error ? error.message : String(error);
    await checkpoint(result);
  }
  for (const f of result.findings) {
    for (const [index, label] of ["control", "variant"].entries()) {
      const c = f.cases[index];
      await writeJson(path.join(dest, "drafts", `${f.id}-${label}.json`), {
        name: `discovery ${f.id} ${f.probe.name} ${label}`,
        input: c.input,
        ...(c.conversation?.length ? { conversation: c.conversation } : {}),
        ...(c.context ? { context: c.context } : {}),
        ...(c.expected ? { grading_criteria: c.expected } : {}),
        _discovery: {
          findingId: f.id,
          hypothesis: f.probe.hypothesis,
          evidence: `../experiments/${f.experimentId}.json`,
          review:
            "The planner wrote grading_criteria; check it says what the agent should do before adding this test, along with any must_call_tools or must_not_call_tools. These inputs reproduce a change; they don't decide which behavior is right.",
        },
      });
    }
  }
  await writeText(path.join(dest, "report.md"), discoveryReport(result));
  return result;
}
