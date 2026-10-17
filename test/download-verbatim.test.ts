/**
 * Which 2xx bodies are an API answer. A download command saves any 2xx body
 * verbatim whatever its content type; every other command treats a non-empty
 * body that is not JSON as a platform fault (exit 7, PLATFORM_ERROR). A list
 * read (--all or not), a doctor probe and every lookup that feeds a request
 * path refuse a body that is not the shape they need, and never build a path
 * with `undefined` in it. In-process against a recording sink.
 */
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useSink, type Reply } from "./helpers/sink.js";

const dir = mkdtempSync(join(tmpdir(), "curviate-download-"));
const sink = useSink();
const reply = (status: number, type: string | null, body: string): Reply => ({ status, body, type: type ?? "" });
const run = (argv: string[], key = true) => sink.run([...argv, ...(key ? ["--account", "acc_1"] : [])], { xdg: dir });
const fail7 = (r: { status: number; stdout: string; stderr: string }) => {
  expect(r.status, r.stdout + r.stderr).toBe(7);
  expect(r.stdout).toContain("PLATFORM_ERROR");
};

describe("download commands save any 2xx body verbatim", () => {
  const DOWNLOADS: Array<[string, string[]]> = [
    ["message attachment", ["message", "attachment", "chat_1", "msg_1", "att_1"]],
    ["job applicant resume", ["job", "applicant", "resume", "123", "app_1"]],
    ["recruiter applicant resume", ["recruiter", "applicant", "resume", "proj_1", "app_1", "--beta"]],
  ];
  const BODIES: Array<[string, string]> = [
    ["text/html", "<!doctype html><html><body>résumé</body></html>\n"],
    ["application/json", "<html>not json</html>"],
    ["application/json", '{"code":"PLATFORM_ERROR","a":1}'],
  ];
  let n = 0;
  it.each(DOWNLOADS)("%s: any 200 body is saved byte-identical (exit 0); an HTML 502 is exit 7 with no file", async (_name, argv) => {
    for (const [type, body] of BODIES) {
      sink.reply = reply(200, type, body);
      const out = join(dir, `out-${n++}.bin`);
      const r = await run([...argv, "-o", out]);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(readFileSync(out).equals(Buffer.from(body))).toBe(true);
    }
    sink.reply = reply(502, "text/html", "<html>Bad Gateway</html>");
    const out = join(dir, `out-${n++}.bin`);
    expect((await run([...argv, "-o", out])).status).toBe(7);
    expect(existsSync(out)).toBe(false);
  });

  it("control: a non-download command's 200 HTML still exits 7", async () => {
    sink.reply = reply(200, "text/html", "<html>portal</html>");
    fail7(await run(["profile", "me", "--json"]));
  });
});

describe("any other command: a non-empty 2xx body that is not JSON exits 7", () => {
  it.each([
    ["text/plain", "hello"], ["application/octet-stream", "hello"], [null, "hello"],
    ["text/html", "<html>portal</html>"], ["application/json", "<html>portal</html>"], ["application/json", " "],
  ])("%s %j", async (type, body) => {
    sink.reply = reply(200, type, body);
    for (const argv of [["post", "get", "p1"], ["post", "delete", "p1"], ["account", "list"]]) fail7(await run([...argv, "--json"]));
  });

  it.each([
    [204, null, ""], [200, null, ""], [200, "application/json", ""], [200, "text/plain", ""],
    [200, "application/json", "{}"], [201, "application/json; charset=utf-8", '{"ok":true}'],
  ])("post delete: %i %s %j is exit 0", async (status, type, body) => {
    sink.reply = reply(status, type, body);
    const r = await run(["post", "delete", "p1", "--json"]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).not.toContain("PLATFORM_ERROR");
  });
});

