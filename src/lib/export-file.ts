/**
 * The export destination contract (`--output, -o <path|->`): stdout carries
 * data only; a path is written as a temporary file in the same directory with
 * mode 0600, then renamed over the target, so an existing target ends 0600
 * and a failure leaves it untouched with no partial file.
 */
import { chmod, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export async function writeExport(output: string | undefined, data: string | Uint8Array): Promise<void> {
  if (output === undefined || output === "-") {
    await new Promise<void>((resolve, reject) => process.stdout.write(data, (e) => (e ? reject(e) : resolve())));
    return;
  }
  const tmp = join(dirname(output), `.${basename(output)}.${process.pid}.tmp`);
  try {
    await writeFile(tmp, data, { mode: 0o600 });
    await chmod(tmp, 0o600); // the umask cannot widen it, an existing tmp keeps no old mode
    await rename(tmp, output);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/** One CSV cell: RFC 4180 quoting, objects as JSON text, and the formula guard (a leading `= + - @ tab CR '` gets a `'`). */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r']/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export type ExportFormat = "csv" | "json" | "ndjson";

/** `rows` projected to `fields`, in that order, as the bytes of `format`. CSV is UTF-8 with a BOM and CRLF lines. */
export function formatRows(rows: Record<string, unknown>[], fields: string[], format: ExportFormat): string {
  const pick = (r: Record<string, unknown>) => Object.fromEntries(fields.map((f) => [f, r[f] ?? null]));
  if (format === "json") return JSON.stringify(rows.map(pick)) + "\n";
  if (format === "ndjson") return rows.map((r) => JSON.stringify(pick(r)) + "\n").join("");
  return "﻿" + [fields, ...rows.map((r) => fields.map((f) => r[f]))].map((cells) => cells.map(csvCell).join(",") + "\r\n").join("");
}
