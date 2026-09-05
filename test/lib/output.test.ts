import { describe, it, expect, beforeEach } from "vitest";
import { CurviateError } from "@curviate/sdk";
import {
  isJsonMode,
  renderSuccess,
  renderError,
  projectFields,
} from "../../src/lib/output.js";

describe("lib/output — isJsonMode", () => {
  it("returns true when --json flag is set", () => {
    expect(isJsonMode({ json: true, isTTY: true })).toBe(true);
  });

  it("returns true when stdout is not a TTY (even without --json)", () => {
    expect(isJsonMode({ json: false, isTTY: false })).toBe(true);
  });

  it("returns false when stdout is a TTY and --json is not set", () => {
    expect(isJsonMode({ json: false, isTTY: true })).toBe(false);
  });

  it("--json flag overrides TTY detection (forces JSON on TTY)", () => {
    expect(isJsonMode({ json: true, isTTY: true })).toBe(true);
  });
});

describe("lib/output — projectFields", () => {
  const item = { id: "p_1", name: "Alice", profile: { headline: "Engineer" }, extra: 42 };

  it("projects single field", () => {
    expect(projectFields(item, ["id"])).toEqual({ id: "p_1" });
  });

  it("projects multiple fields", () => {
    expect(projectFields(item, ["id", "name"])).toEqual({ id: "p_1", name: "Alice" });
  });

  it("omits missing paths (not null)", () => {
    expect(projectFields(item, ["id", "missing"])).toEqual({ id: "p_1" });
  });

  it("handles dot-path projection (one level)", () => {
    expect(projectFields(item, ["id", "profile.headline"])).toEqual({
      id: "p_1",
      "profile.headline": "Engineer",
    });
  });

  it("returns full object when fields list is empty array", () => {
    // Empty fields array → return as-is (caller validates --fields "")
    expect(projectFields(item, [])).toEqual(item);
  });

  // ---------------------------------------------------------------------
  // `result[field] = value` builds a fresh plain `{}`. `field` comes from
  // the user-typed `--fields` flag, so a genuine response field literally
  // named `__proto__` (JSON.parse creates it as a real own property, not
  // via the prototype setter) hit the inherited accessor on write instead
  // of creating an own key -- reassigning `result`'s prototype and
  // silently dropping the projected value, exit 0, no warning. Same defect
  // class as config.ts's `redacted[name] = ...` (M1).
  // ---------------------------------------------------------------------
  it("a response field literally named __proto__ projects, not silently dropped", () => {
    const withProtoField = JSON.parse('{"id":"p_1","__proto__":"legit-value"}') as Record<
      string,
      unknown
    >;
    const result = projectFields(withProtoField, ["id", "__proto__"]);
    expect(Object.keys(result).sort()).toEqual(["__proto__", "id"]);
    expect(result["__proto__"]).toBe("legit-value");
  });

  it("--fields constructor on an object without that field omits it, never leaks the inherited Function", () => {
    const result = projectFields(item, ["id", "constructor"]);
    expect(Object.keys(result)).toEqual(["id"]);
    expect(result["constructor"]).toBeUndefined();
  });
});

