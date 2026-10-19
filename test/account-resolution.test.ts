/**
 * `--account` / `CURVIATE_ACCOUNT` / the profile account, through the CLI entry
 * point against a recording sink. Assertions are on the requests that reached
 * the wire: an empty set is only evidence next to a control that does send.
 * `--account` is a path segment, so path-unsafe values must never be sent.
 */
import { describe, it, expect } from "vitest";
import { STDIN_SENTINEL } from "../src/lib/stdin.js";
import { configHome } from "./helpers/run-inproc.js";
import { useSink, line, type Hit } from "./helpers/sink.js";

const RALF = { account_id: "acc_01RALF", full_name: "Ralf Fischer", status: "active" };
const RALB = { account_id: "acc_01RALB", full_name: "Ralf Fisher", status: "active" };
const SOPH = { account_id: "acc_01SOPH", full_name: "Sophie Ahmed", status: "active" };
const ONLY = { account_id: "acc_01ONLY", full_name: "Only One", status: "OK" };

let connected: unknown[] = [RALF, RALB, SOPH];
let paging: "single" | "twoPages" | "endless" = "single";
const sink = useSink((h) => {
  if (!h.url.startsWith("/v1/accounts")) return { body: { object: "chat", unread_count: 0 } };
  const first = !h.url.includes("cursor=");
  if (paging === "endless") return { body: { items: first ? connected : [], cursor: "next" } };
  if (paging === "twoPages" && first) return { body: { items: [{ account_id: "acc_01PAGE1", full_name: "Page One" }], cursor: "next" } };
  return { body: { object: "account_list", items: connected, cursor: null } };
});
const markRead = (account?: string, ...more: string[]) =>
  sink.run(["core", "inbox", "mark-read", "chat_1", ...(account === undefined ? [] : ["--account", account]), "--json", ...more]);
const nonLookup = (r: { requests: Hit[] }) => r.requests.filter((q) => !q.url.startsWith("/v1/accounts"));
const codeOf = (s: string) => /\[([A-Z_]+)\]/.exec(s)?.[1] ?? "";
const reset = () => {
  connected = [RALF, RALB, SOPH];
  paging = "single";
};

