/**
 * USD per 1M tokens at each provider's standard rate, from the OpenAI and
 * Anthropic pricing pages on 2026-10-26. Used to estimate the cost difference
 * between versions, not to bill: a run reports one input and one output total,
 * so cached-input and long-context rates aren't applied.
 */
const PRICES: Record<string, { input: number; output: number }> = {
  "gpt-5.4": { input: 2.5, output: 15 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25 },
  "gpt-5.2": { input: 1.75, output: 14 },
  "gpt-5.1": { input: 1.25, output: 10 },
  "gpt-5": { input: 1.25, output: 10 },
  "gpt-5-mini": { input: 0.25, output: 2 },
  "gpt-5-nano": { input: 0.05, output: 0.4 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-opus-4-1": { input: 15, output: 75 },
  "claude-opus-4": { input: 15, output: 75 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-sonnet-4": { input: 3, output: 15 },
  // Haiku 5.5 costs more past 100K prompt tokens; a run's total can't say which calls were.
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-3-5-haiku": { input: 0.8, output: 4 },
};

/** `openai/gpt-5.4-2026-03-05` → `gpt-5.4`, `claude-sonnet-4-5-20250929` → `claude-sonnet-4-5` */
function priceKey(model: string): string {
  return model
    .toLowerCase()
    .replace(/^[a-z-]+\//, "")
    .replace(/-(\d{4}-\d{2}-\d{2}|\d{8}|latest)$/, "");
}

/**
 * Estimate USD cost for a single run's token usage. Null if tokens are unknown,
 * or the model has no listed price: a guess would read as a real number.
 */
export function costOf(model: string, tokens: { input: number | null; output: number | null } | null): number | null {
  if (!tokens) return null;
  const price = PRICES[priceKey(model)];
  if (!price) return null;
  if (tokens.input == null && tokens.output == null) return null;
  return ((tokens.input ?? 0) / 1_000_000) * price.input + ((tokens.output ?? 0) / 1_000_000) * price.output;
}
