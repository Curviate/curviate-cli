/**
 * `--mode` / `--max-age` on the store-served reads.
 *
 * WHICH COMMANDS GET THE FLAGS IS DERIVED FROM THE SERVER, not from a list.
 * Only three served endpoints declare the pair (the schemas that spread
 * `retrievalQueryFields`), and the REST registry REFUSES it with a 400 on
 * every endpoint that does not, rather than ignoring it. So the flags belong
 * on exactly:
 *
 *   profile me     → users.get("me", …)
 *   profile <id>   → users.get(id, …)
 *   inbox messages → messaging.listMessages(chatId, …)
 *
 * and must NOT be offered on the activity/list branches of the same commands
 * (`--posts`/`--comments`/`--reactions`/`--followers`), which call different
 * endpoints that would 400. `inbox get` maps to a servable endpoint but the
 * pinned SDK's `getChat(chatId)` accepts no query argument at all, so the
 * flags cannot be plumbed there yet; that gap is asserted in
 * `retrieval-sdk-gap.test.ts` rather than papered over here.
 *
 * The exit-2 arms assert the SDK was NEVER CALLED. That is the actual
 * contract ("a misuse pre-check before any network call"); asserting only the
 * exit code would pass just as well if the CLI made the doomed request first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";

function makeUsersNs() {
  return {
    users: {
      get: vi.fn().mockResolvedValue({ id: "ACoAAA_x", first_name: "Ada" }),
      listPosts: vi.fn().mockResolvedValue({ items: [], cursor: null }),
      listFollowers: vi.fn().mockResolvedValue({ items: [], cursor: null }),
    },
  };
}
function makeMessagingNs() {
  return {
    messaging: {
      getChat: vi.fn().mockResolvedValue({ id: "c1" }),
      listMessages: vi.fn().mockResolvedValue({ items: [], cursor: null }),
    },
  };
}
function makeClient(ns: unknown) {
  return { account: vi.fn().mockReturnValue(ns) };
}
function makeOut() {
  return { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
}

/** Run `fn`, capturing the exit code a `process.exit` would have produced. */
async function captureExit(fn: () => Promise<void>): Promise<number> {
  const spy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`__exit__${code ?? 0}`);
  }) as never);
  try {
    await fn();
    return 0;
  } catch (e) {
    const m = /__exit__(\d+)/.exec((e as Error).message);
    if (!m) throw e;
    return Number(m[1]);
  } finally {
    spy.mockRestore();
  }
}

const ACC = { account: "acc_1", json: true } as never;

afterEach(() => vi.restoreAllMocks());

describe("profile me — the retrieval pair reaches users.get", () => {
  let ns: ReturnType<typeof makeUsersNs>;
  let client: ReturnType<typeof makeClient>;
  beforeEach(() => {
    ns = makeUsersNs();
    client = makeClient(ns);
  });

  it.each(["live", "auto", "refill", "cache_only"])("--mode %s is forwarded", async (mode) => {
    const { runProfileMe } = await import("../../src/commands/profile.js");
    await runProfileMe(client as never, { ...(ACC as object), mode } as never, makeOut());
    expect(ns.users.get).toHaveBeenCalledWith("me", expect.objectContaining({ mode }));
  });

  it("--max-age is forwarded as the wire's max_age, a number", async () => {
    const { runProfileMe } = await import("../../src/commands/profile.js");
    await runProfileMe(client as never, { ...(ACC as object), "max-age": "300" } as never, makeOut());
    expect(ns.users.get).toHaveBeenCalledWith("me", expect.objectContaining({ max_age: 300 }));
  });

  // EDGE: omitted flags must not become keys. A `{mode: undefined}` on the
  // query object is a parameter the caller never asked for.
  it("omitting both sends neither key", async () => {
    const { runProfileMe } = await import("../../src/commands/profile.js");
    await runProfileMe(client as never, { ...(ACC as object) } as never, makeOut());
    const params = (ns.users.get as Mock).mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.keys(params)).not.toContain("mode");
    expect(Object.keys(params)).not.toContain("max_age");
  });

  it("coexists with --sections rather than replacing it", async () => {
    const { runProfileMe } = await import("../../src/commands/profile.js");
    await runProfileMe(
      client as never,
      { ...(ACC as object), mode: "refill", sections: "skills" } as never,
      makeOut(),
    );
    expect(ns.users.get).toHaveBeenCalledWith(
      "me",
      expect.objectContaining({ mode: "refill", linkedin_sections: ["linkedin_skills"] }),
    );
  });
});

