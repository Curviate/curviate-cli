/**
 * Document inputs.
 *
 * A command's primary document is `--file <path|->`, a secondary one
 * `--<noun>-file <path|->`. Documents never travel in argv. Each document
 * names exactly one schema, vendored from the published OpenAPI into
 * `src/schemas/documents.json` (keyed by command path; pinned to the fixture
 * by test/document-inputs.test.ts through test/fixtures/document-inputs.json).
 * From that schema only: the DOCUMENT help section, and local validation
 * before any request. Values are never echoed: an issue names a path and a
 * rule.
 */
import { readFileSync, statSync } from "node:fs";
import { editDistance } from "./bare-form-guard.js";
import { defaultReadStdin, isStdinToken } from "./stdin.js";
import SCHEMAS from "../schemas/documents.json";

export type Schema = { [k: string]: unknown };
export type Issue = { path: string; rule: string; suggestion?: string };

/** Keywords the validator enforces. A vendored schema using any other keyword throws. */
export const ENFORCED = new Set(["type", "properties", "required", "additionalProperties", "enum", "const", "minLength", "maxLength", "minimum", "maximum", "items", "minItems", "maxItems", "oneOf"]);
/** Annotations: read, never enforced. `x-` extensions carry limits, not rules. */
export const ANNOTATIONS = new Set(["description", "title", "default", "discriminator"]);

export function documentSchema(key: string): Schema {
  const s = (SCHEMAS as Record<string, Schema>)[key];
  if (!s) throw new Error(`no document schema for ${key}`);
  return s;
}

function usage(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(2);
}

export interface FileFlagIo {
  readStdin?: () => Promise<string>;
  stdinIsTTY?: boolean;
  /** Other parsed flag values: one of them also reading stdin is a second consumer. */
  others?: Record<string, unknown>;
}

/**
 * The bytes behind a file flag (`--file`, `--filters-file`), or exit 2 before
 * any request: inline JSON, a missing path, a directory, empty input, `-`
 * while stdin is a TTY (fail fast, never wait), or a second stdin consumer.
 * The path is named, the content never is.
 */
export async function readFileFlag(flag: string, value: string, io: FileFlagIo = {}): Promise<string> {
  const v = value.trimStart();
  if (v.startsWith("{") || v.startsWith("[")) {
    usage(`--${flag} takes a path or -, not inline JSON. Pass the document on stdin: --${flag} - <<'EOF' ... EOF`);
  }
  let text: string;
  if (isStdinToken(value)) {
    const second = Object.entries(io.others ?? {}).find(([k, o]) => k !== flag && k !== "_" && isStdinToken(o));
    if (second) usage(`--${flag} - and --${second[0]} - both read stdin. Only one input can come from stdin.`);
    if (io.stdinIsTTY ?? process.stdin.isTTY) usage(`--${flag} -: stdin is a terminal. Pipe the document in or use a heredoc: --${flag} - <<'EOF' ... EOF`);
    text = await (io.readStdin ?? defaultReadStdin)();
  } else {
    let isDir = false;
    try {
      isDir = statSync(value).isDirectory();
    } catch {
      usage(`--${flag}: no such file: ${value}`);
    }
    if (isDir) usage(`--${flag}: ${value} is a directory, not a file.`);
    try {
      text = readFileSync(value, "utf8");
    } catch (err) {
      usage(`--${flag}: cannot read ${value}: ${(err as NodeJS.ErrnoException).code ?? "read error"}.`);
    }
  }
  if (text.trim() === "") usage(`--${flag}: empty input.`);
  return text;
}

/** Parse a document, or exit 2 naming the line and column of the fault. */
export function parseDocument(flag: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    const lc = /line (\d+) column (\d+)/.exec(msg);
    const pos = /position (\d+)/.exec(msg);
    let at = "";
    if (lc) at = ` at line ${lc[1]}, column ${lc[2]}`;
    else {
      const before = text.slice(0, pos ? Number(pos[1]) : text.length).split("\n");
      at = ` at line ${before.length}, column ${before[before.length - 1]!.length + 1}`;
    }
    usage(`--${flag}: not valid JSON${at}.`);
  }
}

