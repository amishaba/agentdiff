// The rules in an agent's prompt: sentences that say what it must, must not,
// or must first do. Mutation testing removes them one at a time; scenario
// planning makes sure each one gets a test.

/** Words that make a sentence a rule: something the agent must, must not, or must first do. */
const RULE =
  /\b(never|only|always|must|don't|do not|doesn't|isn't|can't|cannot|before|after|unless|until|first|exact|exactly|at most|no more than|without)\b/i;

/** `CHANGES: ` at the start of a prompt line: a topic label, not part of any rule. */
const LABEL = /^[A-Z][A-Z &/-]+:\s+/;

/** The rule sentences of one prompt line, without its topic label. */
export function ruleSentences(line: string): string[] {
  const text = line.trim().replace(LABEL, "");
  if (!text || text.startsWith("#")) return [];
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z"'`])/)
    .map((s) => s.trim())
    .filter((s) => RULE.test(s));
}

/** Every rule sentence in a prompt, in order, each once. */
export function promptRules(instructions: string): string[] {
  return [...new Set(instructions.split("\n").flatMap(ruleSentences))];
}