describe("profile <id> — the retrieval pair reaches users.get", () => {
  let ns: ReturnType<typeof makeUsersNs>;
  let client: ReturnType<typeof makeClient>;
  beforeEach(() => {
    ns = makeUsersNs();
    client = makeClient(ns);
  });

  it("--mode refill --max-age is rejected together only under cache_only; refill forwards both", async () => {
    const { runProfileGet } = await import("../../src/commands/profile.js");
    await runProfileGet(
      client as never,
      { ...(ACC as object), id: "ada-slug", mode: "refill", "max-age": "60" } as never,
      makeOut(),
    );
    expect(ns.users.get).toHaveBeenCalledWith(
      "ada-slug",
      expect.objectContaining({ mode: "refill", max_age: 60 }),
    );
  });

  it("--max-age 0 survives as 0, the value a falsy check drops", async () => {
    const { runProfileGet } = await import("../../src/commands/profile.js");
    await runProfileGet(
      client as never,
      { ...(ACC as object), id: "ada-slug", "max-age": "0" } as never,
      makeOut(),
    );
    const params = (ns.users.get as Mock).mock.calls[0]![1] as Record<string, unknown>;
    expect(params["max_age"]).toBe(0);
  });
});

describe("inbox messages — the retrieval pair reaches listMessages", () => {
  let ns: ReturnType<typeof makeMessagingNs>;
  let client: ReturnType<typeof makeClient>;
  beforeEach(() => {
    ns = makeMessagingNs();
    client = makeClient(ns);
  });

  it("--mode cache_only is forwarded", async () => {
    const { runInboxMessages } = await import("../../src/commands/inbox.js");
    await runInboxMessages(
      client as never,
      { ...(ACC as object), chatId: "c1", mode: "cache_only" } as never,
      makeOut(),
    );
    expect(ns.messaging.listMessages).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ mode: "cache_only" }),
    );
  });

  it("--max-age rides alongside the existing paging flags", async () => {
    const { runInboxMessages } = await import("../../src/commands/inbox.js");
    await runInboxMessages(
      client as never,
      { ...(ACC as object), chatId: "c1", "max-age": "120", limit: "5" } as never,
      makeOut(),
    );
    expect(ns.messaging.listMessages).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ max_age: 120, limit: 5 }),
    );
  });
});

describe("validation happens before any network call (exit 2)", () => {
  it("cache_only + --max-age exits 2 and calls nothing", async () => {
    const ns = makeUsersNs();
    const client = makeClient(ns);
    const { runProfileMe } = await import("../../src/commands/profile.js");
    const code = await captureExit(() =>
      runProfileMe(
        client as never,
        { ...(ACC as object), mode: "cache_only", "max-age": "60" } as never,
        makeOut(),
      ),
    );
    expect(code).toBe(2);
    expect(ns.users.get).not.toHaveBeenCalled();
  });

  it("an unknown --mode exits 2 and calls nothing", async () => {
    const ns = makeUsersNs();
    const client = makeClient(ns);
    const { runProfileMe } = await import("../../src/commands/profile.js");
    const code = await captureExit(() =>
      runProfileMe(client as never, { ...(ACC as object), mode: "cached" } as never, makeOut()),
    );
    expect(code).toBe(2);
    expect(ns.users.get).not.toHaveBeenCalled();
  });

  it("a --max-age past the ceiling exits 2 and calls nothing", async () => {
    const ns = makeMessagingNs();
    const client = makeClient(ns);
    const { runInboxMessages } = await import("../../src/commands/inbox.js");
    const code = await captureExit(() =>
      runInboxMessages(
        client as never,
        { ...(ACC as object), chatId: "c1", "max-age": "31536001" } as never,
        makeOut(),
      ),
    );
    expect(code).toBe(2);
    expect(ns.messaging.listMessages).not.toHaveBeenCalled();
  });

  // CONTROL on the harness: a well-formed invocation of the same runner does
  // reach the SDK, so "not called" above is a property of the validation and
  // not of a runner that never calls anything under this fixture.
  it("control: the same runner with a valid mode does call the SDK", async () => {
    const ns = makeMessagingNs();
    const client = makeClient(ns);
    const { runInboxMessages } = await import("../../src/commands/inbox.js");
    const code = await captureExit(() =>
      runInboxMessages(
        client as never,
        { ...(ACC as object), chatId: "c1", "max-age": "31536000" } as never,
        makeOut(),
      ),
    );
    expect(code).toBe(0);
    expect(ns.messaging.listMessages).toHaveBeenCalled();
  });
});

