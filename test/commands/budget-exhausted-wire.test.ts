/**
 * The exit-13 contract, driven through the REAL client stack.
 *
 * Every other test of this behaviour stops short of the thing that can go
 * wrong. `test/lib/exit-codes.test.ts` asserts `EXIT_CODE_MAP` maps the code,
 * and `test/lib/output.test.ts` asserts `renderError` prints the payload; both
 * hand the CLI a `BUDGET_EXHAUSTED` it never had to decode. The step between
 * them belongs to `@curviate/sdk`: the wire `code` reaches `getExitCode` only
 * if the SDK's `ERROR_CODES` knows it, and an unknown code decodes to
 * `INTERNAL` instead. `INTERNAL` is in the SDK's `RETRYABLE_CODES`, so on a
 * GET the refusal is also retried three times and every payload field is
 * dropped.
 *
 * So this file drives a real `Curviate` over an injected `fetch`, through the
 * real command runner and the real error path, and reads the two facts a
 * scripted caller actually observes: the EXIT CODE and the FETCH COUNT.
 *
 * IT IS RED AGAINST THE CURRENTLY PINNED @curviate/sdk (0.24.3), ON PURPOSE.
 * That SDK predates the code, so it produces exit 1 after 4 fetches. This is
 * the release gate for the pin bump, not a broken test: it goes green the
 * moment `package.json` pins an `@curviate/sdk` that ships `BUDGET_EXHAUSTED`
 * (curviate-sdk#29), with nothing else to change. A version of this assertion
 * that passed today would be asserting the CLI's own map back to itself and
 * would have shipped a README contract the binary does not honour.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Curviate } from "@curviate/sdk";
import { runAccountGet } from "../../src/commands/account.js";

const BASE = "https://wire.curviate.test";

/** The server's real flat error envelope for an account-safety refusal. */
const BUDGET_EXHAUSTED_BODY = {
  code: "BUDGET_EXHAUSTED",
  message: "Daily ceiling for the profile_views row is exhausted.",
  user_fixable: true,
  retry_likely_to_succeed: false,
  row: "profile_views",
  reset_at: "2026-09-06T00:00:00.000Z",
  hint: {
    parameter: "profile_views.ceiling",
    message: "Raising the ceiling raises the effective ceiling by the same factor.",
  },
  reason: "ceiling",
  blocked: true,
};

/** An ordinary request-rate 429, the control. */
const RATE_LIMIT_BODY = {
  code: "RATE_LIMIT_ACCOUNT",
  message: "The per-account request rate limit was exceeded.",
  user_fixable: false,
  retry_likely_to_succeed: true,
};

describe("BUDGET_EXHAUSTED over the wire: exit code and retry count", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stdout: string[];
  let stderr: string[];

  const out = {
    stdout: { write: (s: string) => { stdout.push(s); } },
    stderr: { write: (s: string) => { stderr.push(s); } },
  };

  beforeEach(() => {
    stdout = [];
    stderr = [];
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    }) as never;
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  /**
   * Drive one `account get` over an injected fetch that always answers with
   * `body` at `status`, and report what the caller observes.
   *
   * A real `Curviate`, not `createClient`: the factory pins the guarded global
   * `fetch`, and the point here is to exercise the SDK's own decode and retry
   * without a network. Everything downstream of the response is the real code
   * path, including `getExitCode`.
   */
  async function drive(
    body: Record<string, unknown>,
    status = 429,
  ): Promise<{ exit: number; fetches: number; json: Record<string, unknown> }> {
    let fetches = 0;
    const client = new Curviate({
      apiKey: "cvt_live_test",
      baseUrl: BASE,
      // No sleeping: a retryable arm would otherwise wait out real backoff.
      timeout: 5_000,
      fetch: (async () => {
        fetches += 1;
        return new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });

    let exit = 0;
    try {
      await runAccountGet(
        client,
        // `AccountFlags` is module-local to the command; the runner only reads
        // these two on this path.
        { "account-id": "acc_01JQZK8N3XV4RTYWB2M6D5F0AC", json: true } as never,
        out as never,
      );
    } catch (e) {
      const m = /process\.exit\((\d+)\)/.exec((e as Error).message);
      exit = m ? Number(m[1]) : -1;
    }
    const written = stdout.join("");
    const json = written ? (JSON.parse(written) as Record<string, unknown>) : {};
    return { exit, fetches, json };
  }

  it("exits 13 and sends exactly one request", async () => {
    const { exit, fetches } = await drive(BUDGET_EXHAUSTED_BODY);
    expect(exit).toBe(13);
    // One attempt, no retries. An account-safety ceiling is not freed by
    // waiting inside the call, and the reset can be a month out.
    expect(fetches).toBe(1);
  });

  it("keeps the refusal payload on the --json envelope", async () => {
    const { json } = await drive(BUDGET_EXHAUSTED_BODY);
    expect(json["error"]).toMatchObject({
      code: "BUDGET_EXHAUSTED",
      budgetRow: "profile_views",
      resetAt: "2026-09-06T00:00:00.000Z",
      safetyReason: "ceiling",
      blocked: true,
    });
  });

  // CONTROL. The harness must be able to tell the two 429s apart, or "exit 13"
  // above could be a property of the harness rather than of the code. An
  // ordinary rate limit still exits 6 AND is still retried to exhaustion.
  it("control: an ordinary 429 still exits 6 and is still retried", async () => {
    const { exit, fetches } = await drive(RATE_LIMIT_BODY);
    expect(exit).toBe(6);
    expect(fetches).toBeGreaterThan(1);
  });

  // CONTROL on the exit path itself: a 200 reaches neither branch, so a green
  // arm above cannot come from the runner failing before it ever decoded.
  it("control: a 200 exits 0 and writes the account", async () => {
    const { exit, fetches, json } = await drive(
      { object: "account", account_id: "acc_01JQZK8N3XV4RTYWB2M6D5F0AC", quotas: [] },
      200,
    );
    expect(exit).toBe(0);
    expect(fetches).toBe(1);
    expect(json["account_id"]).toBe("acc_01JQZK8N3XV4RTYWB2M6D5F0AC");
  });
});