describe("lib/output — renderSuccess (JSON mode)", () => {
  let stdoutLines: string[];
  let stderrLines: string[];

  beforeEach(() => {
    stdoutLines = [];
    stderrLines = [];
  });

  const mockOut = {
    stdout: { write: (s: string) => { stdoutLines.push(s); } },
    stderr: { write: (s: string) => { stderrLines.push(s); } },
  };

  it("writes verbatim SDK response as JSON to stdout in JSON mode", () => {
    const data = { items: [{ id: "p_1" }], cursor: null };
    renderSuccess(data, { json: true, isTTY: false, fields: undefined }, mockOut as never);
    expect(JSON.parse(stdoutLines.join(""))).toEqual(data);
    expect(stderrLines.join("")).toBe("");
  });

  it("applies --fields projection before serialization", () => {
    const data = { id: "p_1", name: "Alice", extra: 99 };
    renderSuccess(data, { json: true, isTTY: false, fields: "id,name" }, mockOut as never);
    const parsed = JSON.parse(stdoutLines.join("")) as unknown;
    expect(parsed).toEqual({ id: "p_1", name: "Alice" });
  });

  it("projects each item in an array response", () => {
    const data = { items: [{ id: "p_1", name: "Alice", extra: 1 }, { id: "p_2", name: "Bob", extra: 2 }], cursor: null };
    renderSuccess(data, { json: true, isTTY: false, fields: "id" }, mockOut as never);
    const parsed = JSON.parse(stdoutLines.join("")) as { items: unknown[] };
    expect(parsed.items).toEqual([{ id: "p_1" }, { id: "p_2" }]);
  });

  it("human mode writes to stdout (not stderr)", () => {
    const data = { id: "p_1", name: "Alice" };
    renderSuccess(data, { json: false, isTTY: true, fields: undefined }, mockOut as never);
    // Human output goes to stdout, not stderr
    expect(stdoutLines.join("").length).toBeGreaterThan(0);
    expect(stderrLines.join("")).toBe("");
  });
});

describe("lib/output — renderSuccess --fields unknown-field warning", () => {
  let stdoutLines: string[];
  let stderrLines: string[];

  beforeEach(() => {
    stdoutLines = [];
    stderrLines = [];
  });

  const mockOut = {
    stdout: { write: (s: string) => { stdoutLines.push(s); } },
    stderr: { write: (s: string) => { stderrLines.push(s); } },
  };

  it("warns (stderr) when EVERY requested field is unknown on a single object, naming them + the available keys", () => {
    // The observed live case: relations item keys are member_id/first_name,
    // but the agent asked for id,full_name.
    const data = { member_id: "ACo1", first_name: "Ada" };
    renderSuccess(data, { json: true, isTTY: false, fields: "id,full_name" }, mockOut as never);
    const stderr = stderrLines.join("");
    expect(stderr).toMatch(/fields/i);
    expect(stderr).toContain("id");
    expect(stderr).toContain("full_name");
    // Available keys are listed to guide the next attempt.
    expect(stderr).toContain("member_id");
    expect(stderr).toContain("first_name");
    // stdout is unaffected: projection still runs (nothing matched → {}).
    expect(JSON.parse(stdoutLines.join(""))).toEqual({});
  });

  it("checks the FIRST item of an { items: [...] } envelope", () => {
    const data = { items: [{ member_id: "ACo1", first_name: "Ada" }], cursor: null };
    renderSuccess(data, { json: true, isTTY: false, fields: "id" }, mockOut as never);
    const stderr = stderrLines.join("");
    expect(stderr).toContain("id");
    expect(stderr).toContain("member_id");
  });

  it("checks the first element of a bare array response", () => {
    const data = [{ member_id: "ACo1" }, { member_id: "ACo2" }];
    renderSuccess(data, { json: true, isTTY: false, fields: "bogus" }, mockOut as never);
    expect(stderrLines.join("")).toContain("bogus");
  });

  it("warns about ONLY the unknown subset when some fields match", () => {
    const data = { member_id: "ACo1", first_name: "Ada" };
    renderSuccess(data, { json: true, isTTY: false, fields: "member_id,bogus" }, mockOut as never);
    const stderr = stderrLines.join("");
    expect(stderr).toContain("bogus");
    // The matched field must NOT be reported as unknown.
    expect(stderr).not.toMatch(/unknown[^\n]*member_id/i);
    // stdout still projects the known field.
    expect(JSON.parse(stdoutLines.join(""))).toEqual({ member_id: "ACo1" });
  });

  it("does NOT warn when every requested field matches", () => {
    const data = { id: "p_1", name: "Alice", extra: 1 };
    renderSuccess(data, { json: true, isTTY: false, fields: "id,name" }, mockOut as never);
    expect(stderrLines.join("")).toBe("");
  });

  it("a dot-path whose TOP-LEVEL key exists is NOT flagged", () => {
    const data = { id: "p_1", profile: { headline: "Eng" } };
    renderSuccess(data, { json: true, isTTY: false, fields: "profile.headline" }, mockOut as never);
    expect(stderrLines.join("")).toBe("");
  });

  it("does NOT warn on an empty list (no first item to compare against)", () => {
    const data = { items: [], cursor: null };
    renderSuccess(data, { json: true, isTTY: false, fields: "id" }, mockOut as never);
    expect(stderrLines.join("")).toBe("");
  });

  it("does NOT warn when no --fields is requested", () => {
    const data = { member_id: "ACo1" };
    renderSuccess(data, { json: true, isTTY: false, fields: undefined }, mockOut as never);
    expect(stderrLines.join("")).toBe("");
  });

  it("the warning is checked against the SLIM projection when a slimmer is applied (not the raw response)", () => {
    // slim exposes member_id; the raw (pre-slim) had a nested user.id. A field
    // that exists only pre-slim is correctly flagged as unknown on the output.
    const raw = { user: { id: "ACo1" }, member_id: "ACo1" };
    const slim = (d: unknown) => ({ member_id: (d as { member_id: string }).member_id });
    renderSuccess(raw, { json: true, isTTY: false, fields: "user.id", slim }, mockOut as never);
    expect(stderrLines.join("")).toContain("user.id");
  });
});

