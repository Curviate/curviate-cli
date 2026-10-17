/**
 * `account link` / `account update` / `account seats` through the CLI entry
 * point against a recording sink: seat resolution, the connection-location
 * rules (refused before any request, each next to a control that does send),
 * and the exit codes of the API's location refusals.
 */
import { describe, it, expect } from "vitest";
import { renderUsage, type CommandDef } from "citty";
import { accountCommand } from "../src/commands/account.js";
import { useSink, line, type Hit, type Reply } from "./helpers/sink.js";

const RETURNED = { country: "US", current_country: "US", mode: "auto", strict: true };
const TAKEN = { seat_id: "seat_taken", occupied: true, account_id: "acc_old" };
const FREE = (id: string) => ({ seat_id: id, occupied: false, account_id: null });
const CHECKPOINT: Reply = { status: 202, body: { object: "account", status: "checkpoint_required", account_id: "acc_new", checkpoint: { type: "OTP" } } };
const CONNECTED: Reply = { status: 201, body: { object: "account", account_id: "acc_new", status: "active", connection_location: RETURNED } };
const API_ERR = (status: number, code: string, message: string, extra: object = {}): Reply => ({
  status,
  body: { code, message, user_fixable: true, retry_likely_to_succeed: false, ...extra },
});

let seats: unknown[] = [TAKEN, FREE("seat_free")];
let intent: Reply = CHECKPOINT;
let patch: Reply = { body: { object: "account", account_id: "acc_1", status: "active", connection_location: RETURNED } };
const sink = useSink((h: Hit) => {
  if (h.url.startsWith("/v1/accounts/seats")) return { body: { object: "seat_list", items: seats } };
  return h.method === "PATCH" ? patch : intent;
});
const body = (r: { requests: Hit[] }, pred: (h: Hit) => boolean, what: string) => {
  const q = r.requests.filter(pred);
  expect(q, what).toHaveLength(1);
  return JSON.parse(q[0]!.body) as Record<string, unknown>;
};
const intentBody = (r: { requests: Hit[] }) => body(r, (h) => h.url.startsWith("/v1/auth/intent"), "exactly one connect request");
const patchBody = (r: { requests: Hit[] }) => body(r, (h) => h.method === "PATCH", "exactly one PATCH");
const reset = () => {
  seats = [TAKEN, FREE("seat_free")];
  intent = CHECKPOINT;
};

const AUTH = ["account", "link", "--auth-method", "cookie", "--li-at", "li_at_value", "--user-agent", "UA/1"];
const LINK = [...AUTH, "--seat-id", "seat_1", "--json"];
const RECONNECT = [...LINK, "--account-id", "acc_1"];
const PROXY = ["--proxy-host", "proxy.example.com", "--proxy-port", "1080"];

