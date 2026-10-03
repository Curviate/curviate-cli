/**
 * Single-cue regression, exercised through the real production wiring
 * (`account link` -> `resolveCredentialIO`'s own `readSingleLine` default ->
 * `resolveSecret` -> `readlineSync`) rather than through a test-injected
 * `readSingleLine` stub, which would bypass the exact bug qa found: the cue
 * printed twice on a real terminal because BOTH the resolver's own
 * `out.stderr.write(STDIN_TTY_CUE)` AND the default reader (which forwarded
 * the cue text straight through to `readlineSync`, itself writing its
 * `prompt` argument to stderr) rendered it.
 *
 * Isolated in its own file — mocking `lib/readline.js` at module scope here
 * would be unused noise in `account-credentials.test.ts`, where every other
 * TTY-stdin test injects its own `readSingleLine`/`readline` stub and never
 * touches the real default.
 */
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";

vi.mock("../../src/lib/readline.js", () => ({
  readlineSync: vi.fn(async () => "TTY_PWD"),
}));

function makeClient() {
  return { accounts: { update: vi.fn() }, auth: { intent: vi.fn() } };
}
function makeOut() {
  return { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
}

describe("account credentials — single cue via the real production default chain (no readSingleLine override)", () => {
  it("password: --password-stdin on a TTY writes the cue exactly once and calls the underlying readlineSync with an EMPTY prompt", async () => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const { readlineSync } = await import("../../src/lib/readline.js");
    const client = makeClient();
    (client.auth.intent as Mock).mockResolvedValue({ object: "account" });
    const out = makeOut();

    await runAccountLink(
      client as never,
      { "seat-id": "seat_1", "auth-method": "credentials", country: "US", email: "a@b.c", "password-stdin": true, json: true } as never,
      out,
      { isTTY: true }, // no readSingleLine override -- exercises resolveCredentialIO's real default
    );

    expect(client.auth.intent).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: { email: "a@b.c", password: "TTY_PWD" } }),
    );

    const cueWrites = (out.stderr.write as Mock).mock.calls.filter(
      (c) => (c[0] as string) === "Reading secret from stdin (paste + Enter): ",
    );
    expect(cueWrites).toHaveLength(1);

    expect(readlineSync).toHaveBeenCalledWith("", { mask: true });
  });
});
