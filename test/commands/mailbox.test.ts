/** `mailbox`, `domain check` and the Team email safety flags: one table of command lines, the one call each makes, the body it carries; the API's 400s exit with its message; help lists every row. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { useSink, line, type Hit } from "../helpers/sink.js";

const MBX = { object: "mailbox", id: "mbx_1", address: "a@acme.example", state: "connected", daily_cap: 30 };
const TEAM_POLICY = { email: { default_daily_cap: 30, opt_out_scope: "everything", opt_out_link_word: "Abmelden" } };
const sink = useSink((h: Hit) => {
  if (h.url.startsWith("/v1/safety-policy")) return { body: TEAM_POLICY };
  if (h.url.startsWith("/v1/domains/")) return { body: { object: "domain", domain: "acme.example", checks: { mx: "pass" } } };
  if (h.url === "/v1/mailboxes" || h.url.startsWith("/v1/mailboxes?")) return { body: { object: "list", items: [MBX], cursor: null } };
  return { body: MBX };
});
const dir = mkdtempSync(join(tmpdir(), "mbx-"));
const sig = join(dir, "signature.txt");
writeFileSync(sig, "Anna Berg\nAcme GmbH\n");

const CASES: Array<[string[], string, unknown]> = [
  [["mailbox", "list"], "GET /v1/mailboxes", undefined],
  [["mailbox", "list", "--state", "paused", "--sends-for", "none", "--domain", "acme.example"], "GET /v1/mailboxes", undefined],
  [["mailbox", "get", "mbx_1"], "GET /v1/mailboxes/mbx_1", undefined],
  [["mailbox", "update", "mbx_1", "--sends-for", "acc_1", "--daily-cap", "40", "--signature-file", sig], "PATCH /v1/mailboxes/mbx_1", { sends_for: { kind: "account", account_id: "acc_1" }, daily_cap: 40, signature: "Anna Berg\nAcme GmbH" }],
  [["mailbox", "update", "mbx_1", "--sends-for", "shared"], "PATCH /v1/mailboxes/mbx_1", { sends_for: { kind: "shared" } }],
  [["mailbox", "pause", "mbx_1"], "POST /v1/mailboxes/mbx_1/pause", undefined],
  [["mailbox", "resume", "mbx_1"], "POST /v1/mailboxes/mbx_1/resume", undefined],
  [["mailbox", "remove", "mbx_1"], "DELETE /v1/mailboxes/mbx_1", undefined],
  [["domain", "check", "acme.example"], "GET /v1/domains/acme.example/checks", undefined],
  [["domain", "check", "acme.example", "--now"], "POST /v1/domains/acme.example/checks", undefined],
  [["account", "safety", "get", "--team"], "GET /v1/safety-policy", undefined],
  [["account", "safety", "get", "--team", "tnt_2"], "GET /v1/safety-policy", undefined],
  [
    ["account", "safety", "update", "--team", "--email-default-cap", "40", "--email-opt-out-scope", "email_only", "--email-opt-out-text", "Reply STOP.", "--email-opt-out-link-text", "No more:", "--email-opt-out-link-word", "Abmelden"],
    "PATCH /v1/safety-policy",
    { email: { default_daily_cap: 40, opt_out_scope: "email_only", opt_out_text: "Reply STOP.", opt_out_link_text: "No more:", opt_out_link_word: "Abmelden" } },
  ],
  [["account", "safety", "update", "--team", "--email-opt-out-link-word", ""], "PATCH /v1/safety-policy", { email: { opt_out_link_word: "" } }],
];

const REFUSED: string[][] = [
  ["mailbox", "update", "mbx_1"],
  ["mailbox", "update", "mbx_1", "--daily-cap", "lots"],
  ["mailbox", "list", "--state", "bogus"],
  ["domain", "check"],
  ["account", "safety", "get"],
  ["account", "safety", "get", "acc_1", "--team"],
  ["account", "safety", "update", "--team"],
  ["account", "safety", "update", "--team", "--email-opt-out-scope", "some"],
  ["account", "safety", "update", "acc_1", "--file", sig, "--email-default-cap", "40"],
];

describe("mailbox, domain, Team email safety", () => {
  it.each(CASES)("%j makes exactly one call", async (args, call, body) => {
    const r = await sink.run([...args, "--json"]);
    expect([r.status, r.requests.map(line)]).toEqual([0, [call]]);
    if (body !== undefined) expect(JSON.parse(r.requests[0]!.body)).toEqual(body);
    if (args[1] === "list") expect(JSON.parse(r.stdout).items).toEqual([MBX]);
  });

  it("the list filters reach the query, and the Team scope reaches the header", async () => {
    const r = await sink.run(["mailbox", "list", "--state", "paused", "--sends-for", "none", "--domain", "acme.example", "--limit", "5", "--json"]);
    expect(r.requests[0]!.url).toBe("/v1/mailboxes?state=paused&sends_for=none&domain=acme.example&limit=5");
    const t = await sink.run(["account", "safety", "get", "--team", "tnt_2", "--json"]);
    expect([t.requests[0]!.headers["x-curviate-team"], JSON.parse(t.stdout)]).toEqual(["tnt_2", TEAM_POLICY]);
    expect((await sink.run(["account", "safety", "get", "--team", "--json"], { env: { CURVIATE_TEAM: "tnt_env" } })).requests[0]!.headers["x-curviate-team"]).toBe("tnt_env");
  });

  it.each(REFUSED)("%j is refused before any request", async (...args) => {
    const r = await sink.run(args);
    expect([r.status, r.requests.length]).toEqual([2, 0]);
  });

  it("the API's 400 is printed with its message, exit 2: the cap names 50, the link word 30", async () => {
    for (const [args, named] of [
      [["mailbox", "update", "mbx_1", "--daily-cap", "51"], "50"],
      [["account", "safety", "update", "--team", "--email-opt-out-link-word", "x".repeat(31)], "30"],
    ] as const) {
      sink.reply = { status: 400, body: { code: "INVALID_REQUEST", message: `at most ${named}`, user_fixable: true, retry_likely_to_succeed: false } };
      const r = await sink.run([...args, "--json"]);
      expect([r.status, r.requests.length, `${r.stdout}${r.stderr}`.includes(`at most ${named}`)]).toEqual([2, 1, true]);
    }
  });

  it("help lists every Mailbox row (command, flags)", async () => {
    const out = async (...a: string[]) => { const r = await sink.run([...a, "--help"]); return r.stdout + r.stderr; };
    const mailbox = await out("mailbox");
    for (const v of ["list", "get", "update", "pause", "resume", "remove"]) expect(mailbox).toContain(v);
    expect(await out("domain")).toContain("check");
    expect(await out("domain", "check")).toContain("--now");
    const update = await out("mailbox", "update");
    for (const f of ["--sends-for", "--daily-cap", "--signature-file"]) expect(update).toContain(f);
    const safety = await out("account", "safety", "update");
    for (const f of ["--team", "--email-default-cap", "--email-opt-out-scope", "--email-opt-out-text", "--email-opt-out-link-text", "--email-opt-out-link-word"]) expect(safety).toContain(f);
    expect(await out("account", "safety", "get")).toContain("--team");
  });
});
