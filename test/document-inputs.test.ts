/**
 * Document inputs. The schema is the source (vendored
 * from the pinned OpenAPI fixture), the DOCUMENT section is its rendering,
 * the validator refuses keywords it does not enforce, and every refusal sends
 * nothing (each paired with a same-path control that sends).
 */
import { describe, it, expect } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pkgRoot } from "./helpers/pkg.js";
import { ANNOTATIONS, ENFORCED, renderDocument, validate, type Schema } from "../src/lib/document.js";
import { useSink } from "./helpers/sink.js";

/**
 * `delegated`: request properties another validator owns (a Motion's `sequence`
 * is the SDK's `validateSequence`), vendored as `{}`.
 * `response`: the `get` response schema; its keys the request lacks are
 * vendored as `x-curviate-response-only`, the keys a pasted `get` output drops
 * (a pasted `get` stays a valid document).
 */
type Entry = { command: string; flag: string; operation: string; pointer: string; delegated?: string[]; response?: string };
const manifest = JSON.parse(readFileSync(join(pkgRoot, "test/fixtures/document-inputs.json"), "utf8")) as { documents: Entry[] };
const openapi = JSON.parse(readFileSync(join(pkgRoot, "test/fixtures/openapi.json"), "utf8")) as unknown;
const SCHEMAS = join(pkgRoot, "src/schemas/documents.json");

const at = (doc: unknown, pointer: string) =>
  pointer.split("/").slice(1).reduce((o, k) => (o as Record<string, unknown>)[k.replace(/~1/g, "/").replace(/~0/g, "~")], doc);
const strip = (s: unknown): unknown =>
  Array.isArray(s) ? s.map(strip) : s && typeof s === "object" ? Object.fromEntries(Object.entries(s).filter(([k]) => k !== "description" && k !== "title").map(([k, v]) => [k, k === "properties" ? Object.fromEntries(Object.entries(v as object).map(([p, ps]) => [p, strip(ps)])) : strip(v)])) : s;

const vendored = (d: Entry): Schema => {
  const s = strip(at(openapi, d.pointer)) as Schema & { properties: Record<string, unknown> };
  for (const k of d.delegated ?? []) s.properties[k] = {};
  if (d.response) s["x-curviate-response-only"] = Object.keys((at(openapi, d.response) as { properties: object }).properties).filter((k) => !(k in s.properties));
  return s;
};

