/**
 * `message` group run functions against a mock SDK client: request building
 * (flag -> SDK method/body), recipient and chat-id resolution, stdin text,
 * acting-identity notices, exit codes. Argv routing is in test/message-routing.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CurviateError } from "@curviate/sdk";
import {
  runMessageAttachment, runMessageDelete, runMessageEdit, runMessageGet, runMessageInMail, runMessageInMailBalance,
  runMessageNew, runMessageReact, runMessageSend,
} from "../../src/commands/message.js";
import { runPostCreate } from "../../src/commands/post.js";
import { exitCode } from "../helpers/exit-code.js";
import { mkClient, mkOut, written } from "../helpers/f4-unit.js";

type Fn = (client: never, args: never, out: never, stdin?: never) => Promise<void>;
const PROFILE = { id: "ACoAAA123", public_identifier: "raphael-redmer" };
const err = (code: string, httpStatus: number) => new CurviateError({ code, message: code, httpStatus, userFixable: false, retryLikelyToSucceed: false } as never);

let ns: ReturnType<typeof makeNs>;
let client: ReturnType<typeof mkClient>;
let dir: string;
function makeNs() {
  return {
    users: { get: vi.fn().mockResolvedValue(PROFILE), getInMailCredits: vi.fn().mockResolvedValue({ balance: 50 }) },
    posts: { create: vi.fn().mockResolvedValue({ post_id: "p1" }) },
    messaging: {
      startChat: vi.fn().mockResolvedValue({ chat_id: "c1" }),
      sendMessage: vi.fn().mockResolvedValue({ message_id: "m1" }),
      getMessage: vi.fn().mockResolvedValue({ id: "msg_1" }),
      editMessage: vi.fn().mockResolvedValue({}),
      deleteMessage: vi.fn().mockResolvedValue({}),
      addReaction: vi.fn().mockResolvedValue({}),
      getAttachment: vi.fn(),
      sendInMail: vi.fn().mockResolvedValue({ inmail_id: "im1" }),
    },
  };
}
beforeEach(async () => {
  ns = makeNs();
  client = mkClient(ns);
  dir = await mkdtemp(join(tmpdir(), "curviate-test-msg-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

/** Run `fn` with account + json defaults; returns the captured out. */
async function call(fn: unknown, args: Record<string, unknown>, stdin?: () => Promise<string>) {
  const out = mkOut();
  await (fn as Fn)(client as never, { account: "acc_1", json: true, ...args } as never, out as never, stdin as never);
  return out;
}
const exits = (fn: unknown, args: Record<string, unknown>, stdin?: () => Promise<string>) => exitCode(() => call(fn, args, stdin));
const preview = (out: ReturnType<typeof mkOut>) => JSON.parse(written(out.stdout)) as { method: string; body?: unknown; attachments?: string[] };
const file = async (name: string, content: string) => {
  const p = join(dir, name);
  await writeFile(p, content);
  return p;
};