const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const isType = (v: unknown, t: string) => (t === "integer" ? Number.isInteger(v) : t === "number" ? typeof v === "number" : typeOf(v) === t);
const join = (path: string, key: string | number) => (path ? `${path}.${key}` : String(key));

function assertKnown(schema: Schema): void {
  for (const k of Object.keys(schema)) {
    if (!ENFORCED.has(k) && !ANNOTATIONS.has(k) && !k.startsWith("x-")) throw new Error(`document schema keyword not supported by the validator: ${k}`);
  }
}

/** Every issue in `value` against `schema`, in document order. */
export function validate(schema: Schema, value: unknown, path = ""): Issue[] {
  assertKnown(schema);
  const at = path || "(document)";
  const out: Issue[] = [];
  if (Array.isArray(schema["oneOf"])) {
    const branches = schema["oneOf"] as Schema[];
    const disc = (schema["discriminator"] as { propertyName?: string } | undefined)?.propertyName;
    if (disc && value && typeof value === "object" && disc in value) {
      const tag = (value as Record<string, unknown>)[disc];
      const hit = branches.find((b) => ((b["properties"] as Record<string, Schema>)?.[disc]?.["const"]) === tag);
      if (hit) return validate(hit, value, path);
      const tags = branches.map((b) => (b["properties"] as Record<string, Schema>)?.[disc]?.["const"]).join(", ");
      return [{ path: join(path, disc), rule: `must be one of ${tags}` }];
    }
    const results = branches.map((b) => validate(b, value, path));
    if (results.some((r) => r.length === 0)) return [];
    return [{ path: at, rule: `must match one of: ${branches.map(shape).join(" | ")}` }];
  }
  const t = schema["type"] as string | undefined;
  if (t && !isType(value, t)) return [{ path: at, rule: `must be ${t === "array" || t === "object" || t === "integer" ? "an" : "a"} ${t}` }];
  if ("const" in schema && value !== schema["const"]) out.push({ path: at, rule: `must be ${JSON.stringify(schema["const"])}` });
  if (Array.isArray(schema["enum"]) && !schema["enum"].includes(value)) out.push({ path: at, rule: `must be one of ${schema["enum"].join(", ")}` });
  if (typeof value === "string") {
    if (typeof schema["minLength"] === "number" && value.length < schema["minLength"]) out.push({ path: at, rule: schema["minLength"] === 1 ? "must not be empty" : `must be at least ${schema["minLength"]} characters` });
    if (typeof schema["maxLength"] === "number" && value.length > schema["maxLength"]) out.push({ path: at, rule: `must be at most ${schema["maxLength"]} characters` });
  }
  if (typeof value === "number") {
    if (typeof schema["minimum"] === "number" && value < schema["minimum"]) out.push({ path: at, rule: `must be at least ${schema["minimum"]}` });
    if (typeof schema["maximum"] === "number" && value > schema["maximum"]) out.push({ path: at, rule: `must be at most ${schema["maximum"]}` });
  }
  if (Array.isArray(value)) {
    if (typeof schema["minItems"] === "number" && value.length < schema["minItems"]) out.push({ path: at, rule: `must have at least ${schema["minItems"]} items` });
    if (typeof schema["maxItems"] === "number" && value.length > schema["maxItems"]) out.push({ path: at, rule: `must have at most ${schema["maxItems"]} items` });
    if (schema["items"]) value.forEach((item, i) => out.push(...validate(schema["items"] as Schema, item, join(path, i))));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const props = (schema["properties"] ?? {}) as Record<string, Schema>;
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (key in props) out.push(...validate(props[key]!, obj[key], join(path, key)));
      else if (schema["additionalProperties"] === false) {
        const near = Object.keys(props).filter((p) => editDistance(key, p) <= 2).sort((a, b) => editDistance(key, a) - editDistance(key, b))[0];
        // The key is the caller's field name, not a value: naming it is the point.
        out.push({ path: join(path, key), rule: "unknown field", ...(near ? { suggestion: near } : {}) });
      }
    }
    for (const req of (schema["required"] as string[] | undefined) ?? []) {
      if (!(req in obj)) out.push({ path: join(path, req), rule: "required" });
    }
  }
  return out;
}

