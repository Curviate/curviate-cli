/**
 * Compact human tables for the product groups (`network`, `unibox`,
 * `analytics`, `account overview|metrics`). Human output only: `--json`
 * (or a pipe) always carries the API body instead.
 */

const cell = (v: unknown): string => (v === null || v === undefined || v === "" ? "-" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** A header row, then one row per item, columns padded to the widest cell. */
export function table(head: string[], rows: unknown[][]): string {
  const cells = rows.map((r) => head.map((_, i) => cell(r[i])));
  const w = head.map((h, i) => Math.max(h.length, ...cells.map((r) => r[i]!.length)));
  return [head, ...cells].map((r) => r.map((c, i) => c.padEnd(w[i]!)).join("  ").trimEnd()).join("\n");
}

/** A rate object `{<num>, <den>, rate}` as `9/16 56%`; `-` when there is no rate. */
export function rate(o: unknown, num: string, den: string): string {
  const r = o as Record<string, unknown> | null | undefined;
  if (!r || typeof r !== "object") return "-";
  const pct = typeof r["rate"] === "number" ? ` ${Math.round((r["rate"] as number) * 100)}%` : "";
  return `${cell(r[num])}/${cell(r[den])}${pct}`;
}

/** Print `text` plus a newline to stdout. */
export const print = (text: string): void => void process.stdout.write(text + "\n");
