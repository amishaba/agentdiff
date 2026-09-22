import { canonical } from "../lib/canonical.ts";
import { limiter } from "../lib/async.ts";
import type { RunRecord } from "../types.ts";
import { behaviorDifference, experimentStatus, findingKey, reproducedCases } from "./behavior.ts";
import { checkProbe, validateProbe } from "./planner.ts";
import type {
  CaseResult,
  DiscoveryConfig,
  DiscoveryResult,
  Experiment,
  Planner,
  PlannerContext,
  Probe,
  ProbeCase,
  ProbeRunner,
} from "./types.ts";

interface Dependencies {
  planner: Planner;
  run: ProbeRunner;
  /** Agent runs at once; 1 runs them one after another. */
  concurrency?: number;
  checkpoint?: (result: DiscoveryResult) => Promise<void>;
  onProgress?: (message: string) => void;
}

export function emptyDiscovery(config: DiscoveryConfig, changes: PlannerContext["changes"]): DiscoveryResult {
  return {
    status: "complete",
    config,
    changes,
    agentRuns: 0,
    plannerCalls: 0,
    experiments: [],
    findings: [],
    notices: [],
  };
}

/** The finished result when the snapshots differ in nothing discovery can investigate. */
export function nothingToInvestigate(config: DiscoveryConfig): DiscoveryResult {
  return {
    ...emptyDiscovery(config, []),
    reason: "No supported instruction, model, setting, or tool-definition changes to investigate.",
  };
}

/** One side of a probe, with what the agent should do there. */
/** " (its name)" for a proposed experiment that has one, for notices. */
const nameOf = (candidate: unknown) => {
  const name = (candidate as { name?: unknown } | null)?.name;
  return typeof name === "string" && name.trim() ? ` ("${name.trim()}")` : "";
};

function caseOf(probe: Probe, side: "control" | "variant"): CaseResult {
  const context = side === "control" ? probe.controlContext : probe.variantContext;
  const expected = side === "control" ? probe.controlExpected : probe.variantExpected;
  return {
    input: probe[side],
    ...(probe.conversation?.length ? { conversation: probe.conversation } : {}),
    ...(context ? { context } : {}),
    ...(expected ? { expected } : {}),
    old: [],
    new: [],
    difference: null,
  };
}

/** What the agent is sent for a case. */
function sent(c: Pick<CaseResult, "input" | "conversation" | "context">): ProbeCase {
  return {
    input: c.input,
    ...(c.conversation?.length ? { conversation: c.conversation } : {}),
    ...(c.context ? { context: c.context } : {}),
  };
}