describe("message new", () => {
  it("startChat gets attendees_ids and text; --subject is verbatim, absent when omitted, 200 chars is the ceiling", async () => {
    await call(runMessageNew, { to: "ACo123", text: "hello", subject: "Intro" });
    expect(client.account).toHaveBeenCalledWith("acc_1");
    expect(ns.messaging.startChat).toHaveBeenCalledWith(expect.objectContaining({ attendees_ids: ["ACo123"], text: "hello", subject: "Intro" }));
    await call(runMessageNew, { to: "ACo123", text: "hello" });
    expect(Object.keys(ns.messaging.startChat.mock.calls[1]![0])).not.toContain("subject");
    await call(runMessageNew, { to: "ACo123", text: "hello", subject: "x".repeat(200) });
    expect(ns.messaging.startChat).toHaveBeenCalledTimes(3);
  });

  it.each(["", "   ", "x".repeat(201)])("a %j-length subject is refused with exit 2 and nothing sent", async (subject) => {
    expect(await exits(runMessageNew, { to: "ACo123", text: "hi", subject })).toBe(2);
    expect(ns.messaging.startChat).not.toHaveBeenCalled();
  });

  it("--attach sends a base64 payload; a missing file exits 2 before the call", async () => {
    await call(runMessageNew, { to: "ACo123", text: "hi", attach: await file("file.txt", "content") });
    const a = ns.messaging.startChat.mock.calls[0]![0].attachments;
    expect(a[0]).toEqual({ content: Buffer.from("content").toString("base64"), content_type: "application/octet-stream", filename: "file.txt" });
    ns.messaging.startChat.mockClear();
    expect(await exits(runMessageNew, { to: "ACo123", text: "hi", attach: join(dir, "nope.txt") })).toBe(2);
    expect(ns.messaging.startChat).not.toHaveBeenCalled();
  });

  it("--preview renders the request (subject, attachment name+size, no bytes) and calls nothing", async () => {
    const out = await call(runMessageNew, { to: "ACo123", text: "hi", subject: "Intro", attach: await file("attach.pdf", "pdfcontent"), preview: true });
    expect(ns.messaging.startChat).not.toHaveBeenCalled();
    const p = preview(out);
    expect(p.method).toBe("messaging.startChat");
    expect(p.attachments![0]).toMatch(/attach\.pdf \(\d+ bytes\)/);
    expect(written(out.stdout)).toContain("Intro");
  });

  it.each([
    ["https://www.linkedin.com/in/raphael-redmer", "raphael-redmer"],
    ["https://www.linkedin.com/in/raphael-redmer/", "raphael-redmer"],
    ["raphael-redmer", "raphael-redmer"],
  ])("--to %s resolves via one users.get(%s), then one startChat with the provider id", async (to, slug) => {
    await call(runMessageNew, { to, text: "Hello" });
    expect(ns.users.get).toHaveBeenCalledTimes(1);
    expect(ns.users.get).toHaveBeenCalledWith(slug, expect.anything());
    expect(ns.messaging.startChat).toHaveBeenCalledTimes(1);
    expect(ns.messaging.startChat).toHaveBeenCalledWith(expect.objectContaining({ attendees_ids: ["ACoAAA123"] }));
  });

  it("a provider id skips users.get; a lookup 404 exits 4 and never starts a chat", async () => {
    await call(runMessageNew, { to: "ACoAAA123", text: "Hello" });
    expect(ns.users.get).not.toHaveBeenCalled();
    ns.users.get.mockRejectedValue(err("RESOURCE_NOT_FOUND", 404));
    expect(await exits(runMessageNew, { to: "not-found-slug", text: "Hello" })).toBe(4);
    expect(ns.messaging.startChat).toHaveBeenCalledTimes(1);
  });
});

