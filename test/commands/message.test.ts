/**
 * `curviate core message new|send`: a group chat (repeatable --to, --subject as
 * its name) and shared content (--share-post, --share-job) on the wire, and the
 * refusals that cost no request. Written against the recording fetch: no
 * message reaches anyone.
 */
import { describe, it, expect } from "vitest";
import { lines, wire } from "../helpers/wire.js";

const A = "--account";
const ACC = "acc_1";
const SENT = { chat_id: "c_1", message_id: "m_1" };
const NEW = ["core", "message", "new"];
const SEND = ["core", "message", "send", "c_1"];

describe("message new / send: the request each form sends", () => {
  it.each([
    [[...NEW, A, ACC, "--to", "ACoAAA1111", "Hi"], { call: "POST /v1/acc_1/chats", query: {}, body: { attendees_ids: ["ACoAAA1111"], text: "Hi" } }],
    [[...NEW, A, ACC, "--to", "ACoAAA1111", "--to", "ACoAAA2222", "--subject", "Q4 intro", "Hi both"],
      { call: "POST /v1/acc_1/chats", query: {}, body: { attendees_ids: ["ACoAAA1111", "ACoAAA2222"], text: "Hi both", subject: "Q4 intro" } }],
    // a person named twice counts once: a direct chat, not a group
    [[...NEW, A, ACC, "--to", "ACoAAA1111", "--to", "ACoAAA1111", "Hi"], { call: "POST /v1/acc_1/chats", query: {}, body: { attendees_ids: ["ACoAAA1111"], text: "Hi" } }],
    [[...NEW, A, ACC, "--to", "ACoAAA1111", "--share-job", "https://www.linkedin.com/jobs/view/4012345678/", "Thought of you"],
      { call: "POST /v1/acc_1/chats", query: {}, body: { attendees_ids: ["ACoAAA1111"], text: "Thought of you", shared_content: { type: "job_posting", id: "4012345678" } } }],
    [[...SEND, A, ACC, "--share-post", "7380123456789012345", "This one"],
      { call: "POST /v1/acc_1/chats/c_1/messages", query: {}, body: { text: "This one", shared_content: { type: "post", id: "7380123456789012345" } } }],
  ])("%j", async (args, expected) => {
    const r = await wire(args, () => ({ body: SENT }));
    expect([r.status, lines(r.sent)]).toEqual([0, [expected]]);
  });

  it("--preview shows every attendee and the shared content, and sends nothing", async () => {
    const r = await wire([...NEW, A, ACC, "--to", "ACoAAA1111", "--to", "ACoAAA2222", "--share-post", "7380123456789012345", "Hi", "--preview"]);
    expect(r.sent).toEqual([]);
    expect(JSON.parse(r.stdout).body).toEqual({
      attendees_ids: ["ACoAAA1111", "ACoAAA2222"],
      text: "Hi",
      shared_content: { type: "post", id: "7380123456789012345" },
    });
  });
});

describe("message new / send: refused with exit 2 and no request", () => {
  it.each([
    [[...SEND, A, ACC, "--share-post", "1", "--share-job", "2", "Hi"], /not both/], // one object only
    [[...SEND, A, ACC, "--share-post", " ", "Hi"], /empty value/], // a lost value
    [[...SEND, A, ACC, "--share-job", "4012345678", ""], /needs the message text/], // text is required
    [[...NEW, A, ACC, "--to", "ACoAAA1111", "--share-job", "4012345678", "Hi", "--attach", "package.json"], /cannot be combined with --attach/], // no attachments
  ])("%j", async (args, reason) => {
    const r = await wire(args);
    expect([r.status, r.sent.length, r.stderr]).toEqual([2, 0, expect.stringMatching(reason)]);
  });
});
