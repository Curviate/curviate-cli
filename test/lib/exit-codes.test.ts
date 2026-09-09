import { describe, it, expect } from "vitest";
import { ERROR_CODES, type ErrorCode } from "@curviate/sdk";
import { AUTH_NEEDED, EXIT_CODE_MAP, getExitCode } from "../../src/lib/exit-codes.js";

// The taxonomy is DERIVED from the installed SDK, not hand-copied: `ERROR_CODES`
// is the runtime tuple `ErrorCode` itself is built from, so the two cannot drift.
// The hand-copied array this replaces could not fail for the case it existed to
// catch (a code the SDK added that nobody copied here was invisible to a loop
// iterating the copy). Retired on the 0.25.0 pin bump, per its own standing order.

/**
 * Every exit code `EXIT_CODE_MAP` is allowed to produce.
 *
 * An explicit set rather than a numeric range, because the range this replaced
 * (1-11) had to be widened every time a bucket was added, and a widened bound
 * silently permits everything below it: after adding 13 as a range, a typo
 * mapping something to 12 would have passed. 12 is `AUTH_NEEDED`, which is a
 * SUCCESS path (a pending checkpoint) and is deliberately not in the map, so
 * an entry claiming it would be a real bug that a range check could not see.
 */
const VALID_EXIT_CODES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14]);

describe("lib/exit-codes — exhaustiveness", () => {
  it("every ErrorCode maps to a number in EXIT_CODE_MAP", () => {
    for (const code of ERROR_CODES) {
      expect(
        typeof EXIT_CODE_MAP[code],
        `ErrorCode "${code}" is missing from EXIT_CODE_MAP`,
      ).toBe("number");
    }
  });

  it("negative guard: an unmapped code is detected", () => {
    // Simulate a future SDK code that was not added to the table.
    const fakeCode = "__UNMAPPED__" as ErrorCode;
    expect(EXIT_CODE_MAP[fakeCode]).toBeUndefined();
  });

  it("every mapped value is a code the contract defines", () => {
    for (const code of ERROR_CODES) {
      const exitCode = EXIT_CODE_MAP[code];
      expect(
        VALID_EXIT_CODES.has(exitCode as number),
        `ErrorCode "${code}" maps to ${exitCode}, which is not a defined exit code`,
      ).toBe(true);
    }
  });

  it("never maps anything to 12, which is the AUTH_NEEDED success path", () => {
    expect(Object.values(EXIT_CODE_MAP)).not.toContain(AUTH_NEEDED);
    // Control: the constant is what the assertion above thinks it is, so this
    // cannot pass by AUTH_NEEDED quietly becoming a value nothing maps to
    // anyway.
    expect(AUTH_NEEDED).toBe(12);
  });
});

describe("lib/exit-codes — spot checks (per spec)", () => {
  it.each([
    ["UNAUTHORIZED", 3],
    ["RESOURCE_NOT_FOUND", 4],
    ["ACCOUNT_NOT_FOUND", 4],
    ["NO_ACTIVE_SEAT", 5],
    ["LINKEDIN_FEATURE_NOT_SUBSCRIBED", 5],
    ["BETA_NOT_ENABLED", 5],
    ["RATE_LIMIT_ACCOUNT", 6],
    ["LINKEDIN_RATE_LIMITED", 6],
    ["PLATFORM_ERROR", 7],
    ["PLATFORM_NOT_IMPLEMENTED", 1],
    ["ACCOUNT_RESTRICTED", 8],
    ["RESOURCE_ACCESS_RESTRICTED", 8],
    ["ACCOUNT_ALREADY_LINKED", 8],
    ["LINKEDIN_OPERATION_NOT_SUPPORTED", 8],
    ["CONNECTION_REQUEST_CONFLICT", 8],
    ["REAUTH_REQUIRED", 8],
    ["CHECKPOINT_EXPIRED", 9],
    ["MESSAGE_WINDOW_EXPIRED", 10],
    ["RECIPIENT_UNREACHABLE", 10],
    ["PAYMENT_FAILED", 11],
    ["SUBSCRIPTION_BUSY", 11],
    ["INTERNAL", 1],
    ["FILTER_CANDIDATES_REQUIRED", 2],
    ["BUDGET_EXHAUSTED" as ErrorCode, 13],
    ["LINKEDIN_SESSION_EVICTED" as ErrorCode, 8],
    // In the SDK taxonomy since 0.26.0: see
    // test/commands/retrieval-sdk-surface.test.ts for the arm that proves a
    // NOT_STORED 422 actually reaches this row on the wire.
    ["NOT_STORED" as ErrorCode, 14],
  ] as [ErrorCode, number][])(
    "ErrorCode %s → exit %i",
    (code, expectedExit) => {
      expect(EXIT_CODE_MAP[code]).toBe(expectedExit);
    },
  );
});

