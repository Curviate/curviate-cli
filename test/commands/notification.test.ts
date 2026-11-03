/** `notification` (Curviate's Notifications) over the wire: the request each flag sends, the not-found rule, the stale-verb refusal. */
import { describe, it, expect } from "vitest";
import { useSink, line, type Hit } from "../helpers/sink.js";

const N = (id: string, read: boolean) => ({ object: "curviate_notification", id, type: "account.reconnect_needed", title: "t", read, archived: false });
const sink = useSink((h: Hit) => {
  if (h.method === "PATCH") {
    const id = h.url.split("/").pop()!;
    return id === "ntf_foreign" ? { status: 404, body: { code: "RESOURCE_NOT_FOUND", message: "not found", user_fixable: true, retry_likely_to_succeed: false } } : { body: N(id, true) };
  }
  if (h.url.startsWith("/v1/notifications/unread-count")) return { body: { object: "curviate_notification_unread_count", unread_count: 3 } };
  if (h.url.startsWith("/v1/notifications/mark-all-read")) return { body: { object: "curviate_notification_mark_all_read", before: "2026-10-08T10:00:00.000Z", marked: 2, unread_count: 0 } };
  return { body: { object: "curviate_notification_list", items: [N("ntf_unread", false), N("ntf_read", true)], cursor: null, unread_count: 1 } };
});
const query = (h: Hit) => new URL(h.url, "http://x").searchParams.get("filter");

describe("notification list", () => {
  it.each([
    [["--unread"], "unread"],
    [["--archived"], "archived"],
    [[], "all"],
    [["--no-archived"], "all"],
  ])("%j sends filter=%s", async (flags, filter) => {
    const r = await sink.run(["notification", "list", ...flags, "--limit", "5", "--json"]);
    expect(r.status, r.stderr).toBe(0);
    expect([line(r.requests[0]!), query(r.requests[0]!)]).toEqual(["GET /v1/notifications", filter]);
    expect(new URL(r.requests[0]!.url, "http://x").searchParams.get("limit")).toBe("5");
  });

  it("--no-unread sends filter=all and prints only read items", async () => {
    const r = await sink.run(["notification", "list", "--no-unread", "--json"]);
    expect(query(r.requests[0]!)).toBe("all");
    const out = JSON.parse(r.stdout) as { items: Array<{ id: string }> };
    expect(out.items.map((i) => i.id)).toEqual(["ntf_read"]);
    // control: the same call without the flag prints both
    const all = JSON.parse((await sink.run(["notification", "list", "--json"])).stdout) as { items: unknown[] };
    expect(all.items).toHaveLength(2);
  });

  it.each([["--unread", "--archived"], ["--unread", "--no-unread"], ["--archived", "--no-archived"]])("%s %s exits 2 and sends nothing", async (a, b) => {
    const r = await sink.run(["notification", "list", a, b]);
    expect([r.status, r.requests.length]).toEqual([2, 0]);
  });

  it("a stale card verb exits 2 with no request", async () => {
    const r = await sink.run(["notification", "delete", "urn:li:fsd_notificationCard:(urn:li:fsd_notification:1,ALL)"]);
    expect([r.status, r.requests.length]).toEqual([2, 0]);
  });
});

describe("notification writes", () => {
  it("count, read-all --to (sends before) and read-all with none", async () => {
    expect(JSON.parse((await sink.run(["notification", "count", "--json"])).stdout)).toMatchObject({ unread_count: 3 });
    const r = await sink.run(["notification", "read-all", "--to", "2026-10-08T10:00:00Z", "--json"]);
    expect([line(r.requests[0]!), JSON.parse(r.requests[0]!.body)]).toEqual(["POST /v1/notifications/mark-all-read", { before: "2026-10-08T10:00:00Z" }]);
    const none = await sink.run(["notification", "read-all", "--json"]);
    expect(JSON.parse(none.requests[0]!.body || "{}")).toEqual({});
    expect((await sink.run(["notification", "read-all", "--to", "yesterday"])).status).toBe(2);
  });

  it.each([
    ["read", { read: true }],
    ["archive", { archived: true }],
    ["unarchive", { archived: false }],
  ])("%s A B sends one PATCH each", async (verb, body) => {
    const r = await sink.run(["notification", verb, "ntf_a", "ntf_b", "--json"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.requests.map((q) => [line(q), JSON.parse(q.body)])).toEqual([
      ["PATCH /v1/notifications/ntf_a", body],
      ["PATCH /v1/notifications/ntf_b", body],
    ]);
  });

  it("archive A B with B foreign: A archived, B reported, exit 4", async () => {
    const r = await sink.run(["notification", "archive", "ntf_a", "ntf_foreign", "ntf_c", "--json"]);
    expect(r.status).toBe(4);
    expect(r.requests).toHaveLength(3); // the one after the foreign id still applied
    const out = JSON.parse(r.stdout) as { updated: Array<{ id: string }>; not_found: string[] };
    expect([out.updated.map((u) => u.id), out.not_found]).toEqual([["ntf_a", "ntf_c"], ["ntf_foreign"]]);
  });

  it("--preview renders the PATCH and sends nothing", async () => {
    const r = await sink.run(["notification", "archive", "ntf_a", "--preview"]);
    expect([r.status, r.requests.length, JSON.parse(r.stdout).method]).toEqual([0, 0, "notifications.update"]);
  });
});