describe("account link without --seat-id", () => {
  const noSeat = [...AUTH, "--country", "US", "--json"];

  it("reads the seats, connects into the only free one, and reaches the checkpoint (exit 12)", async () => {
    reset();
    const r = await sink.run(noSeat);
    expect(r.status, r.stderr).toBe(12);
    expect(r.requests.map(line)).toEqual(["GET /v1/accounts/seats", "POST /v1/auth/intent"]);
    expect(intentBody(r)).toMatchObject({ seat_id: "seat_free" });
    expect(r.stdout).toContain("acc_new");
  });

  it("zero or several free seats: exit 2, the fix or both candidates named, nothing connected", async () => {
    seats = [TAKEN];
    const none = await sink.run(noSeat);
    expect(none.status).toBe(2);
    expect(none.stderr).toContain("curviate account seats");
    seats = [FREE("seat_a"), FREE("seat_b")];
    const many = await sink.run(noSeat);
    expect(many.status).toBe(2);
    expect(many.stderr).toMatch(/seat_a[\s\S]*seat_b/);
    for (const r of [none, many]) expect(r.requests.map((q) => q.url.split("?")[0])).toEqual(["/v1/accounts/seats"]);
  });

  it("a seat taken in between surfaces the server's refusal; an explicit --seat-id costs no seats read", async () => {
    reset();
    intent = API_ERR(409, "SEAT_NOT_EMPTY", "That seat is not empty.");
    const raced = await sink.run(noSeat);
    expect([0, 12]).not.toContain(raced.status);
    expect(raced.stdout + raced.stderr).toContain("SEAT_NOT_EMPTY");
    intent = CHECKPOINT;
    const explicit = await sink.run([...noSeat, "--seat-id", "seat_explicit"]);
    expect(explicit.status).toBe(12);
    expect(explicit.requests.map((q) => q.url.split("?")[0])).toEqual(["/v1/auth/intent"]);
    expect(intentBody(explicit)).toMatchObject({ seat_id: "seat_explicit" });
  });

  it("--seat-id is optional and --auth-method is not: the missing-argument hint is the flag's own", async () => {
    const bare = await sink.run(["account", "link"]);
    expect(bare.status).toBe(2);
    expect(bare.stderr).toContain("Missing required argument: --auth-method");
    expect(bare.stderr).not.toMatch(/Missing required argument.*--seat-id/);
    const withSeat = await sink.run(["account", "link", "--seat-id", "seat_1"]);
    expect(withSeat.stderr).toContain("credentials | cookie");
    expect(withSeat.stderr).not.toContain("account seats");
    const link = ((await accountCommand.subCommands) as Record<string, CommandDef>)["link"]!;
    const help = await renderUsage(link);
    expect(help).toMatch(/--seat-id[\s\S]*curviate account seats/);
    expect(help).not.toMatch(/--seat-id[^\n]*\(required\)/);
    expect(help).toMatch(/--auth-method[^.]*exits 12/);
  });
});

