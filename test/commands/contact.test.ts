/** `contact` over the wire: the request each flag sends, chunking, import splitting, export contract. */
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { useSink, line, type Hit } from "../helpers/sink.js";

const CON = { object: "contact", id: "con_1", company_linkedin_url: "https://www.linkedin.com/company/1/", linkedin_url: "https://www.linkedin.com/in/jane", full_name: "Jane", tags: ["a"], list_ids: [], connected_account_ids: [], enrichment: { status: "none" } };
const PAGE = { object: "contact_page", items: [CON], cursor: null, total: 1 };
const IMP = (counts = { created: 1, updated: 0, unchanged: 0, skipped: 0 }) => ({ object: "contact_import", id: "imp_1", status: "completed", counts, report: [] });
let imports = 0;
const sink = useSink((h: Hit) => {
  const [path] = h.url.split("?");
  if (path === "/v1/contacts" && h.method === "GET") return { body: PAGE };
  if (path === "/v1/contacts/export") return { type: "application/x-ndjson", body: `${JSON.stringify(CON)}\n${JSON.stringify(CON)}\n` };
  if (path === "/v1/contacts/update") return { body: { updated: 2, unchanged: 0, not_found: [], refused: [] } };
  if (path === "/v1/contacts/delete") return { body: { deleted: 2, not_found: [] } };
  if (path === "/v1/contacts/imports/imp_q") return { body: { ...IMP(), id: "imp_q", status: h.method === "GET" ? "completed" : "queued" } };
  if (path === "/v1/contacts/imports" && h.method === "POST" && h.body.includes("QUEUED")) return { status: 202, body: { ...IMP(), id: "imp_q", status: "queued" } };
  if (path === "/v1/contacts/imports" && h.method === "POST" && h.body.includes("FAILIMP")) return { status: 201, body: { ...IMP(), status: "failed", failure: { code: "CONTACT_LIMIT_REACHED", message: "cap" } } };
  if (path === "/v1/contacts/imports" && h.method === "POST") {
    imports++;
    if (h.body.includes("REFUSE")) return { status: 429, body: { code: "IMPORT_QUEUE_FULL", message: "queue full", user_fixable: true, retry_likely_to_succeed: true } };
    return { status: 201, body: { ...IMP(), id: `imp_${imports}`, counts: { created: 1, updated: 0, unchanged: 0, skipped: imports === 2 ? 1 : 0 }, report: imports === 2 ? [{ row: 1, outcome: "skipped", reason: "invalid_linkedin_url", field: "linkedin_url" }] : [] } };
  }
  if (path === "/v1/contact-lists" && h.method === "POST") return { status: 201, body: { object: "contact_list", id: "cl_new", name: "n", contact_count: 3 } };
  return { body: CON };
});
const q = (h: Hit) => Object.fromEntries(new URL(h.url, "http://x").searchParams);
const dir = mkdtempSync(join(tmpdir(), "contact-"));
const file = (name: string, content: string | Buffer) => (writeFileSync(join(dir, name), content), join(dir, name));

