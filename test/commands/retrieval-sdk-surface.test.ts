/**
 * The two retrieval-surface pieces the CLI needed from `@curviate/sdk`,
 * recorded as EXECUTABLE FACTS rather than prose in a README.
 *
 * Both were blocked on the pinned SDK and were written, as the inverse of
 * what is below, to go RED the moment the SDK shipped the missing piece. It
 * shipped in 0.26.0 and they did, so each arm is now the POSITIVE statement of
 * the same fact. Keeping them (rather than deleting them once green) is the
 * point: they are what would catch a pin rolled backwards, or an SDK regen
 * that dropped either piece again.
 *
 *   1. `messaging.getChat(chatId, params?)` takes the retrieval query, so
 *      `inbox get` can carry `--mode`/`--max-age` the way the served endpoint
 *      `GET /v1/{account_id}/chats/{chat_id}` has always declared.
 *   2. `NOT_STORED` is in the SDK's `ERROR_CODES`, so the wire code decodes to
 *      itself rather than `INTERNAL` and the binary answers the exit 14 the
 *      table maps.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Curviate, ERROR_CODES } from "@curviate/sdk";
import { runProfileMe } from "../../src/commands/profile.js";
import { EXIT_CODE_MAP } from "../../src/lib/exit-codes.js";

const BASE = "https://gap.curviate.test";
const ACCOUNT = "acc_01JQZK8N3XV4RTYWB2M6D5F0AC";

afterEach(() => vi.restoreAllMocks());

/** A client whose fetch records the URL it was handed and answers 200. */
function urlRecorder(body: unknown): { client: Curviate; url: () => string } {
  let url = "";
  const client = new Curviate({
    apiKey: "cvt_live_test",
    baseUrl: BASE,
    fetch: (async (input: unknown) => {
      url = String(input);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
  return { client, url: () => url };
}

// ── 1: messaging.getChat carries the retrieval query ──────────────────────
describe("messaging.getChat forwards the retrieval query", () => {
  it("puts --mode on the wire as mode=", async () => {
    const { client, url } = urlRecorder({ id: "c1" });
    await client.account(ACCOUNT).messaging.getChat("c1", { mode: "cache_only" });

    expect(url()).toContain("/chats/c1");
    expect(url()).toContain("mode=cache_only");
  });

  it("puts --max-age on the wire as max_age=, alongside a mode", async () => {
    const { client, url } = urlRecorder({ id: "c1" });
    await client.account(ACCOUNT).messaging.getChat("c1", { mode: "refill", max_age: 60 });

    expect(url()).toContain("mode=refill");
    expect(url()).toContain("max_age=60");
  });

  // CONTROL on the recorder: an omitted query must produce NO query string, so
  // the two positives above are facts about the forwarded params and not about
  // a URL that always carries something.
  it("control: no params sends no query string at all", async () => {
    const { client, url } = urlRecorder({ id: "c1" });
    await client.account(ACCOUNT).messaging.getChat("c1");
    expect(url()).not.toContain("?");
  });

  // CONTROL: a method that ALREADY took a query still does, so a regression
  // that broke query forwarding globally cannot read as a pass above.
  it("control: users.get on the same client forwards its query too", async () => {
    const { client, url } = urlRecorder({ id: "u1" });
    await client.account(ACCOUNT).users.get("me", { mode: "cache_only" } as never);
    expect(url()).toContain("mode=cache_only");
  });
});

// ── 2: NOT_STORED survives the SDK decode and reaches exit 14 ─────────────
describe("NOT_STORED decodes to itself and the binary exits 14", () => {
  const NOT_STORED_BODY = {
    code: "NOT_STORED",
    message: "Nothing is stored for this resource and mode=cache_only never fetches.",
    user_fixable: true,
    retry_likely_to_succeed: false,
  };

  /** Drive a real `profile me --mode cache_only` over an injected fetch. */
  async function drive(): Promise<{ exit: number; fetches: number }> {
    let fetches = 0;
    const client = new Curviate({
      apiKey: "cvt_live_test",
      baseUrl: BASE,
      timeout: 5_000,
      maxRetries: 1,
      fetch: (async () => {
        fetches += 1;
        return new Response(JSON.stringify(NOT_STORED_BODY), {
          status: 422,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });

    const spy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit__${code ?? 0}`);
    }) as never);
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    let exit = 0;
    try {
      await runProfileMe(client, { account: ACCOUNT, json: true, mode: "cache_only" } as never, out);
    } catch (e) {
      const m = /__exit__(\d+)/.exec((e as Error).message);
      exit = m ? Number(m[1]) : -1;
    } finally {
      spy.mockRestore();
    }
    return { exit, fetches };
  }

  it("the table maps NOT_STORED to 14", () => {
    expect(EXIT_CODE_MAP["NOT_STORED"]).toBe(14);
  });

  it("the installed SDK knows NOT_STORED", () => {
    expect(ERROR_CODES as readonly string[]).toContain("NOT_STORED");
  });

  // THE GATE. The mapping above is only reachable because the SDK decodes the
  // code; before 0.26.0 it fell through to INTERNAL and this answered 1.
  it("a NOT_STORED 422 reaches the table and the binary exits 14", async () => {
    const { exit } = await drive();
    expect(exit).toBe(14);
  });

  // CONTROL on retryability: NOT_STORED must be answered on the FIRST reply.
  // A retried GET here would burn attempts against an answer that cannot
  // change until the caller picks another mode, and would still exit 14, so
  // the exit code alone cannot tell the two apart.
  it("control: the refusal is not retried, so exactly one request is made", async () => {
    const { fetches } = await drive();
    expect(fetches).toBe(1);
  });

  // CONTROL on the decode path: a code the SDK has always known maps through
  // the same table, so "exits 14" above is caused by the decode and not by a
  // runner that happens to produce 14 for anything.
  it("control: a long-known code maps through the same path", () => {
    expect(ERROR_CODES as readonly string[]).toContain("RESOURCE_NOT_FOUND");
    expect(EXIT_CODE_MAP["RESOURCE_NOT_FOUND"]).toBe(4);
  });
});