// The whole reason 13 exists. Exit 6 tells an agent "back off and retry
// later", and that is the wrong action for a ceiling the caller configured:
// the reset can be a month out, and raising the limit lifts it now. If
// BUDGET_EXHAUSTED ever collapses into 6, every agent branching on the exit
// code silently starts sleeping against a wall.
describe("lib/exit-codes — BUDGET_EXHAUSTED is not a rate limit", () => {
  const BUDGET_EXHAUSTED = "BUDGET_EXHAUSTED" as ErrorCode;

  it("does not share the rate-limited bucket", () => {
    expect(getExitCode(BUDGET_EXHAUSTED)).not.toBe(6);
  });

  it("is distinct from every code that IS rate-limited", () => {
    const rateLimited: ErrorCode[] = [
      "RATE_LIMIT_ACCOUNT",
      "RATE_LIMIT_TENANT",
      "PLATFORM_RATE_LIMIT",
      "LINKEDIN_RATE_LIMITED",
    ];
    // Control arm: those five really are all 6, so "distinct from them" is a
    // statement about BUDGET_EXHAUSTED rather than about a bucket that drifted.
    for (const code of rateLimited) expect(getExitCode(code)).toBe(6);
    expect(rateLimited.map(getExitCode)).not.toContain(getExitCode(BUDGET_EXHAUSTED));
  });

  it("is not the unmapped default either", () => {
    // Before the mapping it fell to 1, which reads as an internal failure.
    expect(getExitCode(BUDGET_EXHAUSTED)).not.toBe(getExitCode("__UNKNOWN__" as ErrorCode));
    expect(getExitCode(BUDGET_EXHAUSTED)).toBe(13);
  });
});

describe("lib/exit-codes — getExitCode", () => {
  it("returns mapped exit code for a CurviateError code", () => {
    expect(getExitCode("UNAUTHORIZED")).toBe(3);
    expect(getExitCode("NO_ACTIVE_SEAT")).toBe(5);
  });

  it("returns 1 for an unmapped/unknown code", () => {
    expect(getExitCode("__UNKNOWN__" as ErrorCode)).toBe(1);
  });
});

// ── The SDK pin gate ───────────────────────────────────────────────────────
//
// `EXIT_CODE_MAP` maps `BUDGET_EXHAUSTED` to 13, README.md documents exit 13
// with a copy-paste `case $?` branch, and none of that reaches a caller unless
// the INSTALLED `@curviate/sdk` knows the code. It does not today: the pin is
// an SDK published before the code existed, so the wire `code` decodes to
// `INTERNAL`, `INTERNAL` is retryable on a GET, and the binary answers exit 1
// after four requests. `test/commands/budget-exhausted-wire.test.ts` drives
// that end to end; this block names the cause.
//
// This block was RED ON PURPOSE until `package.json` pinned an `@curviate/sdk`
// shipping the code (curviate-sdk#29). It went green on the 0.25.0 pin bump and
// now stands as the pin-REGRESSION gate: it reads the INSTALLED package, so a
// pin moved back to an SDK that predates these codes reds here rather than
// silently decoding them to `INTERNAL` at runtime.
//
// Still read through a dynamic import and a cast rather than the static
// `ERROR_CODES` imported at the top of this file. Against a regressed pin a
// static import of an undeclared export is a `tsc` error, which would take the
// whole typecheck down instead of failing the one assertion that should fail.
// The gate has to red HERE, loudly, not in the build.
async function installedSdk(): Promise<{ ERROR_CODES?: readonly string[] }> {
  return (await import("@curviate/sdk")) as unknown as { ERROR_CODES?: readonly string[] };
}

describe("lib/exit-codes — the installed SDK carries the codes this table maps", () => {
  it("the installed @curviate/sdk exports ERROR_CODES", async () => {
    const sdk = await installedSdk();
    expect(
      sdk.ERROR_CODES,
      "the pinned @curviate/sdk predates the exported taxonomy; bump the pin",
    ).toBeDefined();
    expect(Array.isArray(sdk.ERROR_CODES)).toBe(true);
  });

  it.each(["BUDGET_EXHAUSTED", "LINKEDIN_SESSION_EVICTED"])(
    "the installed @curviate/sdk knows %s, so it decodes to itself rather than INTERNAL",
    async (code) => {
      const sdk = await installedSdk();
      expect(
        sdk.ERROR_CODES ?? [],
        `${code} is mapped in EXIT_CODE_MAP but the pinned SDK cannot decode it`,
      ).toContain(code);
    },
  );

  it("every code the installed SDK declares is mapped here", async () => {
    const sdk = await installedSdk();
    const codes = sdk.ERROR_CODES ?? [];
    // Control on the derivation: an empty read would make the filter below
    // vacuous. This is the assertion that replaced the hand-copied
    // `ALL_ERROR_CODES` array.
    expect(codes.length).toBeGreaterThan(0);
    const unmapped = codes.filter((c) => EXIT_CODE_MAP[c as ErrorCode] === undefined);
    expect(unmapped, `SDK codes with no exit code: ${unmapped.join(", ")}`).toEqual([]);
  });
});

