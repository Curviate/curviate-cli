/**
 * `--beta`, the per-invocation beta-consent override.
 *
 * Three properties, and the third is why this file is not just a parser test:
 *
 *   1. The flag PARSES to three states, not two. Absent is not the same as
 *      `--beta=false`: absent means "let the workspace setting decide", false
 *      means "override it to closed for this call". Collapsing them would make
 *      every invocation send a header and silently override consent nobody
 *      asked to override.
 *   2. An INVALID value is a usage error. citty's own parser reads
 *      `--beta=maybe` as `true` (measured, see lib/beta.ts), so a typo would
 *      opt IN, which is the one direction a consent flag must never fail in.
 *   3. The parsed value actually reaches the WIRE as a header. A parser that
 *      returns the right value and a transport that never sends it is the
 *      shape of bug nothing in a parser-only test can see, so the header
 *      assertions below drive the real client and read the real request.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  parseBetaFlag,
  setBetaOverride,
  resetBetaOverride,
  betaOverrideHeader,
  BETA_CONSENT_HEADER,
} from "../../src/lib/beta.js";

afterEach(() => {
  resetBetaOverride();
  vi.restoreAllMocks();
});

describe("parseBetaFlag — three states", () => {
  it("absent leaves the value undefined and the arguments untouched", () => {
    const r = parseBetaFlag(["sales-nav", "search", "people", "--json"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toBeUndefined();
    expect(r.rest).toEqual(["sales-nav", "search", "people", "--json"]);
  });

  it("bare --beta is true", () => {
    const r = parseBetaFlag(["--beta", "recruiter", "projects"]);
    expect(r.ok && r.value).toBe(true);
  });

  it("--beta=false is false, NOT absent", () => {
    const r = parseBetaFlag(["--beta=false", "recruiter", "projects"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The distinction this whole three-state design exists for.
    expect(r.value).toBe(false);
    expect(r.value).not.toBeUndefined();
  });

  it("accepts the same grammar the API's own header accepts", () => {
    for (const token of ["true", "TRUE", "1", "on", "yes", " YES "]) {
      const r = parseBetaFlag([`--beta=${token}`]);
      expect(r.ok && r.value, `--beta=${token}`).toBe(true);
    }
    for (const token of ["false", "FALSE", "0", "off", "no"]) {
      const r = parseBetaFlag([`--beta=${token}`]);
      expect(r.ok && r.value, `--beta=${token}`).toBe(false);
    }
  });

  it("--no-beta is false", () => {
    const r = parseBetaFlag(["--no-beta"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toBe(false);
  });

  it("strips the flag so it never reaches the argument parser", () => {
    // citty pushes the VALUE of an unrecognised `--beta=<x>` into positionals,
    // where it becomes an unexpected extra argument. Stripping is what keeps
    // the flag out of every command's positional binding.
    const r = parseBetaFlag(["--beta=true", "message", "chat_1", "hello"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rest).toEqual(["message", "chat_1", "hello"]);
    expect(r.rest.join(" ")).not.toContain("beta");
  });

  it("last occurrence wins", () => {
    const r = parseBetaFlag(["--beta", "--beta=false"]);
    expect(r.ok && r.value).toBe(false);
  });
});

describe("parseBetaFlag — an invalid value is a usage error, never an opt-in", () => {
  it.each(["maybe", "2", "yep", "", "TRUEISH"])("rejects --beta=%s", (token) => {
    const r = parseBetaFlag([`--beta=${token}`, "account", "list"]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("--beta must be one of");
    // The rejected value is echoed so the operator can see their typo.
    expect(r.error).toContain(`"${token}"`);
  });

  // POSITIVE CONTROL on the same probe. Every case above asserts `ok === false`,
  // and a parser that rejected everything would satisfy all of them; this
  // proves the same call path accepts a good value.
  it("the same call path accepts a valid value", () => {
    expect(parseBetaFlag(["--beta=true"]).ok).toBe(true);
  });

  it("does not read a --beta-shaped token after a bare -- as a flag", () => {
    // A message body can legitimately contain the text `--beta=maybe`. Past the
    // end-of-flags marker it is data, and refusing it would make a valid
    // message unsendable.
    const r = parseBetaFlag(["message", "chat_1", "--", "--beta=maybe"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toBeUndefined();
    expect(r.rest).toEqual(["message", "chat_1", "--", "--beta=maybe"]);
  });
});

describe("betaOverrideHeader — what goes on the wire", () => {
  beforeEach(() => resetBetaOverride());

  it("sends no header at all when the flag was absent", () => {
    setBetaOverride(undefined);
    // Not `{"X-Curviate-Beta": ""}` and not `"false"`: an invocation without
    // the flag must leave the workspace setting to decide, exactly as before
    // the flag existed.
    expect(betaOverrideHeader()).toEqual({});
  });

  it("sends true", () => {
    setBetaOverride(true);
    expect(betaOverrideHeader()).toEqual({ [BETA_CONSENT_HEADER]: "true" });
  });

  it("sends false, which is a real override rather than a no-op", () => {
    setBetaOverride(false);
    expect(betaOverrideHeader()).toEqual({ [BETA_CONSENT_HEADER]: "false" });
  });

  it("spells the header the way the API reads it", () => {
    expect(BETA_CONSENT_HEADER).toBe("X-Curviate-Beta");
  });
});

describe("the header reaches a real request through the client", () => {
  /** Capture what the SDK's transport actually hands to fetch. */
  async function capture(): Promise<{ headers: Record<string, string>; url: string }> {
    const seen: { headers: Record<string, string>; url: string }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const headers: Record<string, string> = {};
      const raw = init?.headers;
      if (raw instanceof Headers) raw.forEach((v, k) => (headers[k] = v));
      else if (Array.isArray(raw)) for (const [k, v] of raw) headers[String(k)] = String(v);
      else if (raw) Object.assign(headers, raw);
      seen.push({ headers, url: String(input) });
      return Promise.resolve(
        new Response(JSON.stringify({ items: [], cursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch);

    const { createClient } = await import("../../src/lib/client.js");
    const client = createClient({ apiKey: "cvt_test_beta", baseUrl: "https://api.invalid" });
    await client.accounts.list();
    expect(seen).toHaveLength(1);
    return seen[0]!;
  }

  /** Header lookup is case-insensitive, because a transport may normalise. */
  function header(headers: Record<string, string>, name: string): string | undefined {
    const hit = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
    return hit === undefined ? undefined : headers[hit];
  }

  it("--beta puts X-Curviate-Beta: true on the request", async () => {
    setBetaOverride(true);
    const { headers } = await capture();
    expect(header(headers, BETA_CONSENT_HEADER)).toBe("true");
  });

  it("--beta=false puts X-Curviate-Beta: false on the request", async () => {
    setBetaOverride(false);
    const { headers } = await capture();
    expect(header(headers, BETA_CONSENT_HEADER)).toBe("false");
  });

  it("no flag means no header on the request", async () => {
    setBetaOverride(undefined);
    const { headers } = await capture();
    // POSITIVE CONTROL in the same assertion pair: the request really was made
    // and really did carry headers, so a missing beta header means absent
    // rather than "nothing was captured".
    expect(header(headers, "authorization")).toBe("Bearer cvt_test_beta");
    expect(header(headers, BETA_CONSENT_HEADER)).toBeUndefined();
  });

  it("never displaces the credential or the content type", async () => {
    // The header is merged in a wrapper around the SDK's own init. If that
    // merge ever replaced the header object instead of extending it, the
    // Authorization header would vanish and every call would 401.
    setBetaOverride(true);
    const { headers } = await capture();
    expect(header(headers, "authorization")).toBe("Bearer cvt_test_beta");
    expect(header(headers, BETA_CONSENT_HEADER)).toBe("true");
  });
});

describe("regressions found in review", () => {
  it("--no-beta with a value is a usage error, not a silent no-op", () => {
    // It used to fall through to the argument parser, which accepted it as the
    // negation of the declared `beta` flag while nothing read the result: the
    // caller's explicit "beta off" vanished with no error and no header. Both
    // spellings, because `--no-beta=false` is the contradictory one and
    // `--no-beta=true` the meaningless one, and guessing either is wrong.
    for (const token of ["true", "false", ""]) {
      const r = parseBetaFlag([`--no-beta=${token}`, "account", "list"]);
      expect(r.ok, `--no-beta=${token}`).toBe(false);
      if (r.ok) continue;
      expect(r.error).toContain("--no-beta takes no value");
    }
    // Control on the same path: the valueless form still works.
    const ok = parseBetaFlag(["--no-beta"]);
    expect(ok.ok && ok.value).toBe(false);
  });
});
