/**
 * `account` flag hygiene (single-resource writes/checkpoint commands carry --fields but no pagination flags; lists keep them;
 * `checkpoint request` has the account-id positional and no --code) and `link --linkedin-premium` narrowing.
 */
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import { accountCommand, runAccountLink } from "../../src/commands/account.js";
import { exitCode } from "../helpers/exit-code.js";

type Sub = { args?: Record<string, { type?: string }>; meta?: { description?: string }; subCommands?: Record<string, Sub> };
const subs = (accountCommand as unknown as { subCommands: Record<string, Sub> }).subCommands;
const PAGINATION = ["limit", "cursor", "all", "max-pages"];

describe("account flag sets", () => {
  it.each([
    ["link", () => subs["link"]!],
    ["update", () => subs["update"]!],
    ["disconnect", () => subs["disconnect"]!],
    ["checkpoint solve", () => subs["checkpoint"]!.subCommands!["solve"]!],
    ["checkpoint poll", () => subs["checkpoint"]!.subCommands!["poll"]!],
    ["checkpoint request", () => subs["checkpoint"]!.subCommands!["request"]!],
  ])("%s: no pagination flags, keeps --fields", (_n, get) => {
    const args = get().args ?? {};
    for (const f of PAGINATION) expect(args).not.toHaveProperty(f);
    expect(args).toHaveProperty("fields");
  });

  it("list keeps every pagination flag; checkpoint request has the account-id positional and no --code, and its description never names the vendor", () => {
    for (const f of PAGINATION) expect(subs["list"]!.args).toHaveProperty(f);
    const req = subs["checkpoint"]!.subCommands!["request"]!;
    expect(req.args!["account-id"]!.type).toBe("positional");
    expect(req.args).not.toHaveProperty("code");
    expect(req.meta?.description ?? "").not.toMatch(new RegExp(["uni", "pi", "le"].join(""), "i")); // fragments: the literal must not appear in this public file
  });
});

describe("account link --linkedin-premium", () => {
  const client = { auth: { intent: vi.fn() } };
  const link = (extra: object, out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } }) =>
    runAccountLink(client as never, { "seat-id": "seat_1", "auth-method": "cookie", country: "US", "li-at": "AQEDaTest", "user-agent": "Mozilla/5.0", json: true, ...extra } as never, out, { isTTY: false });
  const sent = () => client.auth.intent.mock.calls[0]![0] as Record<string, unknown>;

  it.each(["sales_navigator", "recruiter"])("forwards %s; absent sends no field (omission means 'every product')", async (value) => {
    vi.resetAllMocks();
    client.auth.intent.mockResolvedValue({ object: "account" });
    await link({ "linkedin-premium": value });
    expect(sent()["linkedin_premium"]).toBe(value);
    client.auth.intent.mockClear();
    await link({});
    expect(sent()).toMatchObject({ auth_method: "cookie" }); // positive control: a body was captured
    expect(sent()).not.toHaveProperty("linkedin_premium");
  });

  // "" is what --linkedin-premium="$UNSET" expands to: a falsy guard let it past the validation and silently widened the connect.
  it.each(["", "sales-navigator", "SALES_NAVIGATOR", "both", "premium"])("refuses %j with exit 2 and never connects", async (value) => {
    vi.resetAllMocks();
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    expect(await exitCode(() => link({ "linkedin-premium": value }, out))).toBe(2);
    expect(client.auth.intent).not.toHaveBeenCalled();
    expect((out.stderr.write as Mock).mock.calls.join("")).toContain("--linkedin-premium must be one of: sales_navigator, recruiter");
  });

  it("under --preview it renders instead of exiting, and does not echo the rejected value", async () => {
    vi.resetAllMocks();
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    expect(await exitCode(() => link({ "linkedin-premium": "typo", preview: true }, out))).toBeUndefined();
    expect(client.auth.intent).not.toHaveBeenCalled();
    const printed = (out.stdout.write as Mock).mock.calls.join("");
    expect(printed.length).toBeGreaterThan(0);
    expect(printed).not.toContain("typo");
  });
});