/** Exploration and confirmation use separate trials. Findings describe repeated observations, not proof of causality. */
export async function discover(
  context: PlannerContext,
  config: DiscoveryConfig,
  deps: Dependencies,
): Promise<DiscoveryResult> {
  if (!context.changes.length) {
    const result = nothingToInvestigate(config);
    await deps.checkpoint?.(result);
    return result;
  }
  const result = emptyDiscovery(config, context.changes);
  // Runs finish out of order; their checkpoints still write one at a time.
  let saving: Promise<void> = Promise.resolve();
  const checkpoint = () =>
    (saving = saving
      .catch(() => {})
      .then(async () => {
        await deps.checkpoint?.(result);
      }));
  const slot = limiter(deps.concurrency ?? 1);
  result.status = "running";
  const screenCost = 8; // two inputs × two versions × two screening attempts
  const confirmCost = 4 * config.confirmationRuns;
  const findingLimit = Math.min(
    config.maxFindings,
    config.maxCandidates,
    Math.floor(config.maxAgentRuns / (screenCost + confirmCost)),
  );
  const screenBudget = config.maxAgentRuns - findingLimit * confirmCost;
  const seenInputs = new Set(
    context.existingTests.map((t) =>
      canonical(sent({ input: t.input.trim(), conversation: t.conversation, context: t.context })),
    ),
  );
  const seenPairs = new Set<string>();
  let candidates = 0;
  let limited = false;
  // Runs committed to started experiments; result.agentRuns counts those that finished.
  let committed = 0;

  async function experiment(
    probe: Probe,
    phase: Experiment["phase"],
    attempts: number,
    parentId?: string,
  ): Promise<Experiment> {
    const cost = attempts * 4;
    if (committed + cost > config.maxAgentRuns)
      throw new Error("Discovery run budget exhausted before starting an experiment.");
    const id = `e${String(result.experiments.length + 1).padStart(3, "0")}`;
    const e: Experiment = {
      id,
      probe,
      phase,
      parentId,
      status: "inconclusive",
      cases: [caseOf(probe, "control"), caseOf(probe, "variant")],
    };
    result.experiments.push(e);
    deps.onProgress?.(`${phase}: ${probe.name}`);
    // Every attempt of both cases on both versions runs at once (up to the limit), started
    // in alternating order so one version doesn't always get the earlier provider calls.
    const jobs = e.cases.flatMap((c, i) =>
      Array.from({ length: attempts }, (_, a) => a + 1).flatMap((attempt) =>
        (attempt % 2 ? (["old", "new"] as const) : (["new", "old"] as const)).map((version) => ({
          c,
          i,
          attempt,
          version,
        })),
      ),
    );
    committed += jobs.length;
    await Promise.all(
      jobs.map(({ c, i, attempt, version }) =>
        slot(async (): Promise<void> => {
          const name = `discovery-${id}-${i === 0 ? "control" : "variant"}`;
          let record: RunRecord;
          try {
            record = await deps.run(
              { ...sent(c), ...(probe.baseTest ? { baseTest: probe.baseTest } : {}) },
              version,
              attempt,
              name,
            );
          } catch (error) {
            record = {
              test: name,
              version,
              run: attempt,
              input: c.input,
              tool_calls: [],
              final_response: null,
              steps: null,
              tokens: null,
              latency_ms: null,
              error: error instanceof Error ? error.message : String(error),
            };
          }
          result.agentRuns++;
          c[version].push(record);
          await checkpoint();
        }),
      ),
    );
    // Filed in attempt order, whatever order they finished in.
    for (const c of e.cases) {
      for (const version of ["old", "new"] as const) c[version].sort((a, b) => a.run - b.run);
      c.difference = behaviorDifference(c.old, c.new);
    }
    e.status = experimentStatus(e.cases);
    await checkpoint();
    return e;
  }

  for (let round = 0; round < config.maxRounds && candidates < config.maxCandidates; round++) {
    const available = Math.min(config.maxCandidates - candidates, Math.floor((screenBudget - committed) / screenCost));
    if (available <= 0) {
      limited = true;
      break;
    }
    const count = Math.min(available, Math.ceil((config.maxCandidates - candidates) / (config.maxRounds - round)));
    let probes: unknown[];
    try {
      result.plannerCalls++;
      deps.onProgress?.(`planning experiment round ${round + 1}`);
      probes = await deps.planner.generate(context, result.experiments, count);
    } catch (error) {
      result.notices.push(`Experiment generation stopped: ${error instanceof Error ? error.message : String(error)}`);
      limited = true;
      break;
    }
    const screening: Promise<Experiment>[] = [];
    for (const candidate of probes.slice(0, count)) {
      const probe = checkProbe(candidate, context);
      if (typeof probe === "string") {
        result.notices.push(`Rejected an experiment${nameOf(candidate)}: ${probe}.`);
        continue;
      }
      const [control, variant] = [canonical(sent(caseOf(probe, "control"))), canonical(sent(caseOf(probe, "variant")))];
      const key = canonical([control, variant].sort());
      if (seenPairs.has(key) || (seenInputs.has(variant) && seenInputs.has(control))) continue;
      seenPairs.add(key);
      seenInputs.add(control);
      seenInputs.add(variant);
      candidates++;
      // A round's experiments run side by side; `count` already fits them in the budget.
      screening.push(experiment(probe, "screen", 2));
    }
    await Promise.all(screening);
    await checkpoint();
  }

  const observed = result.experiments.filter((e) => e.phase === "screen" && e.status === "observed");
  const unique = new Map<string, Experiment>();
  for (const e of observed) if (!unique.has(findingKey(e))) unique.set(findingKey(e), e);
  const shortlist = [...unique.values()].slice(0, findingLimit);
  for (let index = 0; index < shortlist.length; index++) {
    const original = shortlist[index];
    let selected = original;
    // Preserve enough budget to confirm every shortlisted experiment even if shortening fails.
    const reserved = (shortlist.length - index) * confirmCost;
    if (committed + screenCost + reserved <= config.maxAgentRuns) {
      try {
        result.plannerCalls++;
        deps.onProgress?.(`trying a shorter reproducer: ${original.probe.name}`);
        const shortened = validateProbe(await deps.planner.shorten(context, original), context);
        if (
          shortened &&
          shortened.changeId === original.probe.changeId &&
          shortened.strategy === original.probe.strategy &&
          shortened.control.length + shortened.variant.length <
            original.probe.control.length + original.probe.variant.length
        ) {
          // Only the messages get shorter; the conversation, contexts and expectations stay the original's.
          const probe = { ...original.probe, control: shortened.control, variant: shortened.variant };
          const smaller = await experiment(probe, "shrink", 2, original.id);
          const changed = original.cases.flatMap((c, i) => (c.difference ? [i] : []));
          const reproduced = reproducedCases(original, smaller);
          if (changed.every((i) => reproduced.includes(i))) selected = smaller;
        }
      } catch (error) {
        result.notices.push(`Kept original reproducer: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const confirmed = await experiment(selected.probe, "confirm", config.confirmationRuns, selected.id);
    const reproduced = reproducedCases(selected, confirmed);
    if (reproduced.length) {
      result.findings.push({
        id: `f${String(result.findings.length + 1).padStart(3, "0")}`,
        experimentId: confirmed.id,
        originalExperimentId: original.id,
        probe: selected.probe,
        cases: confirmed.cases,
        reproducedCases: reproduced,
        shortened: selected !== original,
      });
    } else {
      result.notices.push(`${original.id}: the screening difference did not reproduce in fresh confirmation trials.`);
    }
    await checkpoint();
  }
  if (observed.length > shortlist.length)
    result.notices.push(
      `${observed.length - shortlist.length} additional screening experiments were grouped with similar behavior or left unconfirmed by the finding limit.`,
    );
  result.status = limited ? "limited" : "complete";
  if (!result.experiments.length && result.notices.length) result.status = "error";
  if (result.experiments.length && result.experiments.every((e) => e.status === "blocked")) {
    result.status = "blocked";
    result.reason =
      "All generated experiments were blocked by execution or fixture errors; inspect their recorded errors.";
  }
  await checkpoint();
  return result;
}