describe("the flags are refused where the endpoint would 400", () => {
  it.each(["posts", "comments", "reactions", "followers"])(
    "profile me --%s --mode live exits 2 rather than sending a parameter the endpoint refuses",
    async (activity) => {
      const ns = makeUsersNs();
      const client = makeClient(ns);
      const { runProfileMe } = await import("../../src/commands/profile.js");
      const code = await captureExit(() =>
        runProfileMe(
          client as never,
          { ...(ACC as object), [activity]: true, mode: "live" } as never,
          makeOut(),
        ),
      );
      expect(code).toBe(2);
    },
  );

  // CONTROL: the activity branch itself is fine without the retrieval flags.
  it("control: profile me --followers without --mode still runs", async () => {
    const ns = makeUsersNs();
    const client = makeClient(ns);
    const { runProfileMe } = await import("../../src/commands/profile.js");
    const code = await captureExit(() =>
      runProfileMe(client as never, { ...(ACC as object), followers: true } as never, makeOut()),
    );
    expect(code).toBe(0);
    expect(ns.users.listFollowers).toHaveBeenCalled();
  });
});

/**
 * The id-resolution pre-call must obey the retrieval mode too.
 *
 * `profile <id> --sections` cannot send a raw slug (the sections-enriched read
 * rejects it), so the command resolves the slug to a provider id with a FIRST
 * `users.get`. That pre-call is a read like any other, and under
 * `--mode cache_only` it must not reach LinkedIn: a mode whose entire purpose
 * is "never fetch" that fetches once before the real read has broken its only
 * guarantee, and it would do so under a 200 with nothing to notice.
 *
 * Needs BOTH `--sections` and a slug to trigger: a provider id or `me`
 * short-circuits the resolve entirely.
 */
describe("profile <id> --sections — the resolve pre-call carries the mode", () => {
  it("sends cache_only on the resolve call, not just the enriched read", async () => {
    const ns = makeUsersNs();
    (ns.users.get as Mock).mockResolvedValue({ id: "ACoAAA_x", first_name: "Ada" });
    const client = makeClient(ns);
    const { runProfileGet } = await import("../../src/commands/profile.js");

    await runProfileGet(
      client as never,
      { ...(ACC as object), id: "ada-slug", sections: "skills", mode: "cache_only" } as never,
      makeOut(),
    );

    const calls = (ns.users.get as Mock).mock.calls;
    // Two calls: the slug resolve, then the enriched read.
    expect(calls.length).toBe(2);
    for (const [, params] of calls) {
      expect((params as Record<string, unknown>)["mode"]).toBe("cache_only");
    }
  });

  it("carries --max-age onto the resolve call as well", async () => {
    const ns = makeUsersNs();
    (ns.users.get as Mock).mockResolvedValue({ id: "ACoAAA_x", first_name: "Ada" });
    const client = makeClient(ns);
    const { runProfileGet } = await import("../../src/commands/profile.js");

    await runProfileGet(
      client as never,
      { ...(ACC as object), id: "ada-slug", sections: "skills", "max-age": "300" } as never,
      makeOut(),
    );
    for (const [, params] of (ns.users.get as Mock).mock.calls) {
      expect((params as Record<string, unknown>)["max_age"]).toBe(300);
    }
  });

  // CONTROL: a provider id needs no resolve, so exactly one call is made —
  // proving the two-call arm above is about the resolve and not about a
  // command that always calls twice.
  it("control: a provider id short-circuits the resolve (one call)", async () => {
    const ns = makeUsersNs();
    (ns.users.get as Mock).mockResolvedValue({ id: "ACoAAA_x", first_name: "Ada" });
    const client = makeClient(ns);
    const { runProfileGet } = await import("../../src/commands/profile.js");

    await runProfileGet(
      client as never,
      { ...(ACC as object), id: "ACoAAA_x", sections: "skills", mode: "cache_only" } as never,
      makeOut(),
    );
    expect((ns.users.get as Mock).mock.calls.length).toBe(1);
  });
});
