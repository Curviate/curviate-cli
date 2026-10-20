/**
 * Whole-number flag values. `parseInt` reads "5abc" as 5, "1e2" as 1 and "abc"
 * as NaN, which JSON sends as `null` or a query sends as `limit=NaN`: a typo
 * silently became a different request. Digits only, in range, or exit 2
 * naming the flag, before any request. The value is never echoed.
 */
export function intFlag(flag: string, raw: string, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (n >= min && n <= max) return n;
  const range = max === Number.MAX_SAFE_INTEGER ? `${min} or more` : `from ${min} to ${max}`;
  process.stderr.write(`error: --${flag} must be a whole number, ${range}.\n`);
  process.exit(2);
}

/** A comma-separated list of whole numbers (`1,2,3`), every segment checked by `intFlag`. */
export function intListFlag(flag: string, raw: string, min = 1, max = Number.MAX_SAFE_INTEGER): number[] {
  // Every segment counts: "" and "1,,2" are refused, never shortened.
  const n = raw.split(",").map((s) => s.trim()).map((s) => (/^\d+$/.test(s) ? Number(s) : NaN));
  if (n.length > 0 && n.every((x) => x >= min && x <= max)) return n;
  process.stderr.write(`error: --${flag} takes comma-separated whole numbers, each from ${min} to ${max}.\n`);
  process.exit(2);
}
