import path from "node:path";
import { pathToFileURL } from "node:url";
import { answeredCalls, replayAgent, type ToolSession } from "../agent/replay.ts";
import { runOnce } from "../agent/execute.ts";
import type { RunRecord, TestFile, ToolCall } from "../types.ts";
import type { DiscoveryConfig, FixtureFactory, ProbeCase, ProbeRunner } from "./types.ts";
import type { AnyAgent } from "../agent/load.ts";

class FixtureSession implements ToolSession {
  readonly controller = new AbortController();
  readonly calls: ToolCall[] = [];
  failure: string | null = null;
  constructor(private fixtures: ReturnType<FixtureFactory>) {}

  fail(message: string): never {
    this.failure ??= message;
    this.controller.abort();
    throw new Error(this.failure);
  }

  async execute(tool: string, input: unknown): Promise<unknown> {
    if (this.controller.signal.aborted) throw new Error(this.failure ?? "Test stopped.");
    const call: ToolCall = { tool, input: structuredClone(input), output: null };
    this.calls.push(call);
    const handler = Object.hasOwn(this.fixtures, tool) ? this.fixtures[tool] : undefined;
    if (typeof handler !== "function")
      this.fail(`No discovery fixture for tool ${tool}. Add it to the fixture factory.`);
    try {
      const output = await handler(structuredClone(input));
      if (output === undefined)
        this.fail(`Fixture for ${tool} returned undefined. Supply a response for these arguments.`);
      call.output = structuredClone(output);
      return structuredClone(output);
    } catch (error) {
      return this.fail(`Fixture ${tool}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export async function loadFixtures(rootDir: string, file?: string): Promise<FixtureFactory> {
  if (!file) return () => ({});
  const mod = await import(pathToFileURL(path.resolve(rootDir, file)).href);
  const factory = mod.createFixtures ?? mod.default;
  if (typeof factory !== "function")
    throw new Error("Discovery fixtures must export a createFixtures() factory returning tool handlers.");
  return factory;
}

/** What a tool answers when no test says: a plain success. */
const UNSCRIPTED = { ok: true };

/**
 * Fixtures from the tests' own tool answers, for a project without a fixtures
 * module. A case built on a test answers each tool as that test does (in call
 * order, then its last answer again); any other tool answers what the tests
 * answer it with most often, or a plain success when no test answers it.
 */
export function fixturesFromTests(tests: TestFile[], tools: string[]): FixtureFactory {
  const usual = Object.fromEntries(
    tools.map((tool) => {
      const counts = new Map<string, number>();
      for (const output of tests.flatMap((t) => t.tool_responses?.[tool] ?? [])) {
        const key = JSON.stringify(output);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const top = [...counts].sort((a, b) => b[1] - a[1])[0];
      return [tool, top ? JSON.parse(top[0]) : UNSCRIPTED];
    }),
  );
  return (_context, probe) => {
    const scripted = tests.find((t) => t.name === probe?.baseTest)?.tool_responses ?? {};
    return Object.fromEntries(
      tools.map((tool) => {
        const outputs = scripted[tool] ?? [];
        let call = 0;
        return [
          tool,
          () => structuredClone(outputs.length ? outputs[Math.min(call++, outputs.length - 1)] : usual[tool]),
        ];
      }),
    );
  };
}

function freshFixtures(factory: FixtureFactory, probe?: ProbeCase): ReturnType<FixtureFactory> {
  const fixtures = factory(probe?.context ? structuredClone(probe.context) : undefined, probe);
  if (
    !fixtures ||
    typeof fixtures !== "object" ||
    Array.isArray(fixtures) ||
    Object.values(fixtures).some((value) => typeof value !== "function")
  ) {
    throw new Error(
      "createFixtures() must synchronously return an object of tool-name → function entries. Create fresh state inside the factory.",
    );
  }
  return fixtures;
}

/** Run one attempt with a time limit; a run past it is an error, never a finished run. */
async function attempt(
  run: () => Promise<RunRecord>,
  failed: (message: string) => RunRecord,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<RunRecord> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<RunRecord>((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
      resolve(failed(`Discovery attempt exceeded ${timeoutMs}ms.`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Each attempt gets a fresh copy of the agent with every tool answered by a
 * fresh set of fixtures, built from that case's context. The agent's own tool
 * executors never run.
 */
export async function createProbeRunner(
  agents: { old: AnyAgent; new: AnyAgent },
  factory: FixtureFactory,
  config: DiscoveryConfig,
): Promise<ProbeRunner> {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13))
    throw new Error("Behavioral discovery needs Node 22.13+ for the isolated Mastra adapter.");
  for (const agent of [agents.old, agents.new]) {
    const fixtures = freshFixtures(factory);
    const session = new FixtureSession(fixtures);
    await replayAgent(agent, session, config);
    const tools = await agent.listTools();
    for (const name of Object.keys(tools ?? {})) {
      if (!Object.hasOwn(fixtures, name)) {
        throw new Error(
          `Discovery needs a test fixture for ${name}. Set discovery.fixtures to a module exporting createFixtures().`,
        );
      }
    }
  }

  return async (probe, version, run, testName) => {
    const started = Date.now();
    const session = new FixtureSession(freshFixtures(factory, probe));
    const failed = (message: string): RunRecord => ({
      test: testName,
      version,
      run,
      input: probe.input,
      tool_calls: session.calls,
      final_response: null,
      steps: null,
      tokens: null,
      latency_ms: Date.now() - started,
      error: message,
    });
    try {
      const executable = await replayAgent(agents[version], session, config);
      const record = await attempt(
        () => runOnce(executable, { name: testName, ...probe }, version, run),
        (message) => {
          session.failure ??= message;
          return failed(session.failure);
        },
        config.timeoutMs,
        () => session.controller.abort(),
      );
      return structuredClone({
        ...record,
        tool_calls: answeredCalls(record.tool_calls, session.calls),
        error: session.failure ?? record.error,
      });
    } catch (error) {
      return structuredClone(failed(error instanceof Error ? error.message : String(error)));
    } finally {
      session.controller.abort();
    }
  };
}

/**
 * discovery.tools: "own". Each agent runs as it does in the suite, with its
 * own tools and the case's context, so a change inside a tool (a scheduler
 * that stopped enforcing quiet hours) shows up. Only for simulated tools.
 */
export function createOwnToolsRunner(agents: { old: AnyAgent; new: AnyAgent }, config: DiscoveryConfig): ProbeRunner {
  return async (probe, version, run, testName) => {
    const started = Date.now();
    const failed = (message: string): RunRecord => ({
      test: testName,
      version,
      run,
      input: probe.input,
      tool_calls: [],
      final_response: null,
      steps: null,
      tokens: null,
      latency_ms: Date.now() - started,
      error: message,
    });
    return structuredClone(
      await attempt(
        () => runOnce(agents[version], { name: testName, ...probe }, version, run),
        failed,
        config.timeoutMs,
        () => {},
      ),
    );
  };
}