describe("document schemas", () => {
  it("src/schemas/documents.json is the fixture's schema at each manifest pointer (regenerate: WRITE_DOCUMENT_SCHEMAS=1)", () => {
    const expected = JSON.stringify(Object.fromEntries(manifest.documents.map((d) => [d.command, vendored(d)])), null, 2) + "\n";
    if (process.env["WRITE_DOCUMENT_SCHEMAS"] === "1") writeFileSync(SCHEMAS, expected);
    expect(manifest.documents.length).toBeGreaterThanOrEqual(3);
    expect(readFileSync(SCHEMAS, "utf8")).toBe(expected);
  });

  it("every vendored schema uses only keywords the validator enforces or annotates; any other keyword throws, never skips", () => {
    const used = new Set<string>();
    const walk = (x: unknown): void => {
      if (Array.isArray(x)) return x.forEach(walk);
      if (!x || typeof x !== "object") return;
      for (const [k, v] of Object.entries(x)) {
        used.add(k);
        if (k === "properties") Object.values(v as object).forEach(walk);
        else if (k !== "discriminator" && k !== "enum" && k !== "const") walk(v);
      }
    };
    for (const d of manifest.documents) walk(vendored(d));
    expect([...used].filter((k) => !ENFORCED.has(k) && !ANNOTATIONS.has(k) && !k.startsWith("x-"))).toEqual([]);
    expect(used.has("oneOf") && used.has("minLength") && used.has("additionalProperties")).toBe(true);
    expect(() => validate({ type: "string", pattern: "^a" }, "a")).toThrow(/pattern/);
    expect(() => validate({ type: "object", properties: { a: { type: "string", format: "email" } } }, { a: "x" })).toThrow(/format/);
  });

  it("the validator: one issue per fault, dot paths, enum/const/oneOf/minLength/minimum rules, a nearest-sibling suggestion, never a value", () => {
    const schema: Schema = {
      type: "object", additionalProperties: false, required: ["name", "kind"],
      properties: {
        name: { type: "string", minLength: 3 }, kind: { type: "string", enum: ["A", "B"] }, n: { type: "number", minimum: 0, maximum: 9 },
        tags: { type: "array", maxItems: 2, items: { type: "string", minLength: 1 } },
        ref: { oneOf: [{ type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }, { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false }] },
        apply: { oneOf: [{ type: "object", properties: { method: { const: "x" }, url: { type: "string" } }, required: ["method", "url"] }, { type: "object", properties: { method: { const: "y" } }, required: ["method"] }], discriminator: { propertyName: "method" } },
      },
    };
    expect(validate(schema, { name: "abc", kind: "A", ref: { id: "1" }, apply: { method: "y" } })).toEqual([]);
    expect(validate(schema, { name: "CANARY", kind: "Z", n: -1, nmae: 1, tags: ["", "b", "c"], ref: { id: 1 }, apply: { method: "x" } })).toEqual([
      { path: "kind", rule: "must be one of A, B" },
      { path: "n", rule: "must be at least 0" },
      { path: "nmae", rule: "unknown field", suggestion: "name" },
      { path: "tags", rule: "must have at most 2 items" },
      { path: "tags.0", rule: "must not be empty" },
      { path: "ref", rule: "must match one of: {id} | {name}" },
      { path: "apply.url", rule: "required" },
    ]);
    expect(validate(schema, { kind: "A", zzzzzz: 1 })).toEqual([{ path: "zzzzzz", rule: "unknown field" }, { path: "name", rule: "required" }]);
    expect(validate(schema, { name: "ab", kind: "A", apply: { method: "q" } })).toEqual([{ path: "name", rule: "must be at least 3 characters" }, { path: "apply.method", rule: "must be one of x, y" }]);
    expect(validate(schema, [])).toEqual([{ path: "(document)", rule: "must be an object" }]);
    // OpenAPI 3.0 `nullable`: null passes the type check only where declared.
    expect([validate({ type: "string", nullable: true }, null), validate({ type: "string" }, null)]).toEqual([[], [{ path: "(document)", rule: "must be a string" }]]);
    // Inherited member names are not fields, at the root or nested; the required check reads own keys too.
    for (const k of ["toString", "constructor", "hasOwnProperty", "valueOf", "isPrototypeOf", "__proto__"]) {
      const doc = JSON.parse(`{"name": "abc", "kind": "A", "ref": {"id": "1", "${k}": 1}, "${k}": 1}`) as unknown;
      expect(validate(schema, doc).map((i) => [i.path, i.rule]), k).toEqual([["ref", "must match one of: {id} | {name}"], [k, "unknown field"]]);
      expect(validate({ ...schema, required: [k] }, { name: "abc", kind: "A" }).map((i) => [i.path, i.rule]), k).toEqual([[k, "required"]]);
    }
  });
});

