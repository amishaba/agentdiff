/** Stable JSON comparison; object insertion order is not a behavioral change. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Like `canonical`, but refuses `undefined` instead of treating it as null.
 * Used where the result identifies recorded evidence (replay matching, review
 * revisions), so a missing value can never silently match a recorded null.
 */
export function strictCanonical(value: unknown): string {
  if (value === undefined) throw new Error("Missing JSON value.");
  if (Array.isArray(value)) return `[${value.map(strictCanonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${strictCanonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