describe("account link: a new connect names exactly one location", () => {
  it("no location is refused with no request; the same call with --country connects", async () => {
    reset();
    const refused = await sink.run(LINK);
    expect(refused.status).toBe(2);
    for (const flag of ["--country", "--ip", "--proxy-host"]) expect(refused.stderr).toContain(flag);
    expect(refused.requests).toEqual([]);
    const noSeatToo = await sink.run(LINK.filter((a, i) => a !== "--seat-id" && LINK[i - 1] !== "--seat-id"));
    expect([noSeatToo.status, noSeatToo.requests]).toEqual([2, []]);
    const control = await sink.run([...LINK, "--country", "US"]);
    expect(control.status, control.stderr).toBe(12);
    expect(intentBody(control)).toMatchObject({ country: "US" });
  });

  it.each([
    ["new", LINK, ["--country", "US", "--ip", "8.8.8.8"]],
    ["new", LINK, ["--country", "US", ...PROXY]],
    ["new", LINK, ["--ip", "8.8.8.8", ...PROXY]],
    ["reconnect", RECONNECT, ["--country", "US", "--ip", "8.8.8.8"]],
  ])("%s with two location sources: exit 2, no request", async (_k, base, extra) => {
    const r = await sink.run([...base, ...extra]);
    expect([r.status, r.requests]).toEqual([2, []]);
    expect(r.stderr).toMatch(/one location source/);
  });

  it("--country is upper-cased; a malformed one, and an empty --ip / --proxy-host, are refused before the request", async () => {
    reset();
    expect(intentBody(await sink.run([...LINK, "--country", "de"]))["country"]).toBe("DE");
    for (const bad of ["USA", "1", "", " "]) {
      const r = await sink.run([...LINK, "--country", bad]);
      expect([r.status, r.requests], JSON.stringify(bad)).toEqual([2, []]);
      expect(r.stderr).toContain("--country");
    }
    for (const extra of [["--ip", ""], ["--proxy-host", ""], ["--ip", " "]]) {
      const r = await sink.run([...LINK, ...extra]);
      expect([r.status, r.requests], extra.join(" ")).toEqual([2, []]);
      expect(r.stderr).toContain("empty value");
    }
  });

  it("a well-formed code the API does not serve is sent, and its 400 exits 2", async () => {
    intent = API_ERR(400, "INVALID_REQUEST", "country: unsupported. Use `proxy` for a location we don't serve.");
    const r = await sink.run([...LINK, "--country", "xx"]);
    expect(r.status).toBe(2);
    expect(intentBody(r)["country"]).toBe("XX");
    expect(r.stdout + r.stderr).toContain("INVALID_REQUEST");
  });

  it("--ip and --proxy-host are each a location on their own", async () => {
    intent = CONNECTED;
    const ip = intentBody(await sink.run([...LINK, "--ip", " 8.8.8.8\n"]));
    expect(ip).toMatchObject({ ip: "8.8.8.8" });
    expect(ip).not.toHaveProperty("country");
    const proxy = intentBody(await sink.run([...LINK, ...PROXY, "--proxy-protocol", "socks4"]));
    expect(proxy["proxy"]).toEqual({ protocol: "socks4", host: "proxy.example.com", port: 1080 });
    expect(proxy).not.toHaveProperty("allow_country_fallback");
  });

  it("--allow-country-fallback: sent true/false with --country, omitted unset; refused with a proxy and on a reconnect with no country/ip", async () => {
    intent = CONNECTED;
    expect(intentBody(await sink.run([...LINK, "--country", "US", "--allow-country-fallback"]))["allow_country_fallback"]).toBe(true);
    expect(intentBody(await sink.run([...LINK, "--country", "US", "--no-allow-country-fallback"]))["allow_country_fallback"]).toBe(false);
    expect(intentBody(await sink.run([...LINK, "--country", "US"]))).not.toHaveProperty("allow_country_fallback");
    for (const args of [[...LINK, ...PROXY, "--allow-country-fallback"], [...RECONNECT, "--allow-country-fallback"]]) {
      const r = await sink.run(args);
      expect([r.status, r.requests]).toEqual([2, []]);
      expect(r.stderr).toContain("--allow-country-fallback");
    }
    const ok = await sink.run([...RECONNECT, "--country", "NL", "--allow-country-fallback"]);
    expect(intentBody(ok)).toMatchObject({ account_id: "acc_1", country: "NL", allow_country_fallback: true });
  });

  it("a reconnect that names no location sends none", async () => {
    intent = { body: { object: "account", account_id: "acc_1", status: "active" } };
    const body = intentBody(await sink.run(RECONNECT));
    expect(body).toMatchObject({ account_id: "acc_1" });
    for (const k of ["country", "ip", "proxy", "allow_country_fallback"]) expect(body).not.toHaveProperty(k);
  });

  it("--preview applies the same rules and renders the normalised country", async () => {
    const refused = await sink.run([...LINK, "--preview"]);
    expect([refused.status, refused.stdout, refused.requests]).toEqual([2, "", []]);
    const r = await sink.run([...LINK, "--preview", "--country", "de", "--allow-country-fallback"]);
    expect([r.status, r.requests]).toEqual([0, []]);
    expect((JSON.parse(r.stdout) as { body: unknown }).body).toMatchObject({ country: "DE", allow_country_fallback: true });
  });
});

describe("account link --account-id blank", () => {
  it("empty and whitespace exit 2 with no request; a real id reconnects", async () => {
    reset();
    const link = [...LINK, "--country", "US"];
    for (const v of ["", "  "]) {
      const r = await sink.run([...link, "--account-id", v]);
      expect([r.status, r.requests]).toEqual([2, []]);
      expect(r.stderr).toContain("--account-id was given an empty value");
    }
    const ok = await sink.run([...link, "--account-id", "acc_old"]);
    expect(ok.status, ok.stderr).toBe(12);
    expect(ok.requests.map(line)).toEqual(["POST /v1/auth/intent"]);
    expect(intentBody(ok)).toMatchObject({ account_id: "acc_old" });
  });
});

