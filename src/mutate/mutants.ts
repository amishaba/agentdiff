// Seeded regressions: copies of an agent's source, each with one rule sentence
// or one guardrail taken out. Done on the source text, so it works the same for
// every framework agentdiff can run, and a team defined in one file.
import { ruleSentences } from "../agent/rules.ts";
import type { TestFile } from "../types.ts";

export interface Mutant {
  id: string;
  kind: "rule" | "guardrail";
  /** What this copy lost, in a few words: the sentence, or the guardrail and its list. */
  removed: string;
  /** The file's text with that one thing taken out. */
  source: string;
}

const GUARDRAILS = /\b(inputGuardrails|outputGuardrails|inputProcessors|outputProcessors)(\s*:\s*\[)([^\]]*)\]/g;

/** `source` without `sentence`, or null when it isn't there exactly once. */
function withoutSentence(source: string, sentence: string): string | null {
  const at = source.indexOf(sentence);
  if (at < 0 || source.indexOf(sentence, at + 1) >= 0) return null;
  const end = at + sentence.length;
  const quote = source[at - 1];
  // The whole string literal is this sentence: in an array, drop the literal and its comma so the array stays
  // valid; anywhere else (`const prompt = "…"`) leave an empty string, since removing it would break the syntax.
  if (`"'\``.includes(quote) && source[end] === quote) {
    const before = source
      .slice(0, at - 1)
      .trimEnd()
      .at(-1);
    if (before !== "[" && before !== ",") return source.slice(0, at) + source.slice(end);
    const rest = source.slice(end + 1).match(/^\s*,?[ \t]*\n?/)![0];
    const lineStart = source.lastIndexOf("\n", at - 2) + 1;
    const indent = source.slice(lineStart, at - 1);
    const from = /^\s*$/.test(indent) ? lineStart : at - 1;
    return source.slice(0, from) + source.slice(end + 1 + rest.length);
  }
  // Inside a longer string: take the sentence and one space next to it.
  if (source[end] === " ") return source.slice(0, at) + source.slice(end + 1);
  if (source[at - 1] === " ") return source.slice(0, at - 1) + source.slice(end);
  return source.slice(0, at) + source.slice(end);
}

/**
 * Every seeded regression for an agent file: one per rule sentence of its
 * prompt found word for word in the source, and one per guardrail in its
 * guardrail and processor lists.
 */
export function mutants(source: string, instructions: string): Mutant[] {
  const out: Mutant[] = [];
  const seen = new Set<string>();
  const add = (kind: Mutant["kind"], removed: string, mutated: string | null) => {
    if (!mutated || mutated === source || seen.has(mutated)) return;
    seen.add(mutated);
    out.push({ id: `m${String(out.length + 1).padStart(2, "0")}`, kind, removed, source: mutated });
  };
  for (const m of source.matchAll(GUARDRAILS)) {
    const items = m[3]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    items.forEach((item, i) => {
      const rest = items.filter((_, j) => j !== i);
      const list = `${m[1]}${m[2]}${rest.join(", ")}]`;
      add("guardrail", `${item} (${m[1]})`, source.slice(0, m.index) + list + source.slice(m.index! + m[0].length));
    });
  }
  for (const line of instructions.split("\n"))
    for (const sentence of ruleSentences(line)) add("rule", sentence, withoutSentence(source, sentence));
  return out;
}

/** At most `max` of them, spread evenly so a long prompt isn't only tested from the top. */
export function pick<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  return Array.from({ length: max }, (_, i) => items[Math.floor((i * items.length) / max)]);
}

/** Words too common in prompts and tests to say what a sentence is about. */
const COMMON = new Set(
  "the and that this with when what your from have will they them their there then than only never always must before after unless until first into about which would could should just also does doesn cannot without each more most other some such user users agent message messages reply replies".split(
    " ",
  ),
);
const words = (text: string) =>
  new Set((text.toLowerCase().match(/[a-z][a-z_]{3,}/g) ?? []).filter((w) => !COMMON.has(w)));

/**
 * The tests, the ones most likely to notice `removed` missing first: those
 * that require or forbid a tool the sentence names, then those sharing the
 * most words with it. Ties keep the suite's order.
 */
export function byRelevance(tests: TestFile[], removed: string): TestFile[] {
  const said = words(removed);
  const score = (t: TestFile) => {
    const tools = [...(t.must_call_tools ?? []), ...(t.must_not_call_tools ?? [])];
    const text = [
      t.name,
      t.input,
      ...(t.conversation ?? []).map((c) => c.content),
      t.grading_criteria ?? "",
      ...Object.values(t.checks ?? {}),
    ].join(" ");
    const shared = [...words(text)].filter((w) => said.has(w)).length;
    // Tool names are matched as written, so "send-sms", "get_v2_order" and "sms" count too.
    const named = tools.filter((tool) => removed.toLowerCase().includes(tool.toLowerCase())).length;
    return shared + 5 * named;
  };
  return tests
    .map((t, i) => ({ t, i, s: score(t) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.t);
}