// The tier retirement removed PREMIUM_CONFLICT from bucket 8 and TIER_NOT_ACTIVE
// from bucket 5, and added BETA_NOT_ENABLED to 5. Removing codes can empty a
// bucket, and an exit code the contract documents but nothing can ever produce
// is a lie in the README's table: a caller writes a `case 8)` arm that is dead.
// So the contract's own numbers are checked against what the map can actually
// emit, rather than only the other direction.
describe("lib/exit-codes — every documented exit code is still reachable", () => {
  it("leaves no gap: each contract code has at least one ErrorCode mapping to it", () => {
    const reachable = new Set(Object.values(EXIT_CODE_MAP));
    const unreachable = [...VALID_EXIT_CODES].filter((c) => !reachable.has(c)).sort((a, b) => a - b);
    expect(
      unreachable,
      "these exit codes are in the documented contract but no ErrorCode maps " +
        "to them any more, so a caller branching on them has a dead arm. " +
        "Either restore a mapping or retire the number from the contract and " +
        "the README table.",
    ).toEqual([]);
  });

  // POSITIVE CONTROL for the assertion above, which is an empty-set claim: a
  // `reachable` set built wrongly (from keys instead of values, say) would make
  // every documented code look unreachable and fail loudly, but a
  // VALID_EXIT_CODES that parsed to empty would make the filter trivially empty
  // and pass. Pin both sides as non-empty.
  it("compares two non-empty sets", () => {
    expect(VALID_EXIT_CODES.size).toBe(13);
    expect(new Set(Object.values(EXIT_CODE_MAP)).size).toBeGreaterThan(5);
  });

  it("every code the 0.30.0 union added is mapped, and none fell to 1 by default", () => {
    // The exhaustiveness case above proves every ErrorCode has SOME mapping.
    // It cannot prove the mapping was CHOSEN: `getExitCode` returns 1 for
    // anything unmapped, so a code left out reads as an internal failure and
    // the caller learns nothing. These twenty-one arrived in the union together
    // and every one of them decoded to INTERNAL/exit 1 before, so 1 is exactly
    // the wrong answer for each and is asserted against by name.
    const ADDED_IN_030 = [
      "ACCOUNT_DISPUTED",
      "ACCOUNT_LINKING_DISABLED",
      "ADMIN_BYPASS",
      "ALREADY_CANCELLED",
      "BILLING_CHECKOUT_FAILED",
      "BILLING_PORTAL_UNAVAILABLE",
      "CANCELLATION_ALREADY_EFFECTIVE",
      "INVALID_CANCELLATION_SOURCE",
      "NOT_FOUND",
      "PERIOD_LOCKED",
      "REACTION_NOT_FOUND",
      "SEAT_NOT_EMPTY",
      "SEAT_PROVISIONAL",
      "SUBSCRIPTION_ALREADY_EXISTS",
      "SUBSTRATE_CAP_REACHED",
      "SUBSTRATE_LINK_FAILED",
      "TRIAL_ACTIVE_SEAT_LIMIT",
      "TRIAL_EXPIRED",
      "TRIAL_IDENTITY_ALREADY_USED",
      "TRIAL_IDENTITY_UNRESOLVED",
      "TRIAL_SEAT_LIMIT",
    ] as const;

    // Positive control: they really are in the union the CLI compiles against,
    // so a stale linked SDK cannot make this block vacuous.
    const union = new Set<string>(ERROR_CODES as readonly string[]);
    const notInUnion = ADDED_IN_030.filter((c) => !union.has(c));
    expect(notInUnion, "the resolved @curviate/sdk does not export these").toEqual([]);

    const fellToDefault = ADDED_IN_030.filter((c) => EXIT_CODE_MAP[c as ErrorCode] === undefined);
    expect(
      fellToDefault,
      "these have no explicit mapping, so getExitCode answers 1 and the caller " +
        "reads a fixable refusal as an internal failure",
    ).toEqual([]);
    const mappedToOne = ADDED_IN_030.filter((c) => EXIT_CODE_MAP[c as ErrorCode] === 1);
    expect(mappedToOne, "1 is the bucket each of these just came OUT of").toEqual([]);
  });

  it("the three entitlement codes all share exit 5, and nothing else does", () => {
    // They share a bucket because the remedy has the same SHAPE, not because
    // they mean the same thing. If a future change splits one out, this reds
    // and the README's row 5 has to be rewritten with it.
    const five = ERROR_CODES.filter((c) => EXIT_CODE_MAP[c] === 5).sort();
    expect(five).toEqual(["BETA_NOT_ENABLED", "LINKEDIN_FEATURE_NOT_SUBSCRIBED", "NO_ACTIVE_SEAT"]);
  });

  it("carries neither retired code", () => {
    for (const retired of ["TIER_NOT_ACTIVE", "PREMIUM_CONFLICT"]) {
      expect(
        EXIT_CODE_MAP[retired as ErrorCode],
        `${retired} is retired from the API and must not be in the exit table`,
      ).toBeUndefined();
      expect(ERROR_CODES as readonly string[]).not.toContain(retired);
    }
    // Control on the same probe: a present code really is found by it.
    expect(EXIT_CODE_MAP["NO_ACTIVE_SEAT"]).toBe(5);
  });
});