describe("a path-unsafe --account never reaches the wire", () => {
  it.each([
    "x/../../../v1/accounts", "x/../../billing/seats", "a?x=1", "a#x", "a/b", "a\\b", "%2e%2e", "%2E%2e", "a%b", "..",
    "x/..%2fy", "acc\t1", "acc\n1", "acc\r1", "acc 1",
  ])("%j: exit 2, no request at all", async (value) => {
    reset();
    const r = await markRead(value);
    expect(r.requests).toEqual([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--account");
  });

  it("names the flag and what the value would have done", async () => {
    expect((await markRead("x/../../../v1/accounts")).stderr).toMatch(/redirect the request/i);
  });

  it("the same guard holds for CURVIATE_ACCOUNT and for a read", async () => {
    const env = await sink.run(["core", "inbox", "mark-read", "chat_1", "--json"], { env: { CURVIATE_ACCOUNT: "x/../../../v1/accounts" } });
    expect([env.status, env.requests]).toEqual([2, []]);
    const read = await sink.run(["core", "inbox", "list", "--account", "x/../../../v1/accounts", "--json"]);
    expect([read.status, read.requests]).toEqual([2, []]);
  });

  it("a space-bearing value is resolved or refused, never interpolated", async () => {
    reset();
    for (const v of ["acc 1", "acc_01SOPH x"]) {
      const r = await markRead(v);
      expect(r.status).not.toBe(0);
      expect(r.requests.filter((q) => q.method !== "GET")).toEqual([]);
      expect(r.requests.map((q) => q.url).join(" ")).not.toMatch(/acc 1|acc%201|acc1|acc_01SOPH%20x/);
    }
  });

  it("the stdin placeholder is refused before the lookup, in the env and embedded in a selector", async () => {
    const env = await sink.run(["core", "inbox", "mark-read", "chat_1", "--json"], { env: { CURVIATE_ACCOUNT: STDIN_SENTINEL } });
    expect(env.requests).toEqual([]);
    expect(env.stderr.toLowerCase()).toMatch(/stdin/);
    const embedded = await markRead(`Ralf ${STDIN_SENTINEL}`);
    expect(embedded.requests).toEqual([]);
    expect(embedded.status).not.toBe(0);
    expect(JSON.stringify((await markRead(STDIN_SENTINEL)).requests)).not.toContain(STDIN_SENTINEL);
  });
});

describe("an id is used as is; a name is resolved", () => {
  it("an id sends exactly one request, in the path, even one the list does not hold", async () => {
    reset();
    for (const id of ["acc_01SOPH", "acc_01NOTLISTED"]) {
      const r = await markRead(id);
      expect(r.requests.map((q) => `${q.method} ${q.url}`)).toEqual([`PATCH /v1/${id}/chats/chat_1`]);
    }
  });

  it.each([
    ["Sophie Ahmed", "acc_01SOPH"],
    ["Sophie", "acc_01SOPH"],
    ["sophie ahmed", "acc_01SOPH"],
    ["Ralf Fisher", "acc_01RALB"], // exact name beats the longer name it prefixes
  ])("%j -> %s, and the name never appears on the wire", async (name, id) => {
    reset();
    const r = await markRead(name);
    expect(r.status, r.stderr).toBe(0);
    expect(r.requests.map((q) => q.url)).toContain(`/v1/${id}/chats/chat_1`);
    expect(r.requests.map((q) => q.url).join(" ")).not.toMatch(/Sophie|Ahmed|Fisher|%20/i);
  });

  it("an ambiguous or unknown name writes nothing, with distinct codes, and lists the candidates", async () => {
    reset();
    const amb = await markRead("Ralf");
    const none = await markRead("Nobody At All");
    for (const r of [amb, none]) {
      expect(r.status).not.toBe(0);
      expect(nonLookup(r)).toEqual([]);
    }
    expect(amb.stderr + amb.stdout).toContain("ACCOUNT_AMBIGUOUS");
    for (const s of ["acc_01RALF", "acc_01RALB", "Ralf Fischer", "Ralf Fisher"]) expect(amb.stderr + amb.stdout).toContain(s);
    expect(none.stderr.toLowerCase()).toMatch(/no connected account|matched no/);
    expect(none.stderr + none.stdout).toContain("Sophie Ahmed");
    expect(codeOf(amb.stderr)).not.toBe("");
    expect(codeOf(none.stderr)).not.toBe("");
    expect(codeOf(amb.stderr)).not.toBe(codeOf(none.stderr));
  });

  it("an incomplete list refuses (even a name that looks unique on the pages read); a list that really ends resolves", async () => {
    reset();
    paging = "endless";
    for (const name of ["Sophie Ahmed", "Sophie"]) {
      const r = await markRead(name);
      expect(r.requests.filter((q) => q.url.startsWith("/v1/accounts")).length).toBeGreaterThan(1);
      expect(nonLookup(r)).toEqual([]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("ACCOUNT_LIST_TRUNCATED");
      expect(r.stderr.toLowerCase()).toContain("account id");
    }
    paging = "twoPages";
    const ok = await markRead("Sophie Ahmed");
    expect(ok.status).toBe(0);
    expect(ok.requests.filter((q) => q.url.startsWith("/v1/accounts"))).toHaveLength(2);
    expect(ok.requests.map((q) => q.url)).toContain("/v1/acc_01SOPH/chats/chat_1");
  });

  it("--preview echoes the selector and calls nothing; a redirecting value is still refused", async () => {
    reset();
    const p = await sink.run(["core", "inbox", "mark-read", "chat_1", "--account", "Sophie Ahmed", "--preview", "--json"]);
    expect([p.status, p.requests]).toEqual([0, []]);
    const preview = JSON.parse(p.stdout.trim()) as Record<string, unknown>;
    expect([preview["method"], preview["account"]]).toEqual(["messaging.markChatRead", "Sophie Ahmed"]);
    expect(p.stderr).toMatch(/resolve/i);
    const ambiguous = await sink.run(["core", "connect", "some-slug", "--account", "Ralf", "--preview"]);
    expect([ambiguous.status, ambiguous.requests]).toEqual([0, []]);
    const id = await sink.run(["core", "inbox", "mark-read", "chat_1", "--account", "acc_01SOPH", "--preview", "--json"]);
    expect([id.status, id.requests, id.stderr.trim()]).toEqual([0, [], ""]);
    const bad = await sink.run(["core", "inbox", "mark-read", "chat_1", "--account", "x/../../../v1/accounts", "--preview", "--json"]);
    expect([bad.status, bad.requests, bad.stdout.trim()]).toEqual([2, [], ""]);
  });
});

describe("no account given: auto-resolve the only connected one", () => {
  it("one connected: a lookup, then the call under that id (write and read)", async () => {
    connected = [ONLY];
    paging = "single";
    const w = await markRead();
    expect(w.status, w.stderr).toBe(0);
    expect(w.requests.map(line)).toEqual(["GET /v1/accounts", "PATCH /v1/acc_01ONLY/chats/chat_1"]);
    const rd = await sink.run(["core", "profile", "me", "--json"]);
    expect(rd.requests.map((q) => q.url.split("?")[0])).toEqual(["/v1/accounts", "/v1/acc_01ONLY/users/me"]);
  });

  it("zero, several, truncated, or an unreadable row: exit 2, nothing written", async () => {
    const cases: Array<[unknown[], typeof paging, string]> = [
      [[], "single", "no LinkedIn account is connected to this workspace yet"],
      [[RALF, SOPH], "single", "acc_01SOPH"],
      [[ONLY], "endless", "ACCOUNT_LIST_TRUNCATED"],
      [[ONLY, { full_name: "No Id" }], "single", "ACCOUNT_LIST_TRUNCATED"],
      [[ONLY, { account_id: "", full_name: "Blank" }], "single", "ACCOUNT_LIST_TRUNCATED"],
      [[ONLY, { account_id: 42, full_name: "Number" }], "single", "ACCOUNT_LIST_TRUNCATED"],
    ];
    for (const [list, mode, text] of cases) {
      connected = list;
      paging = mode;
      const r = await markRead();
      expect([r.status, nonLookup(r)], text).toEqual([2, []]);
      expect(r.stderr).toContain(text);
    }
    connected = [ONLY, { full_name: "No Id" }];
    paging = "single";
    const named = await markRead("Only One");
    expect([named.status, nonLookup(named)]).toEqual([2, []]);
  });

  it("--preview issues no lookup, so it still needs --account", async () => {
    connected = [ONLY];
    const r = await sink.run(["core", "inbox", "mark-read", "chat_1", "--json", "--preview"]);
    expect([r.status, r.requests]).toEqual([2, []]);
  });

  it("an empty or blank account is never an omitted one, and does not auto-pick over a profile account", async () => {
    connected = [ONLY];
    for (const opts of [{}, { env: { CURVIATE_ACCOUNT: "" } }, { env: { CURVIATE_ACCOUNT: "  " } }]) {
      const args = Object.keys(opts).length ? [] : ["--account", ""];
      const r = await sink.run(["core", "inbox", "mark-read", "chat_1", "--json", ...args], opts);
      expect([r.status, r.requests]).toEqual([2, []]);
    }
    const blankFlag = await markRead("   ");
    expect([blankFlag.status, blankFlag.requests]).toEqual([2, []]);
    const withProfile = await sink.run(["core", "inbox", "mark-read", "chat_1", "--json"], {
      env: { CURVIATE_ACCOUNT: "" },
      xdg: configHome({ account: "acc_02B" }),
    });
    expect([withProfile.status, nonLookup(withProfile)]).toEqual([2, []]);
  });

  it("an explicit account (flag, env, profile) wins with no lookup", async () => {
    connected = [RALF, SOPH];
    for (const mk of [
      () => sink.run(["core", "inbox", "mark-read", "chat_1", "--json", "--account", "acc_01FLAG"]),
      () => sink.run(["core", "inbox", "mark-read", "chat_1", "--json"], { env: { CURVIATE_ACCOUNT: "acc_01FLAG" } }),
      () => sink.run(["core", "inbox", "mark-read", "chat_1", "--json"], { xdg: configHome({ account: "acc_01FLAG" }) }),
    ]) {
      const r = await mk();
      expect(r.status, r.stderr).toBe(0);
      expect(r.requests.map((q) => q.url)).toEqual(["/v1/acc_01FLAG/chats/chat_1"]);
    }
  });
});

describe("a blank account_id positional is refused before any request", () => {
  const seat = { seat_id: "seat_free", occupied: false, account_id: null };
  it.each([
    [["get"]],
    [["disconnect"]],
    [["update", "--metadata", "{}"]],
    [["checkpoint", "solve", "--code", "123456"]],
    [["checkpoint", "poll"]],
    [["checkpoint", "request"]],
  ])("account %j: empty and whitespace exit 2 with zero requests; a real id sends", async (cmd) => {
    const real = "acc_real";
    const [head, ...rest] = cmd as [string, ...string[]];
    const at = (id: string) => (head === "checkpoint" ? ["account", head, rest[0]!, id, ...rest.slice(1)] : ["account", head, id, ...rest]);
    for (const v of ["", "  "]) {
      const r = await sink.run([...at(v), "--json"]);
      expect([r.status, r.requests], JSON.stringify(v)).toEqual([2, []]);
      expect(r.stderr).toContain("account_id is required");
    }
    const ok = await sink.run([...at(real), "--json"]);
    expect(ok.requests.length).toBeGreaterThan(0);
    expect(ok.requests[0]!.url + ok.requests[0]!.body).toContain(real);
  });

  it("webhook update --account-ids: empty, blank and comma-only exit 2 with zero requests; a real list is sent", async () => {
    for (const v of ["", "  ", " , "]) {
      const r = await sink.run(["webhook", "update", "wh_1", "--account-ids", v, "--json"]);
      expect([r.status, r.requests], JSON.stringify(v)).toEqual([2, []]);
      expect(r.stderr).toContain("--account-ids was given an empty value");
    }
    const ok = await sink.run(["webhook", "update", "wh_1", "--account-ids", "acc_a, acc_b", "--json"]);
    expect(JSON.parse(ok.requests[0]!.body)).toMatchObject({ account_ids: ["acc_a", "acc_b"] });
  });

  it("account link --account-id: empty and whitespace exit 2 with zero requests; a real id reconnects (exit 12 at the checkpoint)", async () => {
    sink.reply = (h) =>
      h.url.startsWith("/v1/accounts/seats")
        ? { body: { object: "seat_list", items: [seat] } }
        : { status: 202, body: { object: "account", status: "checkpoint_required", account_id: "acc_new", checkpoint: { type: "OTP" } } };
    const link = ["account", "link", "--auth-method", "cookie", "--li-at", "li_at_value", "--user-agent", "UA/1", "--country", "US", "--seat-id", "seat_taken", "--json"];
    for (const v of ["", "  "]) {
      const r = await sink.run([...link, "--account-id", v]);
      expect([r.status, r.requests]).toEqual([2, []]);
      expect(r.stderr).toContain("--account-id was given an empty value");
    }
    const ok = await sink.run([...link, "--account-id", "acc_old"]);
    expect(ok.status, ok.stderr).toBe(12);
    expect(ok.requests.map(line)).toEqual(["POST /v1/auth/intent"]);
    expect(JSON.parse(ok.requests[0]!.body)).toMatchObject({ account_id: "acc_old" });
  });
});

describe("--subject / --signature are checked before the account lookup (no --account)", () => {
  const sn = ["core", "sales-nav", "message", "new", "--to", "ACoAAA123"];
  const rc = ["core", "recruiter", "message", "new", "--to", "AEMAAA1"];
  it.each([
    [[...sn, "--subject", "", "hello"], "--subject", [...sn, "--subject", "Hi", "hello"]],
    [[...sn, "hello"], "--subject", [...sn, "--subject", "Hi", "hello"]],
    [[...rc, "--subject", "", "--signature", "Sig", "hello"], "--subject", [...rc, "--subject", "Sub", "--signature", "Sig", "hello"]],
    [[...rc, "--subject", "Sub", "--signature", "", "hello"], "--signature", [...rc, "--subject", "Sub", "--signature", "Sig", "hello"]],
  ])("%j exits 2 with no GET /v1/accounts; the filled-in form does reach it", async (args, flag, filled) => {
    connected = [ONLY];
    const refused = await sink.run([...args, "--json"]);
    expect([refused.status, refused.requests]).toEqual([2, []]);
    expect(refused.stderr).toContain(flag);
    expect((await sink.run([...filled, "--json"])).requests.map(line)).toContain("GET /v1/accounts");
  });
});
