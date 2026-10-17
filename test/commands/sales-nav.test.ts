/**
 * `sales-nav` group: run* functions against a mocked `salesNavigator` namespace, plus the
 * v2 list surface routed through the CLI entry point against a recording sink.
 * Ids pass verbatim except `profile <identifier>` (resolveIdentifier).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exitCode } from "../helpers/exit-code.js";
import { arg0, clientOf, json, mkOut, ndjson, sdkError, text } from "../helpers/f1-unit.js";
import { useSink, line } from "../helpers/sink.js";
import * as S from "../../src/commands/sales-nav.js";

const METHODS = [
  "searchPeople", "searchCompanies", "getParameters", "searchFromUrl", "startChat", "getProfile", "saveLead",
  "accountLists", "leadLists", "browseAccountList", "browseLeadList", "saveAccount",
] as const;
let sn: Record<string, Mock>;
let client: ReturnType<typeof clientOf>;
let tmp: string;
beforeEach(async () => {
  sn = Object.fromEntries(METHODS.map((m) => [m, vi.fn().mockResolvedValue({ items: [{ id: "x" }], cursor: null })]));
  client = clientOf({ salesNavigator: sn });
  tmp = await mkdtemp(join(tmpdir(), "curviate-test-sn-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

type Flags = Record<string, unknown>;
type Runner = (c: never, a: never, o: never) => Promise<void>;
async function go(fn: unknown, flags: Flags = {}) {
  const out = mkOut();
  await (fn as Runner)(client as never, { account: "acc_1", json: true, ...flags } as never, out as never);
  return out;
}

describe("entitlement gate: each code exits 5 with the code in the envelope and one short stderr diagnostic", () => {
  it.each<[string, string, unknown, Flags]>([
    ["searchPeople", "NO_ACTIVE_SEAT", S.runSalesNavSearchPeople, {}],
    ["getProfile", "LINKEDIN_FEATURE_NOT_SUBSCRIBED", S.runSalesNavProfile, { identifier: "jdoe" }],
    ["saveLead", "BETA_NOT_ENABLED", S.runSalesNavSaveLead, { userId: "ACw123" }],
  ])("%s: %s", async (method, code, fn, flags) => {
    sn[method]!.mockRejectedValue(sdkError(code, 403));
    const out = mkOut();
    expect(await exitCode(() => (fn as Runner)(client as never, { account: "acc_1", json: true, ...flags } as never, out as never))).toBe(5);
    const parsed = json(out);
    expect(parsed["error"].code).toBe(code);
    expect(parsed["error"]).not.toHaveProperty("requiredTier");
    expect(text(out.stderr)).toContain(code);
    expect(text(out.stderr).split("\n").filter(Boolean).length).toBeLessThanOrEqual(3);
  });
});

describe("each command calls its SDK method with exactly these arguments", () => {
  const FROM = "https://www.linkedin.com/sales/search/people?x";
  it.each<[string, string, unknown, Flags, unknown[]]>([
    ["search people keywords", "searchPeople", S.runSalesNavSearchPeople, { keywords: "ai" }, [{ keywords: "ai" }]],
    ["search people --filters verbatim", "searchPeople", S.runSalesNavSearchPeople, { filters: '{"location":{"include":["103644278"]},"changed_jobs":true}' }, [{ location: { include: ["103644278"] }, changed_jobs: true }]],
    ["search people named flags over filters, keywords merged", "searchPeople", S.runSalesNavSearchPeople, {
      keywords: "ai", filters: '{"changed_jobs":true}', "first-name": "Ada", "last-name": "Lovelace", groups: "g1,g2", "profile-language": "en",
    }, [{ changed_jobs: true, keywords: "ai", first_name: "Ada", last_name: "Lovelace", group: ["g1", "g2"], profile_language: ["en"] }]],
    ["search companies: keywords + --filters", "searchCompanies", S.runSalesNavSearchCompanies, { keywords: "tech", filters: '{"headcount":{"include":[{"min":11,"max":50}]}}' }, [{ keywords: "tech", headcount: { include: [{ min: 11, max: 50 }] } }]],
    ["search parameters: type + keywords + limit in the query", "getParameters", S.runSalesNavGetParameters, { type: "LOCATION", keywords: "Berlin", limit: "10" }, [{ type: "LOCATION", keywords: "Berlin", limit: 10 }]],
    ["search <url>: url only", "searchFromUrl", S.runSalesNavSearchFromUrl, { url: FROM }, [{ url: FROM }, undefined]],
    ["search <url>: limit/cursor go to the query", "searchFromUrl", S.runSalesNavSearchFromUrl, { url: FROM, limit: "10", cursor: "cur_1" }, [{ url: FROM }, { limit: 10, cursor: "cur_1" }]],
    ["profile url -> slug", "getProfile", S.runSalesNavProfile, { identifier: "https://www.linkedin.com/in/john-doe" }, ["john-doe", expect.anything()]],
    ["profile bare slug", "getProfile", S.runSalesNavProfile, { identifier: "jdoe" }, ["jdoe", expect.anything()]],
    ["save-lead: user_id verbatim, never resolved", "saveLead", S.runSalesNavSaveLead, { userId: "ACw_url_if_given", list: "list_456" }, [{ list_id: "list_456", user_id: "ACw_url_if_given" }]],
    ["message new", "startChat", S.runSalesNavMessageNew, { to: "ACo456", text: "hello sn", subject: "Quick question" }, [expect.objectContaining({ attendees_ids: ["ACo456"], text: "hello sn", subject: "Quick question" })]],
    ["account-lists", "accountLists", S.runSalesNavAccountLists, { account: "acc_a" }, []],
    ["lead-lists", "leadLists", S.runSalesNavLeadLists, {}, []],
    ["browse-account-list --filter", "browseAccountList", S.runSalesNavBrowseAccountList, { listId: "L1", filter: "STARRED" }, ["L1", expect.objectContaining({ filter: "STARRED" }), undefined]],
    ["browse-lead-list --spotlight", "browseLeadList", S.runSalesNavBrowseLeadList, { listId: "L2", spotlight: "RECENT_POSITION_CHANGE" }, ["L2", expect.objectContaining({ spotlight: "RECENT_POSITION_CHANGE" }), undefined]],
    ["save-account", "saveAccount", S.runSalesNavSaveAccount, { list: "L1", companyId: "123" }, [{ list_id: "L1", company_id: "123" }]],
  ])("%s", async (_label, method, fn, flags, expected) => {
    const out = await go(fn, flags);
    expect(client.account).toHaveBeenCalledWith((flags["account"] as string | undefined) ?? "acc_1");
    expect(sn[method]).toHaveBeenCalled();
    expect(sn[method]!.mock.calls[0]!.slice(0, expected.length)).toEqual(expected);
    expect(json(out)).toBeTruthy();
  });
});

describe("refusals exit 2 before any SDK call", () => {
  it.each<[string, string, unknown, Flags]>([
    ["search people: non-object --filters", "searchPeople", S.runSalesNavSearchPeople, { filters: "[1,2,3]" }],
    ["search companies: bad --filters JSON", "searchCompanies", S.runSalesNavSearchCompanies, { filters: "{bad" }],
    ["message new without --subject", "startChat", S.runSalesNavMessageNew, { to: "ACo456", text: "hello" }],
    ["message new --attach missing file", "startChat", S.runSalesNavMessageNew, { to: "ACo456", text: "hello", subject: "S", attach: "/nonexistent/x.txt" }],
  ])("%s", async (_label, method, fn, flags) => {
    const out = mkOut();
    expect(await exitCode(() => (fn as Runner)(client as never, { account: "acc_1", ...flags } as never, out as never))).toBe(2);
    expect(sn[method]).not.toHaveBeenCalled();
  });
});

describe("--preview renders the request and never calls the SDK", () => {
  it.each<[string, string, unknown, Flags]>([
    ["salesNavigator.startChat", "startChat", S.runSalesNavMessageNew, { to: "ACo456", text: "hello", subject: "S" }],
    ["salesNavigator.saveLead", "saveLead", S.runSalesNavSaveLead, { userId: "ACw123", list: "list_456" }],
    ["salesNavigator.saveAccount", "saveAccount", S.runSalesNavSaveAccount, { list: "L1", companyId: "123" }],
  ])("%s", async (name, method, fn, flags) => {
    const out = await go(fn, { ...flags, json: undefined, preview: true });
    expect(sn[method]).not.toHaveBeenCalled();
    expect(json(out)["method"]).toBe(name);
  });
});

describe("--all streams every page; message new attachments", () => {
  it.each<[string, unknown, Flags, string]>([
    ["searchPeople", S.runSalesNavSearchPeople, {}, "items"],
    ["searchFromUrl", S.runSalesNavSearchFromUrl, { url: "https://linkedin.com/x" }, "data"],
  ])("%s --all", async (method, fn, flags, key) => {
    sn[method]!.mockReset().mockResolvedValueOnce({ [key]: [{ id: "p1" }], cursor: "c1" }).mockResolvedValueOnce({ [key]: [{ id: "p2" }], cursor: null });
    expect(ndjson(await go(fn, { ...flags, all: true })).map((l) => JSON.parse(l))).toEqual([{ id: "p1" }, { id: "p2" }]);
  });

  it.each([
    ["attach", "attach.txt", "content", { content_type: "application/octet-stream" }],
    ["voice", "voice.ogg", "voicedata", { send_mode: "native" }],
    ["video", "video.mp4", "videodata", { send_mode: "native" }],
  ])("message new --%s rides attachments[] as base64 (no voice_message / video_message field)", async (flag, name, data, extra) => {
    const file = join(tmp, name);
    await writeFile(file, data);
    await go(S.runSalesNavMessageNew, { to: "ACo456", text: "hello", subject: "Subj", [flag]: file });
    const b = arg0(sn["startChat"]!);
    expect(b).not.toHaveProperty("voice_message");
    expect(b).not.toHaveProperty("video_message");
    expect((b["attachments"] as unknown[])[0]).toMatchObject({ content: Buffer.from(data).toString("base64"), filename: name, ...extra });
  });

  it("the registry has no inmail-balance subcommand", () => {
    expect((S.salesNavCommand as unknown as { subCommands: object }).subCommands).not.toHaveProperty("inmail-balance");
  });
});

describe("v2 list surface routes through the entry point", () => {
  const sink = useSink();
  it.each([
    [["account-lists"], "GET /v1/acc_x/sales-navigator/account-lists"],
    [["lead-lists"], "GET /v1/acc_x/sales-navigator/lead-lists"],
    [["browse-account-list", "L1"], "POST /v1/acc_x/sales-navigator/account-lists/L1"],
    [["browse-lead-list", "L2"], "POST /v1/acc_x/sales-navigator/lead-lists/L2"],
  ])("sales-nav %j reaches %s", async (sub, expected) => {
    const r = await sink.run(["sales-nav", ...sub, "--account", "acc_x", "--json"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.requests.map(line)).toEqual([expected]);
  });

  it("save-account / save-lead --preview render only their own request and send nothing; save-lead without --list exits 2", async () => {
    for (const [sub, args, method] of [["save-account", ["--list", "L1", "123"], "salesNavigator.saveAccount"], ["save-lead", ["--list", "L2", "ACw123"], "salesNavigator.saveLead"]] as const) {
      const r = await sink.run(["sales-nav", sub, ...args, "--account", "acc_x", "--preview"]);
      expect([r.status, r.requests]).toEqual([0, []]);
      expect(r.stdout.trim().split("\n")).toHaveLength(1);
      expect(r.stdout).toContain(method);
    }
    const missing = await sink.run(["sales-nav", "save-lead", "ACw123", "--account", "acc_x"]);
    expect([missing.status, missing.requests]).toEqual([2, []]);
  });
});
