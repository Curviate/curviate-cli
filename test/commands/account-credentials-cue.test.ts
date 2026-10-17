/**
 * Single-cue regression through the real production wiring (`account link` -> resolveCredentialIO's own default
 * readSingleLine -> resolveSecret -> readlineSync): the cue was printed twice because the default reader forwarded it
 * to readlineSync as its prompt. Own file: mocks lib/readline.js at module scope.
 */
import { expect, it, vi } from "vitest";
import { runAccountLink } from "../../src/commands/account.js";
import { readlineSync } from "../../src/lib/readline.js";

vi.mock("../../src/lib/readline.js", () => ({ readlineSync: vi.fn(async () => "TTY_PWD") }));

it("--password-stdin on a TTY writes the cue exactly once and calls readlineSync with an EMPTY prompt", async () => {
  const client = { auth: { intent: vi.fn().mockResolvedValue({ object: "account" }) } };
  const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
  const flags = { "seat-id": "seat_1", "auth-method": "credentials", country: "US", email: "a@b.c", "password-stdin": true, json: true };
  await runAccountLink(client as never, flags as never, out, { isTTY: true });
  expect(client.auth.intent).toHaveBeenCalledWith(expect.objectContaining({ credentials: { email: "a@b.c", password: "TTY_PWD" } }));
  expect(out.stderr.write.mock.calls.filter((c) => c[0] === "Reading secret from stdin (paste + Enter): ")).toHaveLength(1);
  expect(readlineSync).toHaveBeenCalledWith("", { mask: true });
});