describe("account update: --country moves the account and prints where it connects from", () => {
  it("sends the upper-cased country and prints the API's connection_location", async () => {
    const r = await sink.run(["account", "update", "acc_1", "--country", "US"]);
    expect(r.status, r.stderr).toBe(0);
    expect(patchBody(r)).toEqual({ country: "US" });
    expect((JSON.parse(r.stdout) as { connection_location: unknown }).connection_location).toEqual(RETURNED);
    expect(patchBody(await sink.run(["account", "update", "acc_1", "--country", "us", "--json"]))).toEqual({ country: "US" });
  });

  it("--allow-country-fallback alone changes strictness; --clear-proxy needs --country", async () => {
    expect(patchBody(await sink.run(["account", "update", "acc_1", "--allow-country-fallback", "--json"]))).toEqual({ allow_country_fallback: true });
    const refused = await sink.run(["account", "update", "acc_1", "--clear-proxy"]);
    expect([refused.status, refused.requests]).toEqual([2, []]);
    expect(refused.stderr).toContain("--country");
    expect(patchBody(await sink.run(["account", "update", "acc_1", "--clear-proxy", "--country", "DE", "--json"]))).toEqual({ proxy: null, country: "DE" });
  });

  it.each([
    [["--country", "US", ...PROXY]],
    [[...PROXY, "--allow-country-fallback"]],
    [["--country", "Germany"]],
  ])("%j is refused before the request", async (extra) => {
    const r = await sink.run(["account", "update", "acc_1", ...extra]);
    expect([r.status, r.requests]).toEqual([2, []]);
  });
});

describe("location refusals from the API", () => {
  it("CONNECTION_LOCATION_UNAVAILABLE exits 8 and --json carries the actual location", async () => {
    const actual = { country: "DE", current_country: "DE", mode: "auto", strict: true };
    patch = API_ERR(422, "CONNECTION_LOCATION_UNAVAILABLE", "No connection is available in United States right now.", { connection_location: actual });
    const r = await sink.run(["account", "update", "acc_1", "--country", "US", "--json"]);
    expect(r.status).toBe(8);
    const err = (JSON.parse(r.stdout) as { error: { code: string; connectionLocation?: unknown } }).error;
    expect([err.code, err.connectionLocation]).toEqual(["CONNECTION_LOCATION_UNAVAILABLE", actual]);
  });

  it("CONNECTION_LOCATION_REQUIRED (a reconnect whose location is unknown) exits 2 and sends no country", async () => {
    intent = API_ERR(400, "CONNECTION_LOCATION_REQUIRED", "Choose where this account connects from.");
    const r = await sink.run(RECONNECT);
    expect(r.status).toBe(2);
    expect(intentBody(r)).not.toHaveProperty("country");
    expect(r.stdout).toContain("CONNECTION_LOCATION_REQUIRED");
  });
});

describe("account seats", () => {
  const ITEMS = [FREE("seat_free"), { seat_id: "seat_bound", occupied: true, account_id: "acc_1" }];
  const seatsRun = (extra: string[] = []) => sink.run(["account", "seats", "--json", ...extra]);

  it("GETs /v1/accounts/seats with the key and prints the raw envelope", async () => {
    sink.reply = { body: { object: "seat_list", items: ITEMS } };
    const r = await seatsRun();
    expect(r.status, r.stderr).toBe(0);
    expect(r.requests.map((q) => [q.method, q.url, q.headers.authorization])).toEqual([["GET", "/v1/accounts/seats", "Bearer cvt_test_sink"]]);
    expect(JSON.parse(r.stdout.trim())).toEqual({ object: "seat_list", items: ITEMS });
    expect(r.stderr).not.toMatch(/billing needs attention/);
  });

  it("an empty list exits 0 and the note names billing", async () => {
    sink.reply = { body: { object: "seat_list", items: [] } };
    const r = await seatsRun();
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ object: "seat_list", items: [] });
    expect(r.stderr).toMatch(/billing needs attention/);
  });

  it("401 exits 3; a 200 with no items array exits 7 (PLATFORM_ERROR); --all is an unknown flag, exit 2, nothing sent", async () => {
    sink.reply = API_ERR(401, "UNAUTHORIZED", "bad key");
    expect((await seatsRun()).status).toBe(3);
    sink.reply = { body: { object: "seat_list" } };
    const bad = await seatsRun();
    expect(bad.status).toBe(7);
    expect(bad.stdout).toContain("PLATFORM_ERROR");
    sink.reply = { body: { object: "seat_list", items: [] } };
    const all = await seatsRun(["--all"]);
    expect([all.status, all.requests]).toEqual([2, []]);
  });
});
