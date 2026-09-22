// Plain-text formatting shared by the terminal summary, the markdown report,
// the explainer prompt, and the web dashboard. Browser-safe.
import { stepLabel } from "./steps.ts";

export function fmtMoney(n: number | null): string {
  if (n == null) return "n/a";
  return `$${n.toFixed(n < 0.01 ? 4 : 2)}`;
}

export function fmtNum(n: number | null, digits = 1): string {
  if (n == null) return "n/a";
  return n.toFixed(digits);
}

/** "+112%" style change between two averages. Null-safe. */
export function pctChange(oldV: number | null, newV: number | null): string | null {
  if (oldV == null || newV == null) return null;
  if (oldV === 0) return newV === 0 ? "+0%" : "new value";
  const pct = ((newV - oldV) / Math.abs(oldV)) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(0)}%`;
}

/** `lookup_customer → refund_customer`, or `(no tools)` for a direct answer. */
export function fmtSequence(seq: string[]): string {
  return seq.length ? seq.map(stepLabel).join(" → ") : "(no tools)";
}
