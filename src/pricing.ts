/**
 * Rough USD price per 1M tokens, matched by substring against the model id.
 * Used only to estimate relative cost differences between versions — not billing.
 * Longest/most-specific patterns first.
 */
const PRICE_TABLE: { match: string; input: number; output: number }[] = [
  { match: "opus", input: 15, output: 75 },
  { match: "haiku", input: 0.8, output: 4 },
  { match: "sonnet", input: 3, output: 15 },
];

const DEFAULT_PRICE = { input: 3, output: 15 };

function priceFor(model: string): { input: number; output: number } {
  const id = model.toLowerCase();
  for (const row of PRICE_TABLE) {
    if (id.includes(row.match)) return { input: row.input, output: row.output };
  }
  return DEFAULT_PRICE;
}

/** Estimate USD cost for a single run's token usage. Null if tokens unknown. */
export function costOf(
  model: string,
  tokens: { input: number | null; output: number | null } | null,
): number | null {
  if (!tokens) return null;
  const price = priceFor(model);
  const inTok = tokens.input ?? 0;
  const outTok = tokens.output ?? 0;
  if (tokens.input == null && tokens.output == null) return null;
  return (inTok / 1_000_000) * price.input + (outTok / 1_000_000) * price.output;
}
