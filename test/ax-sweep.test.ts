/**
 * Agent-experience sweep (curviate#2041, before 0.48.0): a bad value is
 * refused before any request instead of silently becoming another request, a
 * usage error points at the command's own help, a write never invites the
 * resend that could repeat it, and `--json` is accepted where a wrapper puts
 * it. Every refusal row has a same-path control that sends.
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useSink, OK_PAGE, type Hit } from "./helpers/sink.js";
import { readManifest } from "./helpers/examples.js";

const sink = useSink();
const A = ["--account", "acc_1"];
const dir = mkdtempSync(join(tmpdir(), "curviate-ax-"));
const body = (h: Hit | undefined) => JSON.parse(h!.body) as Record<string, unknown>;

describe("a malformed value is refused before any request, never sent as another value", () => {
  it.each<[string, string[], RegExp]>([
    ["--limit abc (was limit=NaN)", ["core", "connect", "sent", ...A, "--limit", "abc"], /--limit must be a whole number, 1 or more/],
    ["--limit 5abc (was 5)", ["core", "connect", "sent", ...A, "--limit", "5abc"], /--limit must be a whole number/],
    ["--limit 1e2 (was 1)", ["core", "comment", "list", "urn:li:activity:1", ...A, "--limit", "1e2"], /--limit must be a whole number/],
    ["--limit 0", ["core", "connect", "sent", ...A, "--limit", "0"], /--limit must be a whole number/],
    ["--limit '' (was ignored)", ["core", "connect", "sent", ...A, "--limit", ""], /--limit must be a whole number/],
    ["--date-posted 7d (was null)", ["core", "search", "jobs", ...A, "--date-posted", "7d"], /--date-posted must be a whole number/],
    ["--network-distance first (was [])", ["core", "search", "people", ...A, "--network-distance", "first"], /--network-distance must be a whole number, from 1 to 3/],
    ["--network-distance 1,x (was [1])", ["core", "search", "people", ...A, "--network-distance", "1,x"], /--network-distance must be a whole number/],
    ["--proxy-port 80x (was 80)", ["account", "link", "--auth-method", "cookie", "--li-at", "x", "--user-agent", "ua", "--seat-id", "seat_1", "--proxy-host", "p.example", "--proxy-port", "80x"], /--proxy-port must be a whole number, from 1 to 65535/],
    ["--timeout 1e3 on a wait loop", ["account", "checkpoint", "poll", "acc_1", "--wait", "--timeout", "1e3"], /--timeout must be a whole number of milliseconds/],
    ["--api-key - (was sent as `Bearer -`)", ["account", "list", "--api-key", "-"], /--api-key - reads stdin only on `curviate login`/],
  ])("%s: exit 2, zero requests", async (_l, argv, message) => {
    const r = await sink.run(argv, { stdin: "cvt_from_stdin\n" });
    expect([r.status, r.requests.length, r.stderr]).toEqual([2, 0, expect.stringMatching(message)]);
  });

  it("controls: the well-formed value is sent as typed", async () => {
    const limit = await sink.run(["core", "connect", "sent", ...A, "--limit", "5"]);
    expect(limit.requests.map((h) => new URL(h.url, "http://x").searchParams.get("limit"))).toEqual(["5"]);
    const jobs = await sink.run(["core", "search", "jobs", ...A, "--date-posted", "7"]);
    expect(body(jobs.requests[0])["date_posted"]).toBe(7);
    const people = await sink.run(["core", "search", "people", ...A, "--network-distance", "1, 2"]);
    expect(body(people.requests[0])["network_distance"]).toEqual([1, 2]);
    const proxy = await sink.run(["account", "link", "--auth-method", "cookie", "--li-at", "x", "--user-agent", "ua", "--seat-id", "seat_1", "--proxy-host", "p.example", "--proxy-port", "8080"]);
    expect((body(proxy.requests.at(-1))["proxy"] as { port: number }).port).toBe(8080);
    const key = await sink.run(["account", "list", "--api-key", "cvt_flag_key"]);
    expect([key.status, key.requests[0]?.headers.authorization]).toEqual([0, "Bearer cvt_flag_key"]);
  });
});

describe("webhook verify --max-age-secs", () => {
  const secret = "whsec_ax";
  const payload = JSON.stringify({ id: "wdl_1", event: "message.received" });
  const file = join(dir, "payload.json");
  writeFileSync(file, payload);
  const header = (t: number) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;
  const verify = (t: number, maxAge?: string) =>
    sink.run(["webhook", "verify", "--secret", secret, "--header", header(t), "--file", file, ...(maxAge === undefined ? [] : ["--max-age-secs", maxAge])]);
  const stale = Math.floor(Date.now() / 1000) - 3600;

  it("a value that is not a whole number exits 2 instead of disabling the replay check", async () => {
    for (const v of ["abc", "", "10s", "0"]) {
      const r = await verify(stale, v);
      expect([r.status, r.stdout, r.stderr], v).toEqual([2, "", expect.stringMatching(/--max-age-secs must be a whole number/)]);
    }
  });

  it("controls: a window wide enough verifies the stale event, the default window rejects it as a replay", async () => {
    expect((await verify(stale, "7200")).status).toBe(0);
    const replay = await verify(stale);
    expect([replay.status, replay.stdout]).toEqual([2, expect.stringContaining('"replay_detected"')]);
  });
});

describe("a usage error points at the command's own help, by full path", () => {
  it.each<[string, string[], string]>([
    ["an unknown flag", ["core", "connect", "sent", "--bogus"], "Run `curviate core connect sent --help` for usage.\n"],
    ["a repeated flag", ["core", "connect", "sent", "--limit", "1", "--limit", "2", ...A], "Run `curviate core connect sent --help` for usage.\n"],
    ["a missing positional", ["core", "post", "get", ...A], "Run `curviate core post get --help` for usage.\n"],
    ["an unknown command keeps the generic root pointer (FR-003)", ["core", "inbx"], "Run `curviate --help` for usage.\n"],
  ])("%s", async (_l, argv, pointer) => {
    const r = await sink.run(argv);
    expect([r.status, r.requests.length]).toEqual([2, 0]);
    expect(r.stderr.endsWith(pointer), r.stderr).toBe(true);
  });
});

describe("an unreadable 5xx", () => {
  it("on a write: exit 7, never retry-likely, says it may have been applied; on a read: retry-likely (control)", async () => {
    sink.reply = { status: 502, type: "text/html", body: "<html>Bad Gateway</html>" };
    const write = await sink.run(["core", "post", "react", "urn:li:activity:1", "like", ...A, "--json"]);
    const read = await sink.run(["core", "connect", "sent", ...A, "--json"]);
    sink.reply = OK_PAGE;
    expect([write.status, write.requests.map((h) => h.method)]).toEqual([7, ["POST"]]);
    const w = (JSON.parse(write.stdout) as { error: { retryLikelyToSucceed: boolean; message: string } }).error;
    expect([w.retryLikelyToSucceed, w.message]).toEqual([false, expect.stringContaining("may have been applied")]);
    expect([read.status, (JSON.parse(read.stdout) as { error: { retryLikelyToSucceed: boolean } }).error.retryLikelyToSucceed]).toEqual([7, true]);
  });
});

describe("--json is accepted on every config command (a wrapper prepends it)", () => {
  it("config path --json prints JSON, plain stays a bare path; use and rename take the flag", async () => {
    const xdg = mkdtempSync(join(tmpdir(), "curviate-ax-xdg-"));
    const json = await sink.run(["config", "path", "--json"], { xdg });
    const plain = await sink.run(["config", "path"], { xdg });
    expect([json.status, JSON.parse(json.stdout)]).toEqual([0, { config_path: join(xdg, "curviate", "config.json") }]);
    expect(plain.stdout).toBe(`${join(xdg, "curviate", "config.json")}\n`);
    for (const argv of [["config", "use", "nope", "--json"], ["config", "rename", "nope", "other", "--json"]]) {
      const r = await sink.run(argv, { xdg });
      expect([r.status, r.stderr], argv.join(" ")).toEqual([2, expect.not.stringContaining("unknown flag")]);
    }
  });
});

describe("a hand-written group usage names every subcommand of the group", () => {
  it("each group that prints a Usage block lists all of its children", async () => {
    const manifest = readManifest();
    const groups = [...new Set(manifest.filter((c) => c.path.length > 1).map((c) => c.path.slice(0, -1).join(" ")))];
    const missing: string[] = [];
    let printed = 0;
    for (const g of groups) {
      const r = await sink.run([...g.split(" "), ...A]);
      const text = r.stdout + r.stderr;
      if (!/^Usage: /m.test(text)) continue;
      printed++;
      const words = new Set(text.match(/[a-z][a-z-]*/g));
      for (const c of manifest.filter((m) => m.path.slice(0, -1).join(" ") === g)) if (!words.has(c.path.at(-1)!)) missing.push(`${g}: ${c.path.at(-1)}`);
    }
    expect(printed).toBeGreaterThan(5);
    expect(missing).toEqual([]);
  });
});
