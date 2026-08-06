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

  // §F shape: field + value present (a filter value took the id fast path).
  const filterNotice = {
    code: "FILTER_VALUE_UNCHECKED",
    message: "The value was treated as an id and was not looked up.",
    field: "industry",
    value: "42",
  };

  // §G shape: page-scoped, no field/value (an anonymised-results page).
  const pageNotice = {
    code: "ALL_RESULTS_HIDDEN",
    message: "Every result on this page is hidden from the connected account.",
  };

  it("JSON mode: a §F-shaped notice (field + value) passes through the array intact", () => {
    const data = { items: [], cursor: null, notices: [filterNotice] };
    renderSuccess(data, { json: true, isTTY: false, fields: undefined }, mockOut as never);
    expect(JSON.parse(stdoutLines.join(""))).toEqual(data);
  });

  it("JSON mode: a §G-shaped notice (no field/value) passes through the array intact", () => {
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

  it("human mode: a §F-shaped notice renders visibly, above an empty result list, not blank", () => {
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

  it("human mode: a §G-shaped notice (no field/value) renders visibly, no blank/malformed line", () => {
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

  it("human mode: an all-hidden page (empty items + §G notice) still surfaces the notice, not just '(no items)'", () => {
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