describe("lib/output — renderSuccess renders notices[] (filter fast-path and anonymised-page shapes)", () => {
  let stdoutLines: string[];
  let stderrLines: string[];

  beforeEach(() => {
    stdoutLines = [];
    stderrLines = [];
  });

  const mockOut = {
    stdout: { write: (s: string) => { stdoutLines.push(s); } },
    stderr: { write: (s: string) => { stderrLines.push(s); } },
  };

  // filter-value shape: field + value present (a filter value took the id fast path).
  const filterNotice = {
    code: "FILTER_VALUE_UNCHECKED",
    message: "The value was treated as an id and was not looked up.",
    field: "industry",
    value: "42",
  };

  // page-scope shape: page-scoped, no field/value (an anonymised-results page).
  const pageNotice = {
    code: "ALL_RESULTS_HIDDEN",
    message: "Every result on this page is hidden from the connected account.",
  };

  it("JSON mode: a filter-value-shaped notice (field + value) passes through the array intact", () => {
    const data = { items: [], cursor: null, notices: [filterNotice] };
    renderSuccess(data, { json: true, isTTY: false, fields: undefined }, mockOut as never);
    expect(JSON.parse(stdoutLines.join(""))).toEqual(data);
  });

  it("JSON mode: a page-scope-shaped notice (no field/value) passes through the array intact", () => {
    const data = { items: [{ id: "p_1" }], cursor: null, notices: [pageNotice] };
    renderSuccess(data, { json: true, isTTY: false, fields: undefined }, mockOut as never);
    expect(JSON.parse(stdoutLines.join(""))).toEqual(data);
  });

  it("JSON mode: notices survive a --fields projection on the items", () => {
    const data = { items: [{ id: "p_1", extra: 1 }], cursor: null, notices: [pageNotice] };
    renderSuccess(data, { json: true, isTTY: false, fields: "id" }, mockOut as never);
    const parsed = JSON.parse(stdoutLines.join("")) as { items: unknown[]; notices: unknown[] };
    expect(parsed.items).toEqual([{ id: "p_1" }]);
    expect(parsed.notices).toEqual([pageNotice]);
  });

  it("human mode: a filter-value-shaped notice renders visibly, above an empty result list, not blank", () => {
    const data = { items: [], cursor: null, notices: [filterNotice] };
    renderSuccess(data, { json: false, isTTY: true, fields: undefined }, mockOut as never);
    const rendered = stdoutLines.join("");
    expect(rendered).toContain("FILTER_VALUE_UNCHECKED");
    expect(rendered).toContain("The value was treated as an id and was not looked up.");
    expect(rendered).toContain("field: industry");
    expect(rendered).toContain("value: 42");
    expect(rendered).toContain("(no items)");
    // Notice line precedes the (empty) results, per "surfaced first".
    expect(rendered.indexOf("FILTER_VALUE_UNCHECKED")).toBeLessThan(rendered.indexOf("(no items)"));
  });

  it("human mode: a page-scope-shaped notice (no field/value) renders visibly, no blank/malformed line", () => {
    const data = { items: [{ id: "p_1", full_name: "Alice" }], cursor: null, notices: [pageNotice] };
    renderSuccess(data, { json: false, isTTY: true, fields: undefined }, mockOut as never);
    const rendered = stdoutLines.join("");
    expect(rendered).toContain("ALL_RESULTS_HIDDEN");
    expect(rendered).toContain("Every result on this page is hidden from the connected account.");
    // No stray "(field: undefined)" / "(value: undefined)" artifact from the optional keys.
    expect(rendered).not.toContain("undefined");
    expect(rendered).not.toContain("(field:");
    expect(rendered).not.toContain("(value:");
  });

  it("human mode: an all-hidden page (empty items + page-scope notice) still surfaces the notice, not just '(no items)'", () => {
    const data = { items: [], cursor: null, notices: [pageNotice] };
    renderSuccess(data, { json: false, isTTY: true, fields: undefined }, mockOut as never);
    const rendered = stdoutLines.join("");
    expect(rendered).toContain("ALL_RESULTS_HIDDEN");
    expect(rendered).toContain("(no items)");
  });

  it("human mode: multiple notices each render as their own line", () => {
    const data = { items: [], cursor: null, notices: [filterNotice, pageNotice] };
    renderSuccess(data, { json: false, isTTY: true, fields: undefined }, mockOut as never);
    const rendered = stdoutLines.join("");
    expect(rendered).toContain("FILTER_VALUE_UNCHECKED");
    expect(rendered).toContain("ALL_RESULTS_HIDDEN");
  });

  it("REGRESSION: JSON mode with no notices is byte-identical to the pre-notices response", () => {
    const data = { items: [{ id: "p_1" }], cursor: null };
    renderSuccess(data, { json: true, isTTY: false, fields: undefined }, mockOut as never);
    expect(stdoutLines.join("")).toBe(JSON.stringify(data) + "\n");
  });

  it("REGRESSION: human mode with no notices key renders byte-identically to before notices existed", () => {
    const withoutNotices = { items: [{ id: "p_1" }], cursor: null };
    renderSuccess(withoutNotices, { json: false, isTTY: true, fields: undefined }, mockOut as never);
    const rendered = stdoutLines.join("");
    // Exactly what renderHuman produced pre-notices: the single item's key=value
    // lines, nothing prepended, nothing about "notices" anywhere.
    expect(rendered).toBe("id: p_1\n");
    expect(rendered).not.toContain("notice");
  });

  it("REGRESSION: human mode with an empty items list and no notices still renders '(no items)' alone", () => {
    const data = { items: [], cursor: null };
    renderSuccess(data, { json: false, isTTY: true, fields: undefined }, mockOut as never);
    expect(stdoutLines.join("")).toBe("(no items)\n");
  });
});

