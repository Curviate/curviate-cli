/**
 * Exit classification of what comes back (or does not): a request that never
 * left the process (malformed base URL, credentials in the URL) is a refused
 * invocation, exit 2; no response, a 5xx with no readable error body, or a 2xx
 * that is not JSON is a platform fault, exit 7. A declared error envelope keeps
 * its table row.
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { configHome } from "./helpers/run-inproc.js";
import { pkgRoot } from "./helpers/pkg.js";
import { useSink, type Reply } from "./helpers/sink.js";

const sink = useSink();
const ME = ["core", "profile", "me", "--json", "--account", "acc_1"];
const LIST = ["account", "list", "--json"];
const envelope = (code: string, status: number, retry = false): Reply => ({ status, body: { code, message: "boom", user_fixable: false, retry_likely_to_succeed: retry } });
const both = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr;

describe("a malformed base URL is a refused invocation, exit 2", () => {
  it.each(["not a url", "http//x", "http://", "", "localhost:9", "ftp://x"])("%j: doctor still reports (exit 2, api_reachable false); a command names the base URL", async (bad) => {
    const doc = await sink.run(["doctor", "--json", "--base-url", bad]);
    expect(doc.status, both(doc)).toBe(2);
    expect(JSON.parse(doc.stdout.trim())).toMatchObject({ exit: 2, api_reachable: false });
    const cmd = await sink.run([...ME, "--base-url", bad]);
    expect(cmd.status, both(cmd)).toBe(2);
    expect(both(cmd)).toMatch(/base URL/i);
    expect(cmd.requests).toEqual([]);
  });

  it("control: a well-formed base URL passes on both", async () => {
    sink.reply = { body: { items: [], cursor: null, provider_id: "p" } };
    expect((await sink.run(["doctor", "--json"])).status).toBe(0);
    expect((await sink.run(ME)).status).toBe(0);
  });

  it("config set-base-url refuses a malformed URL before saving", async () => {
    const xdg = configHome();
    expect((await sink.run(["login", "--api-key", "cvt_test_x"], { xdg })).status).toBe(0);
    expect((await sink.run(["config", "set-base-url", "not a url"], { xdg })).status).toBe(2);
    expect((await sink.run(["config", "list", "--json"], { xdg })).stdout).not.toContain("not a url");
  });
});

describe("a base URL carrying credentials (userinfo) is refused before sending", () => {
  const urls = () => {
    const host = new URL(sink.url).host;
    return [`http://u:ZZPW42@${host}`, `http://ZZUSER42@${host}`, `http://:ZZPW42@${host}`];
  };
  const noEcho = (text: string) => {
    expect(text).not.toContain("ZZPW42");
    expect(text).not.toContain("ZZUSER42");
  };

  it("control: the same host without userinfo is sent to", async () => {
    sink.reply = { body: { provider_id: "p" } };
    const r = await sink.run(ME);
    expect([r.status, r.requests.length]).toEqual([0, 1]);
  });

  it("--base-url, CURVIATE_BASE_URL and doctor: exit 2, zero requests, never echoed", async () => {
    for (const url of urls()) {
      const flag = await sink.run([...ME, "--base-url", url]);
      expect(flag.status, both(flag)).toBe(2);
      expect(both(flag)).toMatch(/base URL/i);
      const doc = await sink.run(["doctor", "--json", "--base-url", url]);
      expect([doc.status, (JSON.parse(doc.stdout.trim()) as { exit: number }).exit]).toEqual([2, 2]);
      const env = await sink.run(LIST, { env: { CURVIATE_BASE_URL: url } });
      expect(env.status, both(env)).toBe(2);
      for (const r of [flag, doc, env]) {
        noEcho(both(r));
        expect(r.requests).toEqual([]);
      }
    }
  });

  it("login --base-url and config set-base-url refuse to save it; a hand-edited profile is refused by commands and not echoed by config list", async () => {
    const xdg = configHome();
    expect((await sink.run(["login", "--api-key", "cvt_test_x"], { xdg })).status).toBe(0);
    for (const url of urls()) {
      for (const args of [["login", "--api-key", "cvt_test_x", "--base-url", url], ["config", "set-base-url", url]]) {
        const r = await sink.run(args, { xdg });
        expect(r.status, both(r)).toBe(2);
        noEcho(both(r));
      }
    }
    const list = await sink.run(["config", "list", "--json"], { xdg });
    noEcho(list.stdout);
    expect(list.stdout).not.toContain("127.0.0.1");

    const edited = configHome();
    mkdirSync(join(edited, "curviate"), { recursive: true });
    writeFileSync(join(edited, "curviate", "config.json"), JSON.stringify({ active: "default", profiles: { default: { apiKey: "cvt_test_x", baseUrl: urls()[0] } } }));
    const r = await sink.run(LIST, { xdg: edited, env: { CURVIATE_BASE_URL: undefined } });
    expect(r.status, both(r)).toBe(2);
    noEcho(both(r));
    expect(r.requests).toEqual([]);
    const shown = await sink.run(["config", "list", "--json"], { xdg: edited });
    expect(shown.status).toBe(0);
    noEcho(both(shown));
    expect(shown.stdout).toContain(new URL(sink.url).host);
  });
});

describe("a response that is not an API answer", () => {
  it("an HTML 502 is a platform fault: exit 7 with PLATFORM_ERROR", async () => {
    sink.reply = { status: 502, type: "text/html", body: "<html>Bad Gateway</html>" };
    const r = await sink.run(ME);
    expect(r.status, both(r)).toBe(7);
    expect(r.stdout).toContain("PLATFORM_ERROR");
  });

  it("a declared INTERNAL envelope keeps exit 1, retry-likely or not", async () => {
    for (const reply of [envelope("INTERNAL", 500), envelope("INTERNAL", 503, true)]) {
      sink.reply = reply;
      expect((await sink.run(ME)).status).toBe(1);
    }
  });

  it.each([["application/json"], ["text/html"]])("a 200 %s body that is not JSON exits 7 on a command and in doctor", async (type) => {
    sink.reply = { type, body: "<html>portal</html>" };
    expect((await sink.run(LIST)).status).toBe(7);
    const doc = await sink.run(["doctor", "--json"]);
    expect([doc.status, (JSON.parse(doc.stdout.trim()) as { exit: number }).exit]).toEqual([7, 7]);
  });

  it("a 4xx with a non-JSON body is not reclassified", async () => {
    sink.reply = { status: 404, type: "text/plain", body: "nope" };
    expect((await sink.run(ME)).status).not.toBe(7);
  });

  it("no response at all (connection refused) is exit 7 on every command, including name resolution", async () => {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const dead = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    await new Promise<void>((r) => srv.close(() => r()));
    for (const args of [["doctor", "--json"], ME, LIST, ["webhook", "list", "--all", "--json"], ["core", "profile", "me", "--json", "--account", "Some Person"]]) {
      const r = await sink.run(args, { env: { CURVIATE_BASE_URL: dead } });
      expect(r.status, args.join(" ") + both(r)).toBe(7);
    }
  }, 60_000);

  it("every exit lookup passes the error, not only its code", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts") && /getExitCode\(\w+\.code\)/.test(readFileSync(p, "utf8"))) hits.push(p);
      }
    };
    walk(resolve(pkgRoot, "src"));
    expect(hits).toEqual([]);
  });
});
