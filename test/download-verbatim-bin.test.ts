/**
 * A download command saves any 2xx body verbatim, whatever its content type:
 * the server passes the stored file's own type through, so an HTML or a
 * JSON-labelled file is still the file, not a platform fault. Every other
 * command keeps "a 200 that is not an API answer exits 7". Through the built bin.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliPath } from "./helpers/built-cli.js";
import { SPAWN_TEST_TIMEOUT_MS } from "./helpers/spawn-budget.js";

let dir: string;
const paths: string[] = [];
let server: Server;
let baseUrl: string;
let reply: { status: number; type: string | null; body: string } = { status: 200, type: "text/html", body: "" };

function run(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: dir, NODE_ENV: "production" };
    delete env["CURVIATE_API_KEY"];
    delete env["CURVIATE_ACCOUNT"];
    delete env["CURVIATE_BASE_URL"];
    const child = spawn(process.execPath, [cliPath, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
    child.stdin.end("");
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "curviate-download-bin-"));
  server = createServer((req, res) => {
    paths.push(req.url ?? "");
    req.resume();
    req.on("end", () => {
      res.writeHead(reply.status, { ...(reply.type === null ? {} : { "content-type": reply.type }), "retry-after": "0" });
      res.end(reply.status === 204 ? undefined : reply.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const common = () => ["--api-key", "cvt_test_x", "--account", "acc_1", "--base-url", baseUrl];

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

describe("download commands save any 2xx body verbatim", () => {
  let n = 0;
  for (const [name, argv] of DOWNLOADS) {
    for (const [type, body] of BODIES) {
      it(`${name}: a 200 ${type} ${JSON.stringify(body.slice(0, 12))} is saved byte-identical, exit 0`, async () => {
        reply = { status: 200, type, body };
        const out = join(dir, `out-${n++}.bin`);
        const r = await run([...argv, "-o", out, ...common()]);
        expect(r.status, r.stdout + r.stderr).toBe(0);
        expect(existsSync(out), r.stderr).toBe(true);
        expect(readFileSync(out).equals(Buffer.from(body))).toBe(true);
      });
    }

    it(`${name}: an HTML 502 is still a platform fault, exit 7, no file`, async () => {
      reply = { status: 502, type: "text/html", body: "<html>Bad Gateway</html>" };
      const out = join(dir, `out-${n++}.bin`);
      const r = await run([...argv, "-o", out, ...common()]);
      expect(r.status, r.stdout + r.stderr).toBe(7);
      expect(existsSync(out)).toBe(false);
    });
  }

  it("control: a non-download command's 200 HTML still exits 7", async () => {
    reply = { status: 200, type: "text/html", body: "<html>portal</html>" };
    const r = await run(["profile", "me", "--json", ...common()]);
    expect(r.status, r.stdout + r.stderr).toBe(7);
    expect(r.stdout).toContain("PLATFORM_ERROR");
  });
});

describe("any other command: a 2xx with a non-empty body that is not JSON exits 7", () => {
  const UNREADABLE: Array<[string | null, string]> = [
    ["text/plain", "hello"],
    ["application/octet-stream", "hello"],
    [null, "hello"],
    ["text/html", "<html>portal</html>"],
    ["application/json", "<html>portal</html>"],
    ["application/json", " "],
  ];
  for (const [type, body] of UNREADABLE) {
    for (const argv of [["post", "get", "p1"], ["post", "delete", "p1"], ["account", "list"]]) {
      it(`${argv.join(" ")}: a 200 ${type ?? "(no content type)"} ${JSON.stringify(body)} exits 7`, async () => {
        reply = { status: 200, type, body };
        const r = await run([...argv, "--json", ...common()]);
        expect(r.status, r.stdout + r.stderr).toBe(7);
        expect(r.stdout).toContain("PLATFORM_ERROR");
      });
    }
  }

  const READABLE: Array<[number, string | null, string]> = [
    [204, null, ""],
    [200, null, ""],
    [200, "application/json", ""],
    [200, "text/plain", ""],
    [200, "application/json", "{}"],
    [201, "application/json; charset=utf-8", '{"ok":true}'],
  ];
  for (const [status, type, body] of READABLE) {
    it(`post delete: a ${status} ${type ?? "(no content type)"} ${JSON.stringify(body)} exits 0`, async () => {
      reply = { status, type, body };
      const r = await run(["post", "delete", "p1", "--json", ...common()]);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).not.toContain("PLATFORM_ERROR");
    });
  }
});

describe("a 2xx that is not a list page", () => {
  const NOT_A_PAGE: Array<[number, string | null, string]> = [
    [200, "application/json", "null"],
    [200, "application/json", ""],
    [204, null, ""],
    [200, "application/json", "[]"],
    [200, "application/json", "5"],
    [200, "application/json", '"x"'],
    [200, "application/json", "{}"],
    [200, "application/json", '{"items":null,"cursor":null}'],
    [200, "application/json", '{"items":"x","cursor":null}'],
    [200, "application/json", '{"items":{},"cursor":null}'],
    [200, "application/json", '{"items":null,"data":[],"cursor":null}'],
  ];
  const ALL: string[][] = [
    ["account", "list", "--all"],
    ["webhook", "list", "--all"],
    ["connect", "sent", "--all"],
    ["inbox", "list", "--all"],
    ["job", "list", "--state", "OPEN", "--all"],
    ["job", "list", "--state", "ALL", "--all"],
    ["job", "list", "--state", "OPEN"],
    ["job", "list", "--state", "ALL"],
  ];

  for (const [status, type, body] of NOT_A_PAGE) {
    const label = `${status} ${JSON.stringify(body)}`;
    it(`doctor on a ${label}: not verified, exit 7`, async () => {
      reply = { status, type, body };
      const r = await run(["doctor", "--json", "--api-key", "cvt_test_x", "--base-url", baseUrl]);
      expect(r.status, r.stdout + r.stderr).toBe(7);
      const report = JSON.parse(r.stdout.trim()) as { credential_valid: boolean; api_reachable: boolean; exit: number };
      expect(report.credential_valid).toBe(false);
      expect(report.api_reachable).toBe(true);
      const credential = (report as unknown as { checks: Array<{ name: string; detail: string }> }).checks.find((c) => c.name === "credential valid");
      expect(credential?.detail).toMatch(/not verified/);
      expect(report.exit).toBe(7);
    });

    for (const argv of ALL) {
      it(`${argv.join(" ")} on a ${label}: exit 7, no crash`, async () => {
        reply = { status, type, body };
        const r = await run([...argv, "--json", ...common()]);
        expect(r.status, r.stdout + r.stderr).toBe(7);
        expect(r.stdout + r.stderr).not.toMatch(/Internal error|Cannot read|is not a function|requires a paginated method/);
        expect(r.stdout).toContain("PLATFORM_ERROR");
      });
    }
  }

  it("control: a page carried as data (the Recruiter lists) streams", async () => {
    reply = { status: 200, type: "application/json", body: JSON.stringify({ object: "list", data: [{ id: "proj_1" }], cursor: null }) };
    const r = await run(["recruiter", "projects", "--all", "--json", "--page-delay", "0", "--beta", ...common()]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("proj_1");
  });

  it("control: a real empty page is verified and streams", async () => {
    reply = { status: 200, type: "application/json", body: JSON.stringify({ object: "list", items: [], cursor: null }) };
    const doc = await run(["doctor", "--json", "--api-key", "cvt_test_x", "--base-url", baseUrl]);
    expect(doc.status, doc.stdout + doc.stderr).toBe(0);
    expect((JSON.parse(doc.stdout.trim()) as { credential_valid: boolean }).credential_valid).toBe(true);
    for (const argv of ALL) {
      const r = await run([...argv, "--json", ...common()]);
      expect(r.status, `${argv.join(" ")}: ${r.stdout + r.stderr}`).toBe(0);
    }
    // 9 real bin spawns in one body (~4.3s measured) leave ~14% headroom
    // under vitest's 5s default — a flake by construction under load. See
    // spawn-budget.ts: this body has no single call anywhere near its own
    // budget, but the file's `run()` here spawns async with no explicit
    // per-call timeout, so SPAWN_TEST_TIMEOUT_MS is used directly as a
    // generous ceiling rather than a per-spawn multiple.
  }, SPAWN_TEST_TIMEOUT_MS);
});

describe("a name or slug lookup whose answer is unreadable", () => {
  const ENTITY_BODIES = ["null", "{}", '{"items":{}}', "[]", '{"id":null}', '{"id":""}'];
  const SLUG: string[][] = [
    ["company", "posts", "acme"],
    ["company", "employees", "acme"],
    ["post", "user-posts", "john-doe"],
    ["comment", "user", "john-doe"],
    ["profile", "john-doe", "--sections", "skills"],
    ["profile", "someco", "--posts", "--is-company"],
    ["profile", "endorse", "john-doe", "--endorsement-id", "e1"],
    ["profile", "follow", "john-doe"],
    ["message", "new", "--to", "john-doe", "hello"],
    ["message", "inmail", "--to", "john-doe", "--subject", "Hi", "hello"],
  ];
  for (const body of ENTITY_BODIES) {
    for (const argv of SLUG) {
      it(`${argv.join(" ")} on ${body}: exit 7, no request path carries undefined`, async () => {
        reply = { status: 200, type: "application/json", body };
        paths.length = 0;
        const r = await run([...argv, "--json", ...common()]);
        expect(r.status, r.stdout + r.stderr).toBe(7);
        expect(paths.length).toBeGreaterThan(0);
        expect(paths.join(" ")).not.toMatch(/undefined|null|\/\//);
      });
    }
  }

  for (const body of ["null", "{}", '{"items":{}}', '{"items":null}', "[]"]) {
    it(`--account "Ralf Fischer" resolved against ${body}: exit 7`, async () => {
      reply = { status: 200, type: "application/json", body };
      paths.length = 0;
      const r = await run(["profile", "me", "--json", "--api-key", "cvt_test_x", "--account", "Ralf Fischer", "--base-url", baseUrl]);
      expect(r.status, r.stdout + r.stderr).toBe(7);
      expect(paths.join(" ")).not.toMatch(/undefined/);
    });
  }

  it("control: a readable lookup resolves and proceeds", async () => {
    reply = { status: 200, type: "application/json", body: '{"id":"ACoAAB1234","object":"list","items":[{"account_id":"acc_9","full_name":"Ralf Fischer"}],"cursor":null}' };
    paths.length = 0;
    const r = await run(["post", "user-posts", "john-doe", "--json", ...common()]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(paths.some((p) => p.includes("/users/ACoAAB1234/"))).toBe(true);
    const acc = await run(["profile", "me", "--json", "--api-key", "cvt_test_x", "--account", "Ralf Fischer", "--base-url", baseUrl]);
    expect(acc.status, acc.stdout + acc.stderr).toBe(0);
    expect(paths.some((p) => p.startsWith("/v1/acc_9/"))).toBe(true);
  });
});
