/**
 * The two places the retrieval CLI surface is blocked by the pinned
 * `@curviate/sdk`, recorded as EXECUTABLE FACTS rather than prose in a README.
 *
 * Both are ripple items for the SDK regen, not CLI defects, and both are
 * written so they go RED the moment the SDK ships the missing piece. That is
 * the point: a comment saying "waiting on the SDK" rots silently, while a test
 * that fails on the day the wait ends tells whoever bumps the pin exactly what
 * to finish.
 *
 *   1. `messaging.getChat(chatId)` takes NO query argument, so `inbox get`
 *      cannot carry `--mode`/`--max-age` even though the served endpoint
 *      `GET /v1/{account_id}/chats/{chat_id}` declares both.
 *   2. `NOT_STORED` is absent from the SDK's `ERROR_CODES`, so the wire code
 *      decodes to `INTERNAL` and the binary answers exit 1 instead of the
 *      exit 14 the table maps.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Curviate, ERROR_CODES } from "@curviate/sdk";
import { runProfileMe } from "../../src/commands/profile.js";
import { EXIT_CODE_MAP } from "../../src/lib/exit-codes.js";

const BASE = "https://gap.curviate.test";
const ACCOUNT = "acc_01JQZK8N3XV4RTYWB2M6D5F0AC";

afterEach(() => vi.restoreAllMocks());

// ── Gap 1: inbox get cannot carry the pair ────────────────────────────────
describe("SDK gap: messaging.getChat accepts no retrieval query", () => {
  it("sends no query string even when a second argument is supplied", async () => {
    let url = "";
    const client = new Curviate({
      apiKey: "cvt_live_test",
      baseUrl: BASE,
      fetch: (async (input: unknown) => {
        url = String(input);
        return new Response(JSON.stringify({ id: "c1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });

    const messaging = client.account(ACCOUNT).messaging as unknown as {
      getChat: (chatId: string, params?: unknown) => Promise<unknown>;
    };
    // Passing params is deliberately illegal against the typed signature; the
    // cast above is what lets the runtime prove they are DISCARDED rather than
    // merely untyped. If a regenerated SDK starts forwarding them, this reds.
    await messaging.getChat("c1", { mode: "cache_only" });

    expect(url).toContain("/chats/c1");
    expect(url).not.toContain("mode");
    expect(url).not.toContain("max_age");
  });

  // CONTROL: a method that DOES take a query proves the harness can observe
  // one, so "no query" above is a fact about getChat and not about the fetch spy.
  it("control: users.get on the same client does forward its query", async () => {
    let url = "";
    const client = new Curviate({
      apiKey: "cvt_live_test",
      baseUrl: BASE,
      fetch: (async (input: unknown) => {
        url = String(input);
        return new Response(JSON.stringify({ id: "u1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    await client.account(ACCOUNT).users.get("me", { mode: "cache_only" } as never);
    expect(url).toContain("mode=cache_only");
  });
});

// ── Gap 2: NOT_STORED does not survive the SDK's decode ───────────────────
describe("SDK gap: NOT_STORED decodes to INTERNAL on the pinned SDK", () => {
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

  it("the table maps NOT_STORED to 14, ahead of the SDK", () => {
    expect(EXIT_CODE_MAP["NOT_STORED"]).toBe(14);
  });

  // THE GATE. Today the pinned SDK cannot decode the code, so the mapping
  // above is unreachable and the binary answers 1. When the SDK regen lands,
  // this flips to 14 and this assertion reds — which is the signal to change
  // it, and to delete `PendingSdkErrorCode` from lib/exit-codes.ts.
  it("the installed SDK does not know NOT_STORED, so the binary still exits 1", async () => {
    expect(ERROR_CODES as readonly string[]).not.toContain("NOT_STORED");
    const { exit } = await drive();
    expect(exit).toBe(1);
  });

  // CONTROL on the decode path: a code the SDK DOES know reaches the table,
  // so "exits 1" above is caused by the unknown code and not by the runner
  // failing before it ever decoded.
  it("control: a code the SDK does know maps through the same path", () => {
    expect(ERROR_CODES as readonly string[]).toContain("RESOURCE_NOT_FOUND");
    expect(EXIT_CODE_MAP["RESOURCE_NOT_FOUND"]).toBe(4);
  });
});
