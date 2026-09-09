/**
 * `account link --linkedin-premium`, the per-connect premium narrowing.
 *
 * ## Why the empty-string case has its own test
 *
 * The flag exists because omitting it makes the connect ask for EVERY product,
 * and LinkedIn then activates Sales Navigator over Recruiter when an account
 * holds both. So the failure mode is not a rejected request, it is a silently
 * WIDENED one: the caller meant `recruiter`, the value did not arrive, and the
 * connect succeeded with the wrong surface attached. Nothing downstream reports
 * that.
 *
 * The guard was first written as `if (flags["linkedin-premium"])`, which is
 * falsy for `""` — and `""` is exactly what `--linkedin-premium="$PREF"`
 * expands to when `PREF` is unset, i.e. the single most likely accidental
 * input. It took that path straight past the validation it was meant to hit.
 * A mutation reverting the fix went unnoticed by the whole suite, which is why
 * this file exists.
 */
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";

function makeClient() {
  return { accounts: { update: vi.fn() }, auth: { intent: vi.fn() } };
}
function makeOut() {
  return { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
}
function linkArgs(extra: Record<string, unknown>) {
  return {
    "seat-id": "seat_1",
    "auth-method": "cookie",
    "li-at": "AQEDaTest",
    "user-agent": "Mozilla/5.0",
    json: true,
    ...extra,
  } as never;
}

describe("account link --linkedin-premium", () => {
  it.each(["sales_navigator", "recruiter"] as const)(
    "forwards %s as linkedin_premium on the connect body",
    async (value) => {
      const { runAccountLink } = await import("../../src/commands/account.js");
      const client = makeClient();
      (client.auth.intent as Mock).mockResolvedValue({ object: "account" });
      const out = makeOut();

      await runAccountLink(client as never, linkArgs({ "linkedin-premium": value }), out, {
        isTTY: false,
      });

      expect(client.auth.intent).toHaveBeenCalledWith(
        expect.objectContaining({ linkedin_premium: value }),
      );
    },
  );

  it("omits the field entirely when the flag is absent", async () => {
    // The absent case must send NO field, not an empty one: the server reads
    // absence as "ask for every product", which is the documented default.
    const { runAccountLink } = await import("../../src/commands/account.js");
    const client = makeClient();
    (client.auth.intent as Mock).mockResolvedValue({ object: "account" });
    const out = makeOut();

    await runAccountLink(client as never, linkArgs({}), out, { isTTY: false });

    const body = (client.auth.intent as Mock).mock.calls[0]![0] as Record<string, unknown>;
    // Positive control in the same read: the call really happened and really
    // carried a body, so "no linkedin_premium key" means absent rather than
    // "nothing was captured".
    expect(body["auth_method"]).toBe("cookie");
    expect(body).not.toHaveProperty("linkedin_premium");
  });

  it.each(["", "sales-navigator", "SALES_NAVIGATOR", "both", "premium"])(
    "refuses %o with exit 2 and never calls the API",
    async (value) => {
      const { runAccountLink } = await import("../../src/commands/account.js");
      const client = makeClient();
      (client.auth.intent as Mock).mockResolvedValue({ object: "account" });
      const out = makeOut();
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
        throw new Error(`process.exit(${code})`);
      });

      try {
        await runAccountLink(client as never, linkArgs({ "linkedin-premium": value }), out, {
          isTTY: false,
        });
        expect.unreachable("expected a usage exit");
      } catch (e) {
        expect((e as Error).message).toContain("process.exit(2)");
      } finally {
        exitSpy.mockRestore();
      }

      // THE assertion for the widening class: the connect must not have gone
      // out. An exit-code-only check would be satisfied by a build that
      // connected with the wrong product set and complained afterwards.
      expect(client.auth.intent).not.toHaveBeenCalled();
      const stderr = (out.stderr.write as Mock).mock.calls.map((c) => c[0] as string).join("");
      expect(stderr).toContain("--linkedin-premium must be one of: sales_navigator, recruiter");
    },
  );

  it("under --preview it renders instead of exiting, and omits the bad value", async () => {
    // buildAuthBody's contract is that a client-side render never prompts and
    // never exits; the sibling user-agent guard carries the same carve-out.
    // A render that called process.exit would make `--preview` unusable for
    // the exact case someone reaches for it: checking what they typed.
    const { runAccountLink } = await import("../../src/commands/account.js");
    const client = makeClient();
    const out = makeOut();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });

    try {
      await runAccountLink(
        client as never,
        linkArgs({ "linkedin-premium": "typo", preview: true }),
        out,
        { isTTY: false },
      );
    } finally {
      exitSpy.mockRestore();
    }

    expect(exitSpy).not.toHaveBeenCalled();
    expect(client.auth.intent).not.toHaveBeenCalled();
    const stdout = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    // Something was rendered, and it does not claim the rejected value would
    // be sent.
    expect(stdout.length).toBeGreaterThan(0);
    expect(stdout).not.toContain("typo");
  });
});
