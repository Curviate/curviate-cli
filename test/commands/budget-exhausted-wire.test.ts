/**
 * The exit-13 contract driven through the REAL SDK client over an injected fetch: the wire `code` reaches
 * `getExitCode` only if the SDK knows it (else it decodes to INTERNAL, which a GET retries and strips the payload from).
 * Observed: the EXIT CODE and the FETCH COUNT, with same-path controls so "exit 13" is a property of the code.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Curviate } from "@curviate/sdk";
import { runAccountGet } from "../../src/commands/account.js";
import { exitCode } from "../helpers/exit-code.js";

const BUDGET_EXHAUSTED = {
  code: "BUDGET_EXHAUSTED", message: "Daily ceiling for the profile_views row is exhausted.", user_fixable: true, retry_likely_to_succeed: false,
  row: "profile_views", reset_at: "2026-09-06T00:00:00.000Z", hint: { parameter: "profile_views.ceiling", message: "Raise it." }, reason: "ceiling", blocked: true,
};
const RATE_LIMIT = { code: "RATE_LIMIT_ACCOUNT", message: "The per-account request rate limit was exceeded.", user_fixable: false, retry_likely_to_succeed: true };
const ACCOUNT = { object: "account", account_id: "acc_01JQZK8N3XV4RTYWB2M6D5F0AC", quotas: [] };

let stdout: string[];
beforeEach(() => {
  stdout = [];
});

/** One `account get` over a fetch that always answers `body` at `status`; exit is -1 until set (0 is explicit on return). */
async function drive(body: object, status: number) {
  let fetches = 0;
  const client = new Curviate({
    apiKey: "cvt_live_test", baseUrl: "https://wire.curviate.test", timeout: 5_000,
    maxRetries: 1, // one retry still proves "retried"; the assertion is > 1, never === 4
    fetch: (async () => (fetches++, new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }))) as typeof fetch,
  });
  const out = { stdout: { write: (s: string) => void stdout.push(s) }, stderr: { write: () => {} } };
  const exit = (await exitCode(() => runAccountGet(client, { "account-id": ACCOUNT.account_id, json: true } as never, out as never))) ?? 0;
  return { exit, fetches, json: stdout.length ? (JSON.parse(stdout.join("")) as Record<string, any>) : {} }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

describe("BUDGET_EXHAUSTED over the wire", { timeout: 20_000 }, () => {
  it("exits 13 on exactly one request (a ceiling is not freed by waiting) and keeps the payload on the --json envelope", async () => {
    const r = await drive(BUDGET_EXHAUSTED, 429);
    expect([r.exit, r.fetches]).toEqual([13, 1]);
    expect(r.json["error"]).toMatchObject({ code: "BUDGET_EXHAUSTED", budgetRow: "profile_views", resetAt: "2026-09-06T00:00:00.000Z", safetyReason: "ceiling", blocked: true });
  });

  it("control: an ordinary 429 exits 6 and is retried; a 200 exits 0 and writes the account", async () => {
    const rl = await drive(RATE_LIMIT, 429);
    expect(rl.exit).toBe(6);
    expect(rl.fetches).toBeGreaterThan(1);
    stdout = [];
    const ok = await drive(ACCOUNT, 200);
    expect([ok.exit, ok.fetches, ok.json["account_id"]]).toEqual([0, 1, ACCOUNT.account_id]);
  });
});
