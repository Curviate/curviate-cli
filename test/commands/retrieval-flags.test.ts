/**
 * `--mode` / `--max-age` exist exactly on the store-served reads (profile me, profile <id>, inbox messages, inbox get):
 * the API answers 400 on any endpoint that does not declare them, so everywhere else they are refused, not dropped.
 * Misuse is refused before any network call.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { exitCode } from "../helpers/exit-code.js";
import { clientOf, mkOut } from "../helpers/f1-unit.js";
import { useSink } from "../helpers/sink.js";
import { runProfileGet, runProfileMe, profileCommand } from "../../src/commands/profile.js";
import { runInboxGet, runInboxMessages, inboxCommand } from "../../src/commands/inbox.js";
import { postCommand } from "../../src/commands/post.js";

let users: Record<string, Mock>;
let messaging: Record<string, Mock>;
let client: ReturnType<typeof clientOf>;
beforeEach(() => {
  users = {
    get: vi.fn().mockResolvedValue({ id: "ACoAAA_x", first_name: "Ada" }),
    listPosts: vi.fn().mockResolvedValue({ items: [], cursor: null }),
    listFollowers: vi.fn().mockResolvedValue({ items: [], cursor: null }),
  };
  messaging = { getChat: vi.fn().mockResolvedValue({ id: "c1" }), listMessages: vi.fn().mockResolvedValue({ items: [], cursor: null }) };
  client = clientOf({ users, messaging });
});

type Run = (c: never, a: never, o: never) => Promise<void>;
const base = { account: "acc_1", json: true };
const run = (fn: unknown, flags: object) => (fn as Run)(client as never, { ...base, ...flags } as never, mkOut() as never);
const paramsOf = (m: Mock, i = 0) => m.mock.calls[i]![1] as Record<string, unknown>;

describe("the pair reaches the SDK call as mode / max_age (a number; 0 survives; omitted means no key)", () => {
  it.each(["live", "auto", "refill", "cache_only"])("profile me and inbox get forward --mode %s", async (mode) => {
    await run(runProfileMe, { mode });
    await run(runInboxGet, { chatId: "c1", mode });
    expect(users["get"]).toHaveBeenCalledWith("me", expect.objectContaining({ mode }));
    expect(messaging["getChat"]).toHaveBeenCalledWith("c1", expect.objectContaining({ mode }));
  });

  it.each<[string, unknown, Record<string, Mock>, string, object, unknown[]]>([
    ["profile me --max-age", runProfileMe, {}, "get", { "max-age": "300" }, ["me", expect.objectContaining({ max_age: 300 })]],
    ["profile me with --sections", runProfileMe, {}, "get", { mode: "refill", sections: "skills" }, ["me", expect.objectContaining({ mode: "refill", linkedin_sections: ["linkedin_skills"] })]],
    ["profile <id> mode + max-age", runProfileGet, {}, "get", { id: "ada-slug", mode: "refill", "max-age": "60" }, ["ada-slug", expect.objectContaining({ mode: "refill", max_age: 60 })]],
    ["profile <id> --max-age 0", runProfileGet, {}, "get", { id: "ada-slug", "max-age": "0" }, ["ada-slug", expect.objectContaining({ max_age: 0 })]],
    ["inbox messages mode", runInboxMessages, {}, "listMessages", { chatId: "c1", mode: "cache_only" }, ["c1", expect.objectContaining({ mode: "cache_only" })]],
    ["inbox messages max-age beside paging", runInboxMessages, {}, "listMessages", { chatId: "c1", "max-age": "120", limit: "5" }, ["c1", expect.objectContaining({ max_age: 120, limit: 5 })]],
    ["inbox get --max-age 0", runInboxGet, {}, "getChat", { chatId: "c1", "max-age": "0" }, ["c1", expect.objectContaining({ max_age: 0 })]],
    ["inbox get omitted -> no keys", runInboxGet, {}, "getChat", { chatId: "c1" }, ["c1", {}]],
    ["inbox get rides the normalized chat id", runInboxGet, {}, "getChat", { chatId: "https://www.linkedin.com/messaging/thread/2-AbCdEf==/", mode: "refill" }, ["2-AbCdEf==", { mode: "refill" }]],
  ])("%s", async (_l, fn, _x, method, flags, expected) => {
    await run(fn, flags);
    expect((users[method] ?? messaging[method])!.mock.calls[0]).toEqual(expected);
  });

  it("profile me with no flags sends neither key", async () => {
    await run(runProfileMe, {});
    expect(Object.keys(paramsOf(users["get"]!))).not.toEqual(expect.arrayContaining(["mode"]));
    expect(Object.keys(paramsOf(users["get"]!))).not.toContain("max_age");
  });

  it("profile <id> --sections: the slug-resolve pre-call carries the mode too (two calls); a provider id short-circuits (one)", async () => {
    await run(runProfileGet, { id: "ada-slug", sections: "skills", mode: "cache_only", "max-age": undefined });
    expect(users["get"]!.mock.calls).toHaveLength(2);
    for (const [, p] of users["get"]!.mock.calls) expect((p as Record<string, unknown>)["mode"]).toBe("cache_only");
    users["get"]!.mockClear();
    await run(runProfileGet, { id: "ada-slug", sections: "skills", "max-age": "300" });
    for (const [, p] of users["get"]!.mock.calls) expect((p as Record<string, unknown>)["max_age"]).toBe(300);
    users["get"]!.mockClear();
    await run(runProfileGet, { id: "ACoAAA_x", sections: "skills", mode: "cache_only" });
    expect(users["get"]!.mock.calls).toHaveLength(1);
  });
});

describe("misuse exits 2 and calls nothing", () => {
  it.each<[string, unknown, object]>([
    ["cache_only + --max-age (profile me)", runProfileMe, { mode: "cache_only", "max-age": "60" }],
    ["cache_only + --max-age (inbox get)", runInboxGet, { chatId: "c1", mode: "cache_only", "max-age": "60" }],
    ["unknown --mode", runProfileMe, { mode: "cached" }],
    ["--max-age past the ceiling", runInboxMessages, { chatId: "c1", "max-age": "31536001" }],
    ...["posts", "comments", "reactions", "followers"].map((a): [string, unknown, object] => [`profile me --${a} --mode live (endpoint would 400)`, runProfileMe, { [a]: true, mode: "live" }]),
  ])("%s", async (_l, fn, flags) => {
    expect(await exitCode(() => run(fn, flags))).toBe(2);
    for (const f of [...Object.values(users), ...Object.values(messaging)]) expect(f).not.toHaveBeenCalled();
  });

  it("controls: the ceiling itself and an activity branch without the pair do run", async () => {
    expect(await exitCode(() => run(runInboxMessages, { chatId: "c1", "max-age": "31536000" }))).toBeUndefined();
    expect(messaging["listMessages"]).toHaveBeenCalled();
    expect(await exitCode(() => run(runProfileMe, { followers: true }))).toBeUndefined();
    expect(users["listFollowers"]).toHaveBeenCalled();
  });
});

describe("advertised on exactly the served reads, refused elsewhere", () => {
  type Cmd = { args?: Record<string, unknown>; subCommands?: Record<string, Cmd> };
  const has = (c: Cmd | undefined) => [c?.args?.["mode"], c?.args?.["max-age"]].map((x) => x !== undefined);
  it("declared on profile, profile me, inbox messages, inbox get; not on inbox list or post get", () => {
    const p = profileCommand as unknown as Cmd, i = inboxCommand as unknown as Cmd, post = postCommand as unknown as Cmd;
    for (const c of [p, p.subCommands!["me"], i.subCommands!["messages"], i.subCommands!["get"]]) expect(has(c)).toEqual([true, true]);
    for (const c of [i.subCommands!["list"], post.subCommands!["get"]]) {
      expect(Object.keys(c!.args ?? {})).toContain("json");
      expect(has(c)).toEqual([false, false]);
    }
  });

  const sink = useSink();
  it.each([
    [["inbox", "list", "--mode", "cache_only"], "--mode"],
    [["profile", "followers", "ada", "--max-age", "300"], "--max-age"],
  ])("%j is an unknown flag (exit 2), not silently dropped", async (argv, flag) => {
    const r = await sink.run([...argv, "--account", "acc_1"]);
    expect([r.status, r.requests]).toEqual([2, []]);
    expect(r.stderr).toContain("unknown flag");
    expect(r.stderr).toContain(flag);
  });

  it("where declared, the pair is not an unknown flag and rides the wire as mode= / max_age=", async () => {
    const r = await sink.run(["inbox", "get", "c1", "--account", "acc_1", "--mode", "refill", "--max-age", "60", "--json"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.requests[0]!.url).toMatch(/\/chats\/c1\?.*mode=refill/);
    expect(r.requests[0]!.url).toContain("max_age=60");
    const msgs = await sink.run(["inbox", "messages", "c1", "--account", "acc_1", "--mode", "cache_only", "--json"]);
    expect(msgs.stderr).not.toContain("unknown flag");
  });

  it("NOT_STORED (422) exits 14 on the first reply, no retry", async () => {
    sink.reply = { status: 422, body: { code: "NOT_STORED", message: "Nothing is stored.", user_fixable: true, retry_likely_to_succeed: false } };
    const r = await sink.run(["profile", "me", "--account", "acc_1", "--mode", "cache_only", "--json"]);
    expect(r.status).toBe(14);
    expect(r.requests).toHaveLength(1);
  });
});