describe("a 2xx that is not a list page", () => {
  const NOT_A_PAGE: Array<[number, string | null, string]> = [
    [200, "application/json", "null"], [200, "application/json", ""], [204, null, ""], [200, "application/json", "[]"],
    [200, "application/json", "5"], [200, "application/json", '"x"'], [200, "application/json", "{}"],
    [200, "application/json", '{"items":null,"cursor":null}'], [200, "application/json", '{"items":"x","cursor":null}'],
    [200, "application/json", '{"items":{},"cursor":null}'], [200, "application/json", '{"items":null,"data":[],"cursor":null}'],
  ];
  const ALL: string[][] = [
    ["account", "list", "--all"], ["webhook", "list", "--all"], ["connect", "sent", "--all"], ["inbox", "list", "--all"],
    ["job", "list", "--state", "OPEN", "--all"], ["job", "list", "--state", "ALL", "--all"],
    ["job", "list", "--state", "OPEN"], ["job", "list", "--state", "ALL"],
  ];

  it.each(NOT_A_PAGE)("%i %s %j: doctor is 'not verified' (exit 7) and every list read exits 7 without crashing", async (status, type, body) => {
    sink.reply = reply(status, type, body);
    const doc = await run(["doctor", "--json"], false);
    expect(doc.status, doc.stdout + doc.stderr).toBe(7);
    const report = JSON.parse(doc.stdout.trim()) as { credential_valid: boolean; api_reachable: boolean; exit: number; checks: Array<{ name: string; detail: string }> };
    expect([report.credential_valid, report.api_reachable, report.exit]).toEqual([false, true, 7]);
    expect(report.checks.find((c) => c.name === "credential valid")?.detail).toMatch(/not verified/);
    for (const argv of ALL) {
      const r = await run([...argv, "--json"]);
      fail7(r);
      expect(r.stdout + r.stderr, argv.join(" ")).not.toMatch(/Internal error|Cannot read|is not a function|requires a paginated method/);
    }
  });

  it("controls: a page carried as `data` streams; a real empty page is verified and every list streams", async () => {
    sink.reply = reply(200, "application/json", JSON.stringify({ object: "list", data: [{ id: "proj_1" }], cursor: null }));
    const rec = await run(["recruiter", "projects", "--all", "--json", "--page-delay", "0", "--beta"]);
    expect([rec.status, rec.stdout.includes("proj_1")]).toEqual([0, true]);
    sink.reply = reply(200, "application/json", JSON.stringify({ object: "list", items: [], cursor: null }));
    const doc = await run(["doctor", "--json"], false);
    expect([doc.status, (JSON.parse(doc.stdout.trim()) as { credential_valid: boolean }).credential_valid]).toEqual([0, true]);
    for (const argv of ALL) expect((await run([...argv, "--json"])).status, argv.join(" ")).toBe(0);
  });
});

describe("a name or slug lookup whose answer is unreadable", () => {
  const SLUG: string[][] = [
    ["company", "posts", "acme"], ["company", "employees", "acme"], ["post", "user-posts", "john-doe"], ["comment", "user", "john-doe"],
    ["profile", "john-doe", "--sections", "skills"], ["profile", "someco", "--posts", "--is-company"],
    ["profile", "endorse", "john-doe", "--endorsement-id", "e1"], ["profile", "follow", "john-doe"],
    ["message", "new", "--to", "john-doe", "hello"], ["message", "inmail", "--to", "john-doe", "--subject", "Hi", "hello"],
  ];

  it.each(["null", "{}", '{"items":{}}', "[]", '{"id":null}', '{"id":""}'])("slug lookup answered %s: exit 7 and no request path carries undefined", async (body) => {
    for (const argv of SLUG) {
      sink.reply = reply(200, "application/json", body);
      const r = await run([...argv, "--json"]);
      expect(r.status, `${argv.join(" ")}: ${r.stdout + r.stderr}`).toBe(7);
      expect(r.requests.length).toBeGreaterThan(0);
      expect(r.requests.map((q) => q.url).join(" ")).not.toMatch(/undefined|null|\/\//);
    }
  });

  it.each(["null", "{}", '{"items":{}}', '{"items":null}', "[]"])('--account "Ralf Fischer" resolved against %s: exit 7', async (body) => {
    sink.reply = reply(200, "application/json", body);
    const r = await sink.run(["profile", "me", "--json", "--account", "Ralf Fischer"], { xdg: dir });
    expect(r.status, r.stdout + r.stderr).toBe(7);
    expect(r.requests.map((q) => q.url).join(" ")).not.toMatch(/undefined/);
  });

  it("control: a readable lookup resolves and proceeds", async () => {
    sink.reply = reply(200, "application/json", '{"id":"ACoAAB1234","object":"list","items":[{"account_id":"acc_9","full_name":"Ralf Fischer"}],"cursor":null}');
    const r = await run(["post", "user-posts", "john-doe", "--json"]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.requests.some((q) => q.url.includes("/users/ACoAAB1234/"))).toBe(true);
    const acc = await sink.run(["profile", "me", "--json", "--account", "Ralf Fischer"], { xdg: dir });
    expect([acc.status, acc.requests.some((q) => q.url.startsWith("/v1/acc_9/"))]).toEqual([0, true]);
  });
});
