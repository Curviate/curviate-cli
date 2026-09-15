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

let dir: string;
let server: Server;
let baseUrl: string;
let reply: { status: number; type: string; body: string } = { status: 200, type: "text/html", body: "" };

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
    req.resume();
    req.on("end", () => {
      res.writeHead(reply.status, { "content-type": reply.type, "retry-after": "0" });
      res.end(reply.body);
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