describe("lib/output — renderError", () => {
  let stdoutLines: string[];
  let stderrLines: string[];

  beforeEach(() => {
    stdoutLines = [];
    stderrLines = [];
  });

  const mockOut = {
    stdout: { write: (s: string) => { stdoutLines.push(s); } },
    stderr: { write: (s: string) => { stderrLines.push(s); } },
  };

  it("JSON mode: prints {error: <toJSON()>} to stdout, one-liner to stderr", () => {
    const err = new CurviateError({
      code: "TIER_NOT_ACTIVE",
      message: "Tier not active",
      userFixable: true,
      retryLikelyToSucceed: false,
      requiredTier: "sn",
    });
    renderError(err, { json: true, isTTY: false }, mockOut as never);
    const parsed = JSON.parse(stdoutLines.join("")) as { error: unknown };
    expect(parsed).toHaveProperty("error");
    const errJson = parsed.error as Record<string, unknown>;
    expect(errJson["code"]).toBe("TIER_NOT_ACTIVE");
    expect(errJson["requiredTier"]).toBe("sn");
    // stderr has one-liner
    expect(stderrLines.join("").length).toBeGreaterThan(0);
  });

  it("JSON mode: error envelope never contains the API key", () => {
    const sentinel = "rdc_live_SENTINEL_SHOULD_NOT_APPEAR";
    const err = new CurviateError({
      code: "UNAUTHORIZED",
      message: "unauthorized",
      userFixable: false,
      retryLikelyToSucceed: false,
    });
    renderError(err, { json: true, isTTY: false }, mockOut as never);
    const combined = stdoutLines.join("") + stderrLines.join("");
    expect(combined.includes(sentinel)).toBe(false);
  });

  it("human mode: stdout is empty, stderr has code and message", () => {
    const err = new CurviateError({
      code: "RATE_LIMIT_ACCOUNT",
      message: "Rate limit exceeded",
      userFixable: false,
      retryLikelyToSucceed: true,
      retryAfterMs: 2000,
    });
    renderError(err, { json: false, isTTY: true }, mockOut as never);
    expect(stdoutLines.join("")).toBe("");
    const stderr = stderrLines.join("");
    expect(stderr).toContain("RATE_LIMIT_ACCOUNT");
  });

  // ── Account-safety refusals ──────────────────────────────────────────────
  //
  // The SDK pin is still on a version whose `CurviateError` has none of these
  // fields, so the error is stubbed at the one seam `renderError` actually
  // uses: it calls `err.toJSON()` and prints from the result. The stubbed JSON
  // is the exact shape the SDK emits, pinned on the other side by
  // curviate-sdk's own `carries the payload on toJSON()` test. On the pin bump
  // these become real `new CurviateError(...)` calls and the cast goes.
  function stubError(json: Record<string, unknown>): CurviateError {
    return { toJSON: () => json } as unknown as CurviateError;
  }

  const BREACH = {
    code: "BUDGET_EXHAUSTED",
    message: "The profile_views budget for this account is spent.",
    retryHint: null,
    userFixable: true,
    retryLikelyToSucceed: false,
    budgetRow: "profile_views",
    resetAt: "2026-09-06T00:00:00.000Z",
    safetyHint: {
      parameter: "profile_views.ceiling",
      message: "Raising the ceiling raises the effective ceiling by the same factor.",
    },
    safetyReason: "ceiling",
    blocked: true,
  };

  it("human mode: a budget breach names the row, the reset and the parameter", () => {
    renderError(stubError({ ...BREACH }), { json: false, isTTY: true }, mockOut as never);
    const stderr = stderrLines.join("");
    expect(stderr).toContain("Safety budget: profile_views is at its ceiling");
    expect(stderr).toContain("Resets at: 2026-09-06T00:00:00.000Z");
    expect(stderr).toContain("Change: profile_views.ceiling");
    expect(stderr).toContain("Raising the ceiling raises the effective ceiling");
    // NOT the paused-row sentence: same wire field, different condition, and
    // "other rows still work" is false advice for a ceiling you configured.
    expect(stderr).not.toContain("Paused budget row");
  });

  it("human mode: an activity-window refusal says so rather than 'at its ceiling'", () => {
    renderError(
      stubError({
        ...BREACH,
        safetyReason: "activity_window",
        safetyHint: { parameter: "activity_window_start", message: "The account works 07:00-22:00." },
      }),
      { json: false, isTTY: true },
      mockOut as never,
    );
    const stderr = stderrLines.join("");
    expect(stderr).toContain("outside its activity window");
    expect(stderr).not.toContain("at its ceiling");
    expect(stderr).toContain("Change: activity_window_start");
  });

  // `resetAt: null` is "no clock frees this", a different sentence from an
  // unknown reset, and it must not render as the string "null".
  //
  // NULL HAS TWO CAUSES, per the amended safety contract: the invitation gauge and
  // an InMail credit exhaustion. The first pass named only the gauge, so a
  // spent credit pool told the operator the invitation backlog would clear --
  // the wrong place entirely. One arm each, and each asserts it does NOT get
  // the other's sentence.
  it("human mode: a null resetAt on the gauge names the backlog, not a bogus instant", () => {
    renderError(
      stubError({ ...BREACH, budgetRow: "pending_invites", resetAt: null }),
      { json: false, isTTY: true },
      mockOut as never,
    );
    const stderr = stderrLines.join("");
    expect(stderr).toContain("frees when the backlog clears");
    expect(stderr).not.toContain("regrants credits");
    expect(stderr).not.toContain("Resets at");
    expect(stderr).not.toContain("null");
  });

  it("human mode: a null resetAt on InMail credits names the credits, not the backlog", () => {
    renderError(
      stubError({
        ...BREACH,
        budgetRow: "inmail",
        resetAt: null,
        safetyHint: { parameter: "posture", message: "The credit pool is spent." },
      }),
      { json: false, isTTY: true },
      mockOut as never,
    );
    const stderr = stderrLines.join("");
    expect(stderr).toContain("frees when LinkedIn regrants credits");
    // The bug this arm exists for: it used to say the backlog would clear.
    expect(stderr).not.toContain("backlog");
    expect(stderr).not.toContain("Resets at");
    expect(stderr).not.toContain("null");
  });

  it("human mode: a PAUSED row gets the switch-work sentence, not the budget one", () => {
    renderError(
      stubError({
        code: "PLATFORM_RATE_LIMIT",
        message: "paused",
        retryHint: null,
        userFixable: false,
        retryLikelyToSucceed: false,
        budgetRow: "connection_requests_no_note",
        retryAfterSeconds: 3600,
      }),
      { json: false, isTTY: true },
      mockOut as never,
    );
    const stderr = stderrLines.join("");
    expect(stderr).toContain("Paused budget row: connection_requests_no_note for 3600s");
    expect(stderr).toContain("other rows on this account still work");
    expect(stderr).not.toContain("Safety budget");
  });

  // CONTROL. Without this, every "not.toContain" above could pass because the
  // safety block never runs at all.
  it("human mode: an error with no budget row prints neither safety sentence", () => {
    renderError(
      stubError({
        code: "RATE_LIMIT_ACCOUNT",
        message: "slow down",
        retryHint: null,
        userFixable: false,
        retryLikelyToSucceed: true,
        retryAfterMs: 2000,
      }),
      { json: false, isTTY: true },
      mockOut as never,
    );
    const stderr = stderrLines.join("");
    expect(stderr).not.toContain("Safety budget");
    expect(stderr).not.toContain("Paused budget row");
    // Positive control on the same path: the renderer did run and did print.
    expect(stderr).toContain("Retry after: 2000ms");
  });

  it("JSON mode: the whole safety payload rides the envelope untouched", () => {
    renderError(stubError({ ...BREACH }), { json: true, isTTY: false }, mockOut as never);
    const parsed = JSON.parse(stdoutLines.join("")) as { error: Record<string, unknown> };
    expect(parsed.error).toMatchObject({
      code: "BUDGET_EXHAUSTED",
      budgetRow: "profile_views",
      resetAt: "2026-09-06T00:00:00.000Z",
      safetyReason: "ceiling",
      blocked: true,
    });
    expect(parsed.error["safetyHint"]).toEqual(BREACH.safetyHint);
  });

  it("JSON mode: a null resetAt survives as null, not as an absent key", () => {
    renderError(
      stubError({ ...BREACH, budgetRow: "pending_invites", resetAt: null }),
      { json: true, isTTY: false },
      mockOut as never,
    );
    const parsed = JSON.parse(stdoutLines.join("")) as { error: Record<string, unknown> };
    expect(parsed.error).toHaveProperty("resetAt", null);
  });

  it("JSON mode: rate limit error carries retryAfterMs in envelope", () => {
    const err = new CurviateError({
      code: "RATE_LIMIT_ACCOUNT",
      message: "Rate limit",
      userFixable: false,
      retryLikelyToSucceed: true,
      retryAfterMs: 2000,
    });
    renderError(err, { json: true, isTTY: false }, mockOut as never);
    const parsed = JSON.parse(stdoutLines.join("")) as { error: Record<string, unknown> };
    expect(parsed.error["retryAfterMs"]).toBe(2000);
  });
});
