/**
 * `curviate unibox`: each command's request on the wire (the chat actions go
 * to the core chat routes of the named Account), the one-of flag pairs, and
 * the human table (origin shown, no vendor name).
 */
import { describe, it, expect, afterEach } from "vitest";
import { lines, wire } from "../helpers/wire.js";

const CHAT = "/v1/unibox/chats/acc_a/chat_1";

describe("unibox: the request each command sends", () => {
  it.each([
    [["unibox", "list", "--accounts", "acc_a", "--motion", "none", "--motion", "mot_1", "--person", "con_1", "--tag", "warm", "--no-unread", "--last-from", "them", "--type", "inmail", "--query", "hello", "--total", "--limit", "10"],
      { call: "GET /v1/unibox/chats", query: { account_ids: "acc_a", motion_ids: "none,mot_1", person: "con_1", tags: "warm", unread: "false", last_message_from: "them", type: "inmail", q: "hello", include_total: "true", limit: "10" }, body: undefined }],
    [["unibox", "get", "acc_a", "chat_1"], { call: `GET ${CHAT}`, query: {}, body: undefined }],
    [["unibox", "unread", "--accounts", "acc_a,acc_b"], { call: "GET /v1/unibox/unread-count", query: { account_ids: "acc_a,acc_b" }, body: undefined }],
    [["unibox", "messages", "acc_a", "chat_1", "--limit", "5"], { call: "GET /v1/acc_a/chats/chat_1/messages", query: { limit: "5" }, body: undefined }],
    [["unibox", "reply", "acc_a", "chat_1", "Tuesday works"], { call: "POST /v1/acc_a/chats/chat_1/messages", query: {}, body: { text: "Tuesday works" } }],
    [["unibox", "mark", "acc_a", "chat_1", "--unread"], { call: "PATCH /v1/acc_a/chats/chat_1", query: {}, body: { read: false } }],
    [["unibox", "tag", "acc_a", "chat_1", "--tag", "warm,hot"], { call: `POST ${CHAT}/contact`, query: {}, body: { tags: ["warm", "hot"] } }],
    [["unibox", "enroll", "acc_a", "chat_1", "--motion", "mot_1"], { call: `POST ${CHAT}/enrollments`, query: {}, body: { motion_id: "mot_1" } }],
    [["unibox", "refresh", "--accounts", "acc_a"], { call: "POST /v1/unibox/refresh", query: {}, body: { account_ids: ["acc_a"] } }],
    [["unibox", "accounts"], { call: "GET /v1/unibox/accounts", query: {}, body: undefined }],
    [["unibox", "consent", "acc_a", "--off"], { call: "PATCH /v1/unibox/accounts/acc_a", query: {}, body: { sync_full_inbox: false } }],
  ])("%j", async (args, expected) => {
    const r = await wire(args, () => ({ body: { object: "x", items: [], cursor: null } }));
    expect([r.status, lines(r.sent)]).toEqual([0, [expected]]);
  });

  it.each([[["unibox", "mark", "acc_a", "chat_1"]], [["unibox", "consent", "acc_a", "--on", "--off"]]])("%j exits 2 with no request: exactly one of the pair", async (args) => {
    const r = await wire(args);
    expect([r.status, r.sent.length]).toEqual([2, 0]);
  });
});

describe("unibox: human output", () => {
  const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  afterEach(() => (tty ? Object.defineProperty(process.stdout, "isTTY", tty) : delete (process.stdout as { isTTY?: boolean }).isTTY));

  it("messages show each message's origin; no vendor name anywhere in the table", async () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    const r = await wire(["unibox", "messages", "acc_a", "chat_1"], () => ({
      body: { object: "message_list", items: [{ object: "message", text: "Hi", timestamp: "2026-10-01T00:00:00Z", is_sender: true, origin: "unibox", provider: "linkedin" }], cursor: null },
    }));
    expect(r.stdout).toMatch(/me\s+unibox\s+Hi/);
    expect(r.stdout + r.stderr).not.toMatch(new RegExp(["uni", "pi", "le"].join(""), "i"));
  });
});