describe("contact list filters", () => {
  it("contact get --json carries company_linkedin_url", async () => {
    expect(JSON.parse((await sink.run(["contact", "get", "con_1", "--json"])).stdout)).toMatchObject({ company_linkedin_url: "https://www.linkedin.com/company/1/" });
  });

  it("--no-connected --tag a --tag b --import imp_1 is one request with connected=false&tag=a,b&import_id=imp_1", async () => {
    const r = await sink.run(["contact", "list", "--no-connected", "--tag", "a", "--tag", "b", "--import", "imp_1", "--json"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.requests.map(line)).toEqual(["GET /v1/contacts"]);
    expect(q(r.requests[0]!)).toEqual({ connected: "false", tag: "a,b", import_id: "imp_1" });
  });

  it("multi-list: any / all / without, and email presence", async () => {
    const r = await sink.run(["contact", "list", "--list", "cl_a", "--list", "cl_b", "--list-match", "all", "--not-list", "cl_c", "--no-email", "--total", "--limit", "1", "--json"]);
    expect(q(r.requests[0]!)).toEqual({ list_id: "cl_a,cl_b", list_match: "all", not_list_id: "cl_c", has_email: "false", include_total: "true", limit: "1" });
    expect(q((await sink.run(["contact", "list", "--has-email", "--json"])).requests[0]!)).toEqual({ has_email: "true" });
    expect((await sink.run(["contact", "list", "--has-email", "--no-email"])).requests).toHaveLength(0);
  });

  it("--connected-account is explicit: CURVIATE_ACCOUNT alone adds no account_id; the flag adds it", async () => {
    const none = await sink.run(["contact", "list", "--json"], { env: { CURVIATE_ACCOUNT: "acc_env" } });
    expect(q(none.requests[0]!)).not.toHaveProperty("account_id");
    const some = await sink.run(["contact", "list", "--connected-account", "acc_1", "--json"], { env: { CURVIATE_ACCOUNT: "acc_env" } });
    expect(q(some.requests[0]!)["account_id"]).toBe("acc_1");
    const several = await sink.run(["contact", "list", "--connected-account", "acc_1", "--connected-account", "acc_2,acc_3", "--json"]);
    expect(q(several.requests[0]!)["account_id"]).toBe("acc_1,acc_2,acc_3");
  });

  it.each([
    [["--list-match", "all"]],
    [["--status", "active"]],
    [["--connected-account", "acc_1", "--no-connected"]],
    [["--enrichment-status", "bogus"]],
  ])("%j is refused before any request", async (flags) => {
    const r = await sink.run(["contact", "list", ...flags]);
    expect([r.status, r.requests.length]).toEqual([2, 0]);
  });
});

describe("bulk update and delete", () => {
  it("tags add of 1,500 ids is 2 requests of 1000 and 500, summed", async () => {
    const ids = Array.from({ length: 1500 }, (_, i) => `con_${i}`);
    const r = await sink.run(["contact", "tags", "add", "Hot", ...ids, "--json"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.requests.map((h) => (JSON.parse(h.body) as { contact_ids: string[] }).contact_ids.length)).toEqual([1000, 500]);
    expect(JSON.parse(r.requests[0]!.body)).toMatchObject({ add_tags: ["Hot"] });
    expect(JSON.parse(r.stdout)).toMatchObject({ updated: 4 });
  });

  it("by filter: lists add / tags remove send a filter, not ids; ids with a filter, or neither, exit 2", async () => {
    const add = await sink.run(["contact", "lists", "add", "cl_x", "--tag", "hot", "--from-list", "cl_a", "--from-list", "cl_b", "--no-email", "--json"]);
    expect(JSON.parse(add.requests[0]!.body)).toEqual({ filter: { tag: ["hot"], list_id: ["cl_a", "cl_b"], has_email: false }, add_list_id: "cl_x" });
    const rm = await sink.run(["contact", "tags", "remove", "Hot", "--list", "cl_a", "--json"]);
    expect(JSON.parse(rm.requests[0]!.body)).toEqual({ filter: { list_id: ["cl_a"] }, remove_tags: ["Hot"] });
    for (const args of [["contact", "tags", "add", "Hot", "con_1", "--tag", "x"], ["contact", "tags", "add", "Hot"]]) {
      const r = await sink.run(args);
      expect([r.status, r.requests.length]).toEqual([2, 0]);
    }
  });

  it("delete: one id is DELETE; ids and a filter use the bulk call; no target exits 2", async () => {
    expect((await sink.run(["contact", "delete", "con_1", "--json"])).requests.map(line)).toEqual(["DELETE /v1/contacts/con_1"]);
    const many = await sink.run(["contact", "delete", "--ids", "con_1,con_2", "--json"]);
    expect([line(many.requests[0]!), JSON.parse(many.requests[0]!.body)]).toEqual(["POST /v1/contacts/delete", { contact_ids: ["con_1", "con_2"] }]);
    const filt = await sink.run(["contact", "delete", "--tag", "stale", "--json"]);
    expect(JSON.parse(filt.requests[0]!.body)).toEqual({ filter: { tag: ["stale"] } });
    const none = await sink.run(["contact", "delete"]);
    expect([none.status, none.requests.length]).toEqual([2, 0]);
  });
});

describe("lists combine", () => {
  it("creates one list from the source lists, match mode and exclusions", async () => {
    const r = await sink.run(["contact", "lists", "combine", "Both", "--list", "cl_a", "--list", "cl_b", "--list-match", "all", "--not-list", "cl_dnc", "--json"]);
    expect([line(r.requests[0]!), JSON.parse(r.requests[0]!.body)]).toEqual(["POST /v1/contact-lists", { name: "Both", from: { list_id: ["cl_a", "cl_b"], list_match: "all", not_list_id: ["cl_dnc"] } }]);
    expect((await sink.run(["contact", "lists", "combine", "X"])).requests).toHaveLength(0);
  });
});

describe("contact import", () => {
  const row = (i: number) => `https://www.linkedin.com/in/p${i},Person ${i}`;
  const csv = (n: number) => ["linkedin_url,full_name", ...Array.from({ length: n }, (_, i) => row(i))].join("\n");

  it("a 25,000-row CSV is 3 imports of 10,000, 10,000 and 5,000 with the header repeated, one aggregated report with global row numbers", async () => {
    imports = 0;
    const r = await sink.run(["contact", "import", "--file", file("big.csv", csv(25_000)), "--list-name", "L", "--tag", "t", "--apply-lists", "--json"]);
    expect(r.status, r.stderr).toBe(0);
    const bodies = r.requests.map((h) => JSON.parse(h.body) as { csv: string; list_name: string; tags: string[]; apply_lists?: boolean });
    expect(bodies.every((b) => b.apply_lists === true)).toBe(true); // every chunk carries the opt-in
    expect(bodies.map((b) => b.csv.split("\n").length - 1)).toEqual([10_000, 10_000, 5_000]);
    expect(bodies.every((b) => b.csv.startsWith("linkedin_url,full_name\n") && b.list_name === "L" && b.tags[0] === "t")).toBe(true);
    const out = JSON.parse(r.stdout) as { imports: unknown[]; total_rows: number; counts: Record<string, number>; skipped: Array<{ row: number }> };
    expect([out.imports.length, out.total_rows, out.counts["created"], out.counts["skipped"]]).toEqual([3, 25_000, 3, 1]);
    expect(out.skipped.map((s) => s.row)).toEqual([10_001]); // row 1 of the second import
  });

  it("the second import refused: the third is never sent, and the exit is the refusal's", async () => {
    imports = 0;
    const rows = csv(10_000) + "\n" + Array.from({ length: 10_000 }, (_, i) => `REFUSE${i},x`).join("\n") + "\n" + row(0);
    const r = await sink.run(["contact", "import", "--file", file("refuse.csv", rows), "--json"]);
    expect(r.requests).toHaveLength(2);
    expect(JSON.parse(r.requests[0]!.body)).not.toHaveProperty("apply_lists"); // default off: the key is not sent
    expect(r.status).toBe(6);
    expect(JSON.parse(r.stdout)).toMatchObject({ progress: { chunks: { sent: 1, total: 3 }, failed_chunk: { index: 2, first_row: 10_001 } } });
  });

  it("a failed import stops the run: the next chunk is never sent, and the exit is the failure's", async () => {
    const r = await sink.run(["contact", "import", "--file", file("fail.csv", "linkedin_url\nFAILIMP\n" + Array.from({ length: 10_000 }, () => "x").join("\n")), "--json"]);
    expect([r.requests.length, r.status]).toEqual([1, 2]);
    expect(JSON.parse(r.stdout)).toMatchObject({ error: { code: "CONTACT_LIMIT_REACHED" } }); // one document
  });

  it(".json and .ndjson arrive as rows; a Latin-1 file, --file - without --format, and an empty file exit 2 with zero requests", async () => {
    const objs = [{ linkedin_url: "https://www.linkedin.com/in/a" }, { linkedin_url: "https://www.linkedin.com/in/b" }];
    const j = await sink.run(["contact", "import", "--file", file("a.json", JSON.stringify(objs)), "--json"]);
    expect(JSON.parse(j.requests[0]!.body)).toEqual({ rows: objs });
    const n = await sink.run(["contact", "import", "--file", file("a.ndjson", objs.map((o) => JSON.stringify(o)).join("\n")), "--json"]);
    expect(JSON.parse(n.requests[0]!.body)).toEqual({ rows: objs });
    const refused: Array<() => ReturnType<typeof sink.run>> = [
      () => sink.run(["contact", "import", "--file", file("l1.csv", Buffer.from("linkedin_url,name\nx,caf\xe9\n", "latin1"))]),
      () => sink.run(["contact", "import", "--file", "-"], { stdin: "linkedin_url\nx" }),
      () => sink.run(["contact", "import", "--file", file("empty.csv", "")]),
      () => sink.run(["contact", "import", "--file", file("bad.json", '{"a":')]),
    ];
    for (const run of refused) {
      const r = await run();
      expect([r.status, r.requests.length]).toEqual([2, 0]);
    }
  });

  it("a queued import is awaited by polling it; --no-wait prints the id and does not poll", async () => {
    const f = file("q.csv", "linkedin_url\nQUEUED\n");
    const waited = await sink.run(["contact", "import", "--file", f, "--json"]);
    expect(waited.requests.map(line)).toEqual(["POST /v1/contacts/imports", "GET /v1/contacts/imports/imp_q"]);
    expect(JSON.parse(waited.stdout).imports).toEqual([{ id: "imp_q", status: "completed" }]);
    const fast = await sink.run(["contact", "import", "--file", f, "--no-wait", "--json"]);
    expect(fast.requests.map(line)).toEqual(["POST /v1/contacts/imports"]);
    expect(JSON.parse(fast.stdout).imports).toEqual([{ id: "imp_q", status: "queued" }]);
  });

  /** The report is the whole of stdout: one JSON document. */
  const oneDoc = (r: { stdout: string }) => JSON.parse(r.stdout) as Record<string, unknown>;
  const OK = (rows: number, id: string, extra: object = {}) => ({ ...IMP({ created: rows, updated: 0, unchanged: 0, skipped: 0 }), id, total_rows: rows, format: "csv", list_id: null, created_at: new Date().toISOString(), ...extra });
  const post = (h: Hit) => h.method === "POST" && h.url === "/v1/contacts/imports";

  it("a timeout after the API committed reports the import it made (id, completed, counts), exit 0, never 'not sent'", async () => {
    let committed: object | undefined;
    sink.reply = (h) => {
      if (post(h)) return (committed = OK(3, "imp_slow")), { status: 201, body: committed, delayMs: 1500 };
      if (h.url.startsWith("/v1/contacts/imports")) return { body: { object: "contact_import_list", items: committed ? [committed] : [], cursor: null } };
      return { body: {} };
    };
    const r = await sink.run(["contact", "import", "--file", file("slow.csv", "linkedin_url\na\nb\nc\n"), "--timeout", "400", "--json"]);
    expect(r.status, r.stderr).toBe(0);
    expect(oneDoc(r)).toMatchObject({ imports: [{ id: "imp_slow", status: "completed" }], total_rows: 3, counts: { created: 3 } });
    expect(r.requests.filter(post)).toHaveLength(1); // never resent
    expect(r.stderr).toContain("imp_slow");
    expect(r.stderr).not.toMatch(/were sent/);
  });

  it("nothing reached the API (connection refused): says nothing was imported, non-zero exit; a timeout with no import found does not claim the rows were not sent", async () => {
    const closed = createServer();
    await new Promise<void>((ok) => closed.listen(0, "127.0.0.1", ok));
    const port = (closed.address() as { port: number }).port;
    await new Promise((ok) => closed.close(ok));
    const refused = await sink.run(["contact", "import", "--file", file("refused.csv", "linkedin_url\na\n"), "--base-url", `http://127.0.0.1:${port}`, "--json"]);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("Nothing was imported");
    const stalled = await (async () => {
      sink.reply = (h) => (post(h) ? { status: 201, body: OK(1, "imp_x"), delayMs: 1500 } : { body: { object: "contact_import_list", items: [], cursor: null } });
      return sink.run(["contact", "import", "--file", file("stalled.csv", "linkedin_url\na\n"), "--timeout", "400", "--json"]);
    })();
    expect(stalled.status).not.toBe(0);
    expect(stalled.stderr).toContain("contact imports list");
    expect(stalled.stderr).not.toMatch(/0 of 1 rows were sent/);
  });

  it("a 429 RATE_LIMIT_TENANT with Retry-After: 2 on chunk 2 of 3 waits, resends chunk 2, sends chunk 3, and sums all three; one JSON document", async () => {
    let sends = 0;
    const when: number[] = [];
    sink.reply = (h) => {
      if (!post(h)) return { body: {} };
      sends++;
      when.push(performance.now());
      if (sends === 2) return { status: 429, headers: { "retry-after": "2" }, body: { code: "RATE_LIMIT_TENANT", message: "busy", user_fixable: false, retry_likely_to_succeed: true } };
      return { status: 201, body: OK(10_000, `imp_${sends}`) };
    };
    const rows = Array.from({ length: 25_000 }, (_, i) => row(i));
    const r = await sink.run(["contact", "import", "--file", file("rl.csv", ["linkedin_url,full_name", ...rows].join("\n")), "--json"]);
    expect(r.status, r.stderr).toBe(0);
    expect(sends).toBe(4); // chunk 1, chunk 2 refused, chunk 2 again, chunk 3
    expect(when[2]! - when[1]!).toBeGreaterThanOrEqual(1900);
    expect(oneDoc(r)).toMatchObject({ total_rows: 25_000, counts: { created: 30_000 } }); // the fake counts 10,000 for each of its 3 imports
    expect((oneDoc(r)["imports"] as unknown[]).length).toBe(3);
  }, 15_000);

  it("a Retry-After above the bound fails loudly at once: no sleep, no resend, nothing claimed sent", async () => {
    sink.reply = (h) => (post(h) ? { status: 429, headers: { "retry-after": "600" }, body: { code: "RATE_LIMIT_TENANT", message: "busy", user_fixable: false, retry_likely_to_succeed: true } } : { body: {} });
    const r = await sink.run(["contact", "import", "--file", file("bound.csv", "linkedin_url\na\n"), "--json"]);
    expect(r.requests.filter(post)).toHaveLength(1);
    expect(r.status).toBe(6);
    expect(r.stderr).toMatch(/600 s/);
    expect(JSON.parse(r.stdout)).toMatchObject({ error: { code: "RATE_LIMIT_TENANT" } }); // still one document
  }, 4_000);

  it("a BOM is dropped; --map and --delimiter are sent", async () => {
    const r = await sink.run(["contact", "import", "--file", file("bom.csv", "﻿url;n\nx;y\n"), "--map", "url=linkedin_url", "--delimiter", "semicolon", "--json"]);
    expect(JSON.parse(r.requests[0]!.body)).toMatchObject({ csv: "url;n\nx;y", mapping: { url: "linkedin_url" }, delimiter: ";" });
  });
});

describe("contact export", () => {
  it("default ndjson to stdout carries data only; --output leaves a 0600 file and replaces an existing 0644 one", async () => {
    const r = await sink.run(["contact", "export", "--tag", "hot"]);
    expect(r.stdout).toBe(`${JSON.stringify(CON)}\n${JSON.stringify(CON)}\n`); // several rows: a body that is not one JSON document
    expect(q(r.requests[0]!)).toEqual({ tag: "hot", format: "ndjson" });
    const out = file("out.ndjson", "old");
    chmodSync(out, 0o644);
    await sink.run(["contact", "export", "--output", out]);
    expect([readFileSync(out, "utf8"), (statSync(out).mode & 0o777).toString(8)]).toEqual([`${JSON.stringify(CON)}\n${JSON.stringify(CON)}\n`, "600"]);
  });

  it("a failure leaves the existing file byte-identical and no temp file; --json exits 2 naming --format json", async () => {
    const out = file("keep.ndjson", "keep");
    sink.reply = { status: 403, body: { code: "INSUFFICIENT_ROLE", message: "no", user_fixable: true, retry_likely_to_succeed: false } };
    const r = await sink.run(["contact", "export", "--output", out, "--json"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--format json");
    const bad = await sink.run(["contact", "export", "--output", out]);
    expect(bad.status).toBe(5);
    expect(readFileSync(out, "utf8")).toBe("keep");
    expect(existsSync(join(dir, `.keep.ndjson.${process.pid}.tmp`))).toBe(false);
  });
});

describe("contact create / update", () => {
  it("create sends the fields, tags and list; update --clear sends null; update with nothing exits 2", async () => {
    const c = await sink.run(["contact", "create", "--linkedin-url", "https://www.linkedin.com/in/jane", "--email", "j@x.co", "--tag", "a", "--tag", "b", "--list-name", "L", "--json"]);
    expect(JSON.parse(c.requests[0]!.body)).toEqual({ linkedin_url: "https://www.linkedin.com/in/jane", email: "j@x.co", tags: ["a", "b"], list_name: "L" });
    const u = await sink.run(["contact", "update", "con_1", "--clear", "email,about", "--company", "Acme", "--json"]);
    expect([line(u.requests[0]!), JSON.parse(u.requests[0]!.body)]).toEqual(["PATCH /v1/contacts/con_1", { company: "Acme", email: null, about: null }]);
    const none = await sink.run(["contact", "update", "con_1"]);
    expect([none.status, none.requests.length]).toEqual([2, 0]);
  });
});