describe("message send", () => {
  it("sendMessage gets the chat id and text; --attach is base64; a missing file exits 2", async () => {
    await call(runMessageSend, { chatId: "chat_abc", text: "hi there", attach: await file("img.png", "imgdata") });
    const [id, body] = ns.messaging.sendMessage.mock.calls[0]!;
    expect(id).toBe("chat_abc");
    expect(body).toMatchObject({ text: "hi there" });
    expect(body.attachments[0]).toEqual({ content: Buffer.from("imgdata").toString("base64"), content_type: "image/png", filename: "img.png" });
    expect(await exits(runMessageSend, { chatId: "chat_abc", text: "hi", attach: join(dir, "ghost.png") })).toBe(2);
    expect(ns.messaging.sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["https://www.linkedin.com/messaging/thread/2-AbCd==", "2-AbCd=="],
    ["2-AbCd==", "2-AbCd=="],
  ])("chat id %s reaches sendMessage as %s", async (chatId, sent) => {
    await call(runMessageSend, { chatId, text: "Hello" });
    expect(ns.messaging.sendMessage).toHaveBeenCalledWith(sent, expect.anything());
  });

  it.each([
    [{ kind: "company", company_id: "112013061", name: "RedHire" }, "Sent as RedHire (company page)\n"],
    [{ kind: "company", company_id: null, name: null }, "Sent as a company page\n"],
    [{ kind: "personal" }, null],
    [undefined, null],
  ])("sent_as %j prints %j on stderr", async (sent_as, note) => {
    ns.messaging.sendMessage.mockResolvedValue({ message_id: "m", sent_as });
    const out = await call(runMessageSend, { chatId: "COMPANY_1-abc", text: "hi" });
    const err = written(out.stderr);
    if (note) expect(err).toContain(note);
    else expect(err).not.toContain("Sent as");
  });

  it("--preview calls nothing; it says 'Will send as a company page' only for a COMPANY_ chat", async () => {
    const co = await call(runMessageSend, { chatId: "COMPANY_83734124_2-abc", text: "hi", preview: true });
    expect(preview(co).method).toBe("messaging.sendMessage");
    expect(written(co.stderr)).toContain("Will send as a company page\n");
    const personal = await call(runMessageSend, { chatId: "CLASSIC_1-abc", text: "hi", preview: true });
    expect(written(personal.stderr)).not.toContain("Will send as");
    expect(ns.messaging.sendMessage).not.toHaveBeenCalled();
  });
});

describe("message get / edit / delete / react", () => {
  it.each([
    ["get", runMessageGet, {}, "getMessage", ["chat_abc", "msg_xyz"]],
    ["edit", runMessageEdit, { text: "updated" }, "editMessage", ["chat_abc", "msg_xyz", { text: "updated" }]],
    ["delete", runMessageDelete, {}, "deleteMessage", ["chat_abc", "msg_xyz"]],
    ["react", runMessageReact, { emoji: "👍" }, "addReaction", ["chat_abc", "msg_xyz", { reaction: "👍" }]],
  ])("message %s -> the wire args; --preview renders it and calls nothing", async (_n, fn, extra, method, args) => {
    await call(fn, { chatId: "chat_abc", messageId: "msg_xyz", ...extra });
    expect((ns.messaging as Record<string, ReturnType<typeof vi.fn>>)[method]).toHaveBeenCalledWith(...args);
    (ns.messaging as Record<string, ReturnType<typeof vi.fn>>)[method]!.mockClear();
    if (method === "getMessage") return; // a read has no preview
    const out = await call(fn, { chatId: "chat_abc", messageId: "msg_xyz", preview: true, ...extra });
    expect((ns.messaging as Record<string, ReturnType<typeof vi.fn>>)[method]).not.toHaveBeenCalled();
    expect(preview(out).method).toBe(`messaging.${method}`);
  });

  it("attachment -o writes the bytes; on a TTY without -o it exits 2", async () => {
    const buf = Buffer.allocUnsafeSlow(14);
    Buffer.from("binary content").copy(buf);
    ns.messaging.getAttachment.mockResolvedValue(buf.buffer);
    const outFile = join(dir, "out.bin");
    const args = { chatId: "chat_abc", messageId: "msg_1", attachmentId: "att_1" };
    await (runMessageAttachment as unknown as (...a: unknown[]) => Promise<void>)(client, { account: "acc_1", ...args, output: outFile }, mkOut(), false);
    expect(ns.messaging.getAttachment).toHaveBeenCalledWith("chat_abc", "msg_1", "att_1");
    expect((await readFile(outFile)).toString()).toBe("binary content");
    expect(await exitCode(() => (runMessageAttachment as unknown as (...a: unknown[]) => Promise<void>)(client, { account: "acc_1", ...args }, mkOut(), true))).toBe(2);
  });
});

describe("message inmail", () => {
  const BASE = { to: "urn:li:member:99", subject: "Hi", text: "Hello" };

  it("the body carries exactly recipient_urn, subject, text (no surface)", async () => {
    await call(runMessageInMail, BASE);
    expect(ns.messaging.sendInMail.mock.calls[0]![0]).toEqual({ recipient_urn: "urn:li:member:99", subject: "Hi", text: "Hello" });
  });

  it.each([
    ["https://www.linkedin.com/in/raphael-redmer", "ACoAAA123", true],
    ["raphael-redmer", "ACoAAA123", true],
    ["ACoAAA123", "ACoAAA123", false],
    ["urn:li:member:12345", "urn:li:member:12345", false],
  ])("--to %s -> recipient_urn %s (users.get: %s)", async (to, urn, looksUp) => {
    await call(runMessageInMail, { ...BASE, to });
    expect(ns.users.get).toHaveBeenCalledTimes(looksUp ? 1 : 0);
    expect(ns.messaging.sendInMail).toHaveBeenCalledWith(expect.objectContaining({ recipient_urn: urn }));
  });

  it.each([
    [{ to: "" }, undefined, 2],
    [{ to: "raphael-redmer" }, err("RESOURCE_NOT_FOUND", 404), 4],
    [{ to: "not-valid-form" }, err("INVALID_REQUEST", 400), 2],
  ])("%j (lookup: %s) exits %i and sends nothing", async (extra, lookup, code) => {
    if (lookup) ns.users.get.mockRejectedValue(lookup);
    expect(await exits(runMessageInMail, { ...BASE, ...extra })).toBe(code);
    expect(ns.messaging.sendInMail).not.toHaveBeenCalled();
  });

  it.each(["", "   ", "x".repeat(201)])("a %j-length subject exits 2 BEFORE --to resolution or any request", async (subject) => {
    expect(await exits(runMessageInMail, { ...BASE, to: "raphael-redmer", subject })).toBe(2);
    expect(ns.users.get).not.toHaveBeenCalled();
    expect(ns.messaging.sendInMail).not.toHaveBeenCalled();
  });

  it("a 200-char subject is sent; --preview shows the honest body and calls nothing", async () => {
    const subject = "x".repeat(200);
    await call(runMessageInMail, { ...BASE, subject });
    expect(ns.messaging.sendInMail).toHaveBeenCalledWith(expect.objectContaining({ subject }));
    ns.messaging.sendInMail.mockClear();
    const p = preview(await call(runMessageInMail, { ...BASE, preview: true }));
    expect(ns.messaging.sendInMail).not.toHaveBeenCalled();
    expect([p.method, p.body]).toEqual(["messaging.sendInMail", { recipient_urn: "urn:li:member:99", subject: "Hi", text: "Hello" }]);
  });

  it("inmail-balance reads users.getInMailCredits and is not paginated (--all exits 2)", async () => {
    await call(runMessageInMailBalance, {});
    expect(ns.users.getInMailCredits).toHaveBeenCalled();
    expect(await exits(runMessageInMailBalance, { all: true })).toBe(2);
  });
});

describe("text '-' reads stdin", () => {
  const cases: Array<[string, unknown, Record<string, unknown>, () => ReturnType<typeof vi.fn>]> = [
    ["message send", runMessageSend, { chatId: "chat_1" }, () => ns.messaging.sendMessage],
    ["message new", runMessageNew, { to: "ACoAAA123" }, () => ns.messaging.startChat],
    ["message edit", runMessageEdit, { chatId: "chat_1", messageId: "msg_1" }, () => ns.messaging.editMessage],
    ["message inmail", runMessageInMail, { to: "ACoAAA123", subject: "Hi" }, () => ns.messaging.sendInMail],
    ["post create", runPostCreate, {}, () => ns.posts.create],
  ];

  it.each(cases)("%s: the (already trimmed) stdin becomes the text, newlines inside kept", async (_n, fn, extra, spy) => {
    await call(fn, { ...extra, text: "-" }, async () => "Line 1\nLine 2");
    expect(JSON.stringify(spy().mock.calls[0])).toContain("Line 1\\nLine 2");
  });

  it.each(cases)("%s: empty stdin exits 2 with 'stdin: empty input' and sends nothing", async (_n, fn, extra, spy) => {
    const out = mkOut();
    const code = await exitCode(() => (fn as Fn)(client as never, { account: "acc_1", json: true, ...extra, text: "-" } as never, out as never, (async () => "") as never));
    expect(code).toBe(2);
    expect(written(out.stderr)).toContain("stdin: empty input");
    expect(spy()).not.toHaveBeenCalled();
  });

  it("plain text never touches the stdin reader", async () => {
    const reader = vi.fn();
    await call(runMessageSend, { chatId: "chat_1", text: "Plain text" }, reader);
    expect(reader).not.toHaveBeenCalled();
    expect(ns.messaging.sendMessage).toHaveBeenCalledWith("chat_1", expect.objectContaining({ text: "Plain text" }));
  });
});
