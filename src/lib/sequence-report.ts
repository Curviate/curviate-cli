/**
 * Sequence findings in the compiler format:
 *
 *   <file>:<line>:<col> error R12 <path>: <message>. <hint> -> <docs_url>
 *
 * `warning` for a warning. Line and column come from the entry's JSON Pointer,
 * resolved in the text as read (a Motion file's Sequence sits under
 * `/sequence`); stdin is named `-`. The verdict itself is the SDK's
 * `validateSequence`: this module only places and prints it.
 * The arrow is ASCII `->`: CLI copy carries no arrow glyph.
 */
import type { CurviateErrorDetail } from "@curviate/sdk";

/** Where each value starts in `text` (already valid JSON), keyed by JSON Pointer. */
export function valueOffsets(text: string): Map<string, number> {
  const at = new Map<string, number>();
  let i = 0;
  const ws = () => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  const str = (): string => {
    const start = i++;
    while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (ptr: string): void => {
    ws();
    at.set(ptr, i);
    const c = text[i];
    if (c === "{" || c === "[") {
      const close = c === "{" ? "}" : "]";
      i++;
      ws();
      if (text[i] === close) return void i++;
      for (let n = 0; ; n++) {
        ws();
        let key = String(n);
        if (c === "{") {
          key = str().replace(/~/g, "~0").replace(/\//g, "~1");
          ws();
          i++; // the colon
        }
        value(`${ptr}/${key}`);
        ws();
        if (text[i++] === close) return;
      }
    }
    if (c === '"') return void str();
    while (i < text.length && !/[\s,\]}]/.test(text[i]!)) i++;
  };
  value("");
  return at;
}

/** 1-based line and column of `pointer` in `text`, or of its nearest parent that exists there. */
export function lineCol(text: string, offsets: Map<string, number>, pointer: string): [number, number] {
  let p = pointer;
  while (!offsets.has(p) && p !== "") p = p.slice(0, p.lastIndexOf("/"));
  const off = offsets.get(p) ?? 0;
  const before = text.slice(0, off);
  return [before.split("\n").length, off - before.lastIndexOf("\n")];
}

type Entry = CurviateErrorDetail;

/** One compiler-format line per entry. `prefix` is the Sequence's pointer in the file (`/sequence` in a Motion file). */
export function compilerLines(file: string, text: string, entries: { errors: Entry[]; warnings: Entry[] }, prefix = ""): string[] {
  let offsets: Map<string, number> | undefined;
  const line = (kind: string, e: Entry) => {
    offsets ??= valueOffsets(text);
    const [l, c] = lineCol(text, offsets, prefix + (e.pointer ?? ""));
    const message = (e.message ?? e.rule).replace(/\.$/, "");
    return `${file}:${l}:${c} ${kind} ${e.code ?? ""} ${e.path}: ${message}.${e.hint ? ` ${e.hint}` : ""}${e.docs_url ? ` -> ${e.docs_url}` : ""}`;
  };
  return [...entries.errors.map((e) => line("error", e)), ...entries.warnings.map((w) => line("warning", w))];
}