function shape(s: Schema): string {
  const req = (s["required"] as string[] | undefined) ?? Object.keys((s["properties"] ?? {}) as object);
  return `{${req.join(", ")}}`;
}

/**
 * Exit 2 with every issue, one `<path>: <rule>` line each; in JSON mode stdout
 * carries the server's error shape (code INVALID_REQUEST). Nothing is sent.
 */
type Streams = { stdout: { write: (s: string) => void }; stderr: { write: (s: string) => void } };

export function reportIssues(issues: Issue[], json: boolean, out: Streams = process): never {
  const line = (i: Issue) => `${i.path}: ${i.rule}${i.suggestion ? ` (did you mean ${i.suggestion}?)` : ""}`;
  const message = `The document has ${issues.length} problem${issues.length === 1 ? "" : "s"}.`;
  if (json) out.stdout.write(JSON.stringify({ error: { code: "INVALID_REQUEST", message, errors: issues } }) + "\n");
  out.stderr.write(`error: ${message}\n${issues.map((i) => `  ${line(i)}\n`).join("")}`);
  process.exit(2);
}

/** Rule text for one field, every limit with its unit, from the schema only. */
function ruleOf(s: Schema): string {
  if (Array.isArray(s["oneOf"])) return `one of ${(s["oneOf"] as Schema[]).map(shape).join(" | ")}`;
  const r: string[] = [];
  if (Array.isArray(s["enum"])) r.push(`one of ${s["enum"].join(", ")}`);
  if ("const" in s) r.push(`exactly ${JSON.stringify(s["const"])}`);
  if (typeof s["minLength"] === "number" && s["minLength"] > 1) r.push(`at least ${s["minLength"]} characters`);
  if (s["minLength"] === 1) r.push("non-empty");
  if (typeof s["maxLength"] === "number") r.push(`at most ${s["maxLength"]} characters`);
  if (typeof s["minimum"] === "number") r.push(`at least ${s["minimum"]}`);
  if (typeof s["maximum"] === "number") r.push(`at most ${s["maximum"]}`);
  if (typeof s["minItems"] === "number") r.push(`at least ${s["minItems"]} items`);
  if (typeof s["maxItems"] === "number") r.push(`at most ${s["maxItems"]} items`);
  return r.join("; ");
}

const typeName = (s: Schema): string =>
  Array.isArray(s["oneOf"]) ? "object" : s["type"] === "array" && s["items"] ? `${typeName(s["items"] as Schema)}[]` : String(s["type"] ?? "any");

/** The DOCUMENT section: field, type, required, default, rule. Rendered, never hand-written. */
export function renderDocument(key: string): string[] {
  const rows: string[][] = [];
  const walk = (s: Schema, prefix: string) => {
    const props = (s["properties"] ?? {}) as Record<string, Schema>;
    const req = new Set((s["required"] as string[] | undefined) ?? []);
    for (const [name, p] of Object.entries(props)) {
      const path = prefix ? `${prefix}.${name}` : name;
      rows.push([path, typeName(p), req.has(name) ? "required" : "optional", "default" in p ? `default ${JSON.stringify(p["default"])}` : "", ruleOf(p)]);
      if (p["type"] === "object" && p["properties"]) walk(p, path);
      // A oneOf field lists each branch's fields, so optional branch fields are documented too.
      for (const branch of (p["oneOf"] as Schema[] | undefined) ?? []) walk(branch, path);
      const items = p["items"] as Schema | undefined;
      if (items?.["type"] === "object") walk(items, `${path}[]`);
    }
  };
  walk(documentSchema(key), "");
  const seen = new Set<string>();
  rows.splice(0, rows.length, ...rows.filter((r) => !seen.has(r.join("|")) && seen.add(r.join("|"))));
  const widths = [0, 1, 2].map((c) => Math.max(...rows.map((r) => r[c]!.length)));
  return rows.map((r) => [r[0]!.padEnd(widths[0]!), r[1]!.padEnd(widths[1]!), r[2]!.padEnd(widths[2]!), r[3], r[4]].filter(Boolean).join("  ").trimEnd());
}