describe("--file through the entry point (core recruiter job create)", () => {
  const sink = useSink((h) => ({ body: h.url.includes("search") ? { object: "list", items: [], cursor: null } : { object: "recruiter_job", id: "job_1" } }));
  const dir = mkdtempSync(join(tmpdir(), "curviate-doc-"));
  const put = (name: string, content: string) => (writeFileSync(join(dir, name), content), join(dir, name));
  const DOC = {
    project_name: "Q3", job_title: { id: "9", name: "Staff Engineer" }, company: { name: "Acme" }, workplace_type: "REMOTE", location: "1",
    employment_status: "FULL_TIME", seniority_level: "MID_SENIOR_LEVEL", description: "x".repeat(200), industry: ["4"], job_function: ["8"],
    apply_method: { method: "external", website_url: "https://acme.example/jobs/1" },
  };
  mkdirSync(join(dir, "a-dir"));
  const A = ["--account", "acc_1"];
  const job = (file: string, opts: { stdin?: string; stdinTTY?: boolean; extra?: string[] } = {}) =>
    sink.run(["core", "recruiter", "job", "create", "--project-name", "Q3", "--file", file, ...A, ...(opts.extra ?? [])], opts);

  it("a valid file, and the same document on stdin, each send exactly one create carrying it (control)", async () => {
    for (const r of [await job(put("ok.json", JSON.stringify(DOC))), await job("-", { stdin: JSON.stringify(DOC) })]) {
      expect([r.status, r.requests.length], r.stderr).toEqual([0, 1]);
      expect(JSON.parse(r.requests[0]!.body)).toEqual(DOC);
    }
  });

  it.each<[string, () => ReturnType<typeof job>, RegExp]>([
    ["a missing path", () => job(join(dir, "nope.json")), /--file: no such file/],
    ["a directory", () => job(join(dir, "a-dir")), /is a directory/],
    ["an empty file", () => job(put("empty.json", "  \n")), /--file: empty input/],
    ["empty stdin", () => job("-", { stdin: "" }), /--file: empty input/],
    ["invalid JSON, named by line and column", () => job(put("bad.json", '{\n  "a": 1,\n  oops\n}')), /not valid JSON at line 3, column 3/],
    ["inline JSON", () => job('{"a":1}'), /--file - <<'EOF'/],
    ["inline JSON array", () => job("[1]"), /--file - <<'EOF'/],
    ["a file past the 5 MiB cap", () => job(put("big.json", `{"a":"${"x".repeat(5 * 1024 * 1024)}"}`)), /--file: larger than 5 MiB/],
    ["an endless device", () => job("/dev/zero"), /--file: larger than 5 MiB/],
    ["stdin past the cap", () => job("-", { stdin: "x".repeat(5 * 1024 * 1024 + 1) }), /--file: larger than 5 MiB/],
    ["an unreadable file", () => { const f = put("locked.json", "{}"); chmodSync(f, 0); return job(f); }, /--file: cannot read .*EACCES/],
    ["- while stdin is a terminal", () => job("-", { stdinTTY: true }), /stdin is a terminal/],
    ["the old --body-file", () => sink.run(["core", "recruiter", "job", "create", "--body-file", put("ok2.json", JSON.stringify(DOC)), ...A]), /unknown flag `--body-file`/],
    ["the old --body -", () => sink.run(["core", "recruiter", "job", "create", "--body", "-", ...A], { stdin: JSON.stringify(DOC) }), /unknown flag `--body`/],
    ["a UTF-8 byte order mark, named (not a JSON column)", () => job(put("bom.json", "\uFEFF" + JSON.stringify(DOC))), /--file: starts with a byte order mark \(BOM\)/],
    ["Latin-1 bytes, never sent as U+FFFD", () => { const f = join(dir, "latin1.json"); writeFileSync(f, Buffer.from('{"a":"caf\xe9"}', "latin1")); return job(f); }, /--file: not valid UTF-8/],
    ["Latin-1 bytes on stdin", () => sink.run(["core", "search", "people", "--filters-file", "-", ...A], { stdin: Buffer.from('{"keywords":"caf\xe9"}', "latin1") }), /--filters-file: not valid UTF-8/],
    ["--filters-file invalid JSON, named by line and column", () => sink.run(["core", "search", "people", "--filters-file", put("badf.json", '{\n  oops\n}'), ...A]), /--filters-file: not valid JSON at line 2, column 3/],
    ["two stdin inputs in one call", () => sink.run(["core", "search", "people", "--filters-file", "-", "--filters", "-", ...A], { stdin: "{}" }), /both read stdin/],
  ])("%s: exit 2, zero requests", async (_l, go, message) => {
    const r = await go();
    expect([r.status, r.requests.length, r.stdout]).toEqual([2, 0, ""]);
    expect(r.stderr).toMatch(message);
  });

  it("inherited member names as fields (toString, constructor, __proto__), nested too, are unknown fields: exit 2, nothing sent", async () => {
    const raw = JSON.stringify(DOC).replace('"company":{', '"company":{"constructor":1,').replace('{"project_name"', '{"toString":1,"__proto__":{"x":1},"project_name"');
    const r = await job(put("proto.json", raw), { extra: ["--json"] });
    expect([r.status, r.requests.length]).toEqual([2, 0]);
    expect((JSON.parse(r.stdout) as { error: { errors: Array<{ path: string }> } }).error.errors.map((e) => e.path)).toEqual(["toString", "__proto__", "company"]);
  });

  it("--filters-file - reads the filter document from stdin into the request; UTF-8 text arrives intact (control for the decode refusals)", async () => {
    const r = await sink.run(["core", "search", "people", "--filters-file", "-", ...A, "--json"], { stdin: Buffer.from('{"keywords":"café rust"}', "utf8") });
    expect([r.status, r.requests.length], r.stderr).toEqual([0, 1]);
    expect(JSON.parse(r.requests[0]!.body)).toMatchObject({ keywords: "café rust" });
  });

  it("three faults: three `<path>: <rule>` lines, the typo named with its field, INVALID_REQUEST with three errors in JSON mode, no value echoed, nothing sent", async () => {
    const CANARY = "CANARY_9f3a2b_value";
    const rest: Record<string, unknown> = { ...DOC };
    delete rest["job_title"];
    const doc = { ...rest, job_titel: { id: CANARY, name: CANARY }, workplace_type: CANARY, description: `short ${CANARY}` };
    const flags = ["--job-title-id", "9", "--job-title", "Staff Engineer"];
    const human = await job(put("three.json", JSON.stringify(doc)), { extra: flags });
    expect([human.status, human.requests.length]).toEqual([2, 0]);
    expect(human.stderr.split("\n").filter((l) => /^  [\w.]+: /.test(l))).toEqual([
      "  workplace_type: must be one of ON_SITE, HYBRID, REMOTE",
      "  description: must be at least 200 characters",
      "  job_titel: unknown field (did you mean job_title?)",
    ]);
    const json = await job(put("three.json", JSON.stringify(doc)), { extra: [...flags, "--json"] });
    expect([json.status, json.requests.length]).toEqual([2, 0]);
    const env = JSON.parse(json.stdout) as { error: { code: string; errors: Array<{ path: string; suggestion?: string }> } };
    expect(env.error.code).toBe("INVALID_REQUEST");
    expect(env.error.errors.map((e) => e.path)).toEqual(["workplace_type", "description", "job_titel"]);
    expect(env.error.errors[2]!.suggestion).toBe("job_title");
    expect(human.stdout + human.stderr + json.stdout + json.stderr).not.toContain(CANARY);
  });

  it("a missing field names the flag that sets it; named flags merge into the document before validation", async () => {
    const noWorkplace: Record<string, unknown> = { ...DOC };
    delete noWorkplace["workplace_type"];
    const missing = await job(put("nw.json", JSON.stringify(noWorkplace)));
    expect([missing.status, missing.requests.length]).toEqual([2, 0]);
    expect(missing.stderr).toContain("workplace_type: required (--workplace-type, or workplace_type in --file)");
    const emptyList = await job(put("noind.json", JSON.stringify({ ...DOC, industry: [] })));
    expect([emptyList.status, emptyList.requests.length, emptyList.stderr]).toEqual([2, 0, expect.stringContaining("industry: required (--industry, or industry in --file)")]);
    const merged = await job(put("nw.json", JSON.stringify(noWorkplace)), { extra: ["--workplace-type", "HYBRID"] });
    expect([merged.status, merged.requests.length], merged.stderr).toEqual([0, 1]);
    expect(JSON.parse(merged.requests[0]!.body)).toMatchObject({ workplace_type: "HYBRID" });
  });

  it("help prints the DOCUMENT section rendered from the schema, before EXAMPLES", async () => {
    const r = await sink.run(["core", "recruiter", "job", "create", "--help"]);
    const rows = renderDocument("core recruiter job create");
    expect(rows.length).toBeGreaterThan(15);
    expect(rows).toContain(rows.find((l) => /^description\s+string\s+required\s+at least 200 characters$/.test(l)));
    for (const field of ["apply_method.website_url", "apply_method.notification_email", "apply_method.resume_required", "company.id", "company.name"]) expect(rows.some((l) => l.startsWith(`${field} `)), field).toBe(true);
    // One row per field: oneOf branches merge, and a branch-only field says which branch requires it.
    for (const key of ["core recruiter job create", "core recruiter project-job create", "core recruiter project-job update"]) {
      const paths = renderDocument(key).map((l) => l.split(/\s+/)[0]);
      expect(paths.filter((p, i) => paths.indexOf(p) !== i), key).toEqual([]);
    }
    expect(rows.filter((l) => /^(apply_method\.(method|notification_email|website_url)|company\.id) /.test(l)).map((l) => l.split(/\s{2,}/).slice(2).join(" | "))).toEqual([
      "required in {id} | non-empty",
      "required | one of linkedin, external",
      'required if method is "linkedin"',
      'required if method is "external" | non-empty',
    ]);
    expect(r.stdout).toContain(`DOCUMENT\n\n${rows.map((l) => `  ${l}`).join("\n")}\n\n`);
    expect(r.stdout.indexOf("DOCUMENT")).toBeLessThan(r.stdout.indexOf("EXAMPLES"));
  });
});
