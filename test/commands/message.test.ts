/**
 * Tests for the `message` command group.
 *
 * Coverage:
 *   message new --to <attendee> "<text>" [--attach <file>…]   → messaging.startChat (base64 JSON)
 *   message <chat_id> "<text>" [--attach <file>…]             → messaging.sendMessage (base64 JSON)
 *   message get <chat_id> <message_id>                          → messaging.getMessage
 *   message edit <chat_id> <message_id> "<text>"               → messaging.editMessage
 *   message delete <chat_id> <message_id>                      → messaging.deleteMessage
 *   message react <chat_id> <message_id> --emoji <e>           → messaging.addReaction (body field: `reaction`)
 *   message attachment <chat_id> <message_id> <attachment_id> -o <file> → messaging.getAttachment (binary)
 *   message inmail --to <id> --subject <s> "<text>"           → messaging.sendInMail (--to via resolveIdentifier)
 *   message inmail-balance                                     → users.getInMailCredits
 *
 * v2: get/edit/delete/react/attachment are re-homed under chat_id (leading
 * positional); attachments travel as base64 {content,content_type,filename}
 * objects, never raw Buffers; sendInMail has no --surface (dropped, no v2
 * home); inmail-balance relocated from messaging.getInMailBalance to
 * users.getInMailCredits.
 *
 * --preview on writes: renders preview, no SDK call.
 * --preview on reads: exit 2.
 * --attach missing file: exit 2 before SDK call.
 * binary: -o writes file; TTY without -o exits 2.
 * --all rejected on non-paginated commands: exit 2.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeMessagingNs() {
  return {
    messaging: {
      startChat: vi.fn(),
      sendMessage: vi.fn(),
      getMessage: vi.fn(),
      editMessage: vi.fn(),
      deleteMessage: vi.fn(),
      addReaction: vi.fn(),
      getAttachment: vi.fn(),
      sendInMail: vi.fn(),
    },
    users: {
      getInMailCredits: vi.fn(),
    },
  };
}

function makeClient(ns: ReturnType<typeof makeMessagingNs>) {
  return {
    account: vi.fn().mockReturnValue(ns),
  };
}

type MessageArgs = {
  chatId?: string;
  messageId?: string;
  attachmentId?: string;
  to?: string;
  text?: string;
  emoji?: string;
  subject?: string;
  output?: string;
  attach?: string | string[];
  account?: string;
  json?: boolean;
  preview?: boolean;
  all?: boolean;
  limit?: string;
  cursor?: string;
  "max-pages"?: string;
  fields?: string;
  "api-key"?: string;
  "base-url"?: string;
  timeout?: string;
  profile?: string;
};

describe("message new", () => {
  let ns: ReturnType<typeof makeMessagingNs>;
  let client: ReturnType<typeof makeClient>;
  let tmpDir: string;

  beforeEach(async () => {
    ns = makeMessagingNs();
    client = makeClient(ns);
    (ns.messaging.startChat as Mock).mockResolvedValue({ chat_id: "chat_1", message_id: "msg_1" });
    tmpDir = await mkdtemp(join(tmpdir(), "curviate-test-msg-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("message new --to ACo123 'hello' — calls startChat with attendees_ids and text", async () => {
    const { runMessageNew } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runMessageNew(client as never, {
      to: "ACo123",
      text: "hello",
      account: "acc_1",
      json: true,
    } as MessageArgs, out);

    expect(client.account).toHaveBeenCalledWith("acc_1");
    expect(ns.messaging.startChat).toHaveBeenCalledWith(
      expect.objectContaining({ attendees_ids: ["ACo123"], text: "hello" }),
    );
  });

  it("message new --to ACo123 'hello' --attach <file> — reads file and passes base64 payload in attachments (v2: no multipart)", async () => {
    const { runMessageNew } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const filePath = join(tmpDir, "file.txt");
    await writeFile(filePath, "content");

    await runMessageNew(client as never, {
      to: "ACo123",
      text: "hello",
      attach: filePath,
      account: "acc_1",
      json: true,
    } as MessageArgs, out);

    const callArgs = (ns.messaging.startChat as Mock).mock.calls[0]![0] as Record<string, unknown>;
    const attachments = callArgs["attachments"] as Array<Record<string, unknown>>;
    expect(Array.isArray(attachments)).toBe(true);
    expect(attachments[0]).toEqual({
      content: Buffer.from("content").toString("base64"),
      content_type: "application/octet-stream",
      filename: "file.txt",
    });
  });

  it("message new --attach <missing-file> — exits 2 before SDK call", async () => {
    const { runMessageNew } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runMessageNew(client as never, {
        to: "ACo123",
        text: "hello",
        attach: join(tmpDir, "no-such-file.txt"),
        account: "acc_1",
      } as MessageArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(ns.messaging.startChat).not.toHaveBeenCalled();
  });

  it("message new --preview — renders preview, does not call startChat", async () => {
    const { runMessageNew } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runMessageNew(client as never, {
      to: "ACo123",
      text: "hello",
      account: "acc_1",
      preview: true,
    } as MessageArgs, out);

    expect(ns.messaging.startChat).not.toHaveBeenCalled();
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.method).toBe("messaging.startChat");
  });

  it("message new --preview with attachment — preview shows attachment name+size, no bytes", async () => {
    const { runMessageNew } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const filePath = join(tmpDir, "attach.pdf");
    await writeFile(filePath, "pdfcontent");

    await runMessageNew(client as never, {
      to: "ACo123",
      text: "hello",
      attach: filePath,
      account: "acc_1",
      preview: true,
    } as MessageArgs, out);

    expect(ns.messaging.startChat).not.toHaveBeenCalled();
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.attachments).toBeDefined();
    expect(parsed.attachments[0]).toMatch(/attach\.pdf \(\d+ bytes\)/);
  });
});

describe("message send (message <chat_id>)", () => {
  let ns: ReturnType<typeof makeMessagingNs>;
  let client: ReturnType<typeof makeClient>;
  let tmpDir: string;

  beforeEach(async () => {
    ns = makeMessagingNs();
    client = makeClient(ns);
    (ns.messaging.sendMessage as Mock).mockResolvedValue({ message_id: "msg_2" });
    tmpDir = await mkdtemp(join(tmpdir(), "curviate-test-send-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("message <chat_id> '<text>' — calls sendMessage with chatId and text", async () => {
    const { runMessageSend } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runMessageSend(client as never, {
      chatId: "chat_abc",
      text: "hi there",
      account: "acc_1",
      json: true,
    } as MessageArgs, out);

    expect(ns.messaging.sendMessage).toHaveBeenCalledWith(
      "chat_abc",
      expect.objectContaining({ text: "hi there" }),
    );
  });

  it("message <chat_id> '<text>' --attach <file> — passes base64 payload in attachments (v2: no multipart)", async () => {
    const { runMessageSend } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const filePath = join(tmpDir, "img.png");
    await writeFile(filePath, "imgdata");

    await runMessageSend(client as never, {
      chatId: "chat_abc",
      text: "see attached",
      attach: filePath,
      account: "acc_1",
      json: true,
    } as MessageArgs, out);

    const callArgs = (ns.messaging.sendMessage as Mock).mock.calls[0]![1] as Record<string, unknown>;
    const attachments = callArgs["attachments"] as Array<Record<string, unknown>>;
    expect(attachments[0]).toEqual({
      content: Buffer.from("imgdata").toString("base64"),
      content_type: "image/png",
      filename: "img.png",
    });
  });

  it("message <chat_id> --attach <missing> — exits 2, no SDK call", async () => {
    const { runMessageSend } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runMessageSend(client as never, {
        chatId: "chat_abc",
        text: "hi",
        attach: join(tmpDir, "ghost.png"),
        account: "acc_1",
      } as MessageArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(ns.messaging.sendMessage).not.toHaveBeenCalled();
  });

  it("message <chat_id> --preview — renders preview, no SDK call", async () => {
    const { runMessageSend } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runMessageSend(client as never, {
      chatId: "chat_abc",
      text: "preview this",
      account: "acc_1",
      preview: true,
    } as MessageArgs, out);

    expect(ns.messaging.sendMessage).not.toHaveBeenCalled();
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.method).toBe("messaging.sendMessage");
  });
});

// ---------------------------------------------------------------------------
// AX P1: sent_as acting-identity notice (default output, not just --verbose --json)
// ---------------------------------------------------------------------------

describe("message send — sent_as acting-identity notice", () => {
  let ns: ReturnType<typeof makeMessagingNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeMessagingNs();
    client = makeClient(ns);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a company-page send with a resolved name prints 'Sent as <name> (company page)' to stderr", async () => {
    (ns.messaging.sendMessage as Mock).mockResolvedValue({
      message_id: "msg_1",
      sent_as: { kind: "company", company_id: "112013061", name: "RedHire" },
    });
    const { runMessageSend } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runMessageSend(
      client as never,
      { chatId: "COMPANY_83734124_2-abc", text: "hi", account: "acc_1", json: true } as MessageArgs,
      out,
    );

    const stderrLines = (out.stderr.write as Mock).mock.calls.map((c) => c[0] as string);
    expect(stderrLines).toContain("Sent as RedHire (company page)\n");
  });

  it("a company-page send with an uncorrelated page (name null) prints the generic fallback", async () => {
    (ns.messaging.sendMessage as Mock).mockResolvedValue({
      message_id: "msg_1",
      sent_as: { kind: "company", company_id: null, name: null },
    });
    const { runMessageSend } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runMessageSend(
      client as never,
      { chatId: "COMPANY_83734124_2-abc", text: "hi", account: "acc_1", json: true } as MessageArgs,
      out,
    );

    const stderrLines = (out.stderr.write as Mock).mock.calls.map((c) => c[0] as string);
    expect(stderrLines).toContain("Sent as a company page\n");
  });

  it("a personal send prints no acting-identity notice", async () => {
    (ns.messaging.sendMessage as Mock).mockResolvedValue({
      message_id: "msg_1",
      sent_as: { kind: "personal" },
    });
    const { runMessageSend } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runMessageSend(
      client as never,
      { chatId: "CLASSIC_1-abc", text: "hi", account: "acc_1", json: true } as MessageArgs,
      out,
    );

    const stderrLines = (out.stderr.write as Mock).mock.calls.map((c) => c[0] as string);
    expect(stderrLines.some((l) => l.includes("Sent as"))).toBe(false);
  });

  it("a response with no sent_as field at all prints no notice (defensive, older/mocked responses)", async () => {
    (ns.messaging.sendMessage as Mock).mockResolvedValue({ message_id: "msg_1" });
    const { runMessageSend } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runMessageSend(
      client as never,
      { chatId: "CLASSIC_1-abc", text: "hi", account: "acc_1", json: true } as MessageArgs,
      out,
    );

    const stderrLines = (out.stderr.write as Mock).mock.calls.map((c) => c[0] as string);
    expect(stderrLines.some((l) => l.includes("Sent as"))).toBe(false);
  });
});

describe("message send --preview — acting-identity echo (zero network calls)", () => {
  let ns: ReturnType<typeof makeMessagingNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeMessagingNs();
    client = makeClient(ns);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("--preview on a COMPANY_ chat id prints 'Will send as a company page' without any SDK call", async () => {
    const { runMessageSend } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runMessageSend(
      client as never,
      { chatId: "COMPANY_83734124_2-abc", text: "hi", account: "acc_1", preview: true } as MessageArgs,
      out,
    );

    expect(ns.messaging.sendMessage).not.toHaveBeenCalled();
    const stderrLines = (out.stderr.write as Mock).mock.calls.map((c) => c[0] as string);
    expect(stderrLines).toContain("Will send as a company page\n");
  });

  it("--preview on a CLASSIC_ (personal) chat id prints no acting-identity note", async () => {
    const { runMessageSend } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runMessageSend(
      client as never,
      { chatId: "CLASSIC_1-abc", text: "hi", account: "acc_1", preview: true } as MessageArgs,
      out,
    );

    const stderrLines = (out.stderr.write as Mock).mock.calls.map((c) => c[0] as string);
    expect(stderrLines.some((l) => l.includes("Will send as"))).toBe(false);
  });
});

describe("message get / edit / delete", () => {
  let ns: ReturnType<typeof makeMessagingNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeMessagingNs();
    client = makeClient(ns);
    (ns.messaging.getMessage as Mock).mockResolvedValue({ id: "msg_1" });
    (ns.messaging.editMessage as Mock).mockResolvedValue({ id: "msg_1" });
    (ns.messaging.deleteMessage as Mock).mockResolvedValue({ deleted: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("message get <chat_id> <message_id> — calls getMessage with chat_id + message_id", async () => {
    const { runMessageGet } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runMessageGet(client as never, { chatId: "chat_abc", messageId: "msg_xyz", account: "acc_1", json: true } as MessageArgs, out);

    expect(ns.messaging.getMessage).toHaveBeenCalledWith("chat_abc", "msg_xyz");
  });

  it("message edit <chat_id> <message_id> '<text>' — calls editMessage with chat_id, message_id, and text body", async () => {
    const { runMessageEdit } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runMessageEdit(client as never, {
      chatId: "chat_abc",
      messageId: "msg_xyz",
      text: "updated text",
      account: "acc_1",
      json: true,
    } as MessageArgs, out);

    expect(ns.messaging.editMessage).toHaveBeenCalledWith("chat_abc", "msg_xyz", { text: "updated text" });
  });

  it("message edit --preview — renders preview, no editMessage call", async () => {
    const { runMessageEdit } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runMessageEdit(client as never, {
      chatId: "chat_abc",
      messageId: "msg_xyz",
      text: "updated",
      account: "acc_1",
      preview: true,
    } as MessageArgs, out);

    expect(ns.messaging.editMessage).not.toHaveBeenCalled();
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.method).toBe("messaging.editMessage");
  });

  it("message delete <chat_id> <message_id> — calls deleteMessage with chat_id + message_id", async () => {
    const { runMessageDelete } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runMessageDelete(client as never, { chatId: "chat_abc", messageId: "msg_xyz", account: "acc_1", json: true } as MessageArgs, out);

    expect(ns.messaging.deleteMessage).toHaveBeenCalledWith("chat_abc", "msg_xyz");
  });

  it("message delete --preview — renders preview, no deleteMessage call", async () => {
    const { runMessageDelete } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runMessageDelete(client as never, {
      chatId: "chat_abc",
      messageId: "msg_xyz",
      account: "acc_1",
      preview: true,
    } as MessageArgs, out);

    expect(ns.messaging.deleteMessage).not.toHaveBeenCalled();
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.method).toBe("messaging.deleteMessage");
  });
});

describe("message react", () => {
  let ns: ReturnType<typeof makeMessagingNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeMessagingNs();
    client = makeClient(ns);
    (ns.messaging.addReaction as Mock).mockResolvedValue({ message_id: "msg_1", reaction: "👍" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("message react <chat_id> <id> --emoji 👍 — calls addReaction with chat_id, message_id, and body field 'reaction'", async () => {
    const { runMessageReact } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runMessageReact(client as never, {
      chatId: "chat_abc",
      messageId: "msg_xyz",
      emoji: "👍",
      account: "acc_1",
      json: true,
    } as MessageArgs, out);

    // SDK body field is `reaction`, not `emoji`
    expect(ns.messaging.addReaction).toHaveBeenCalledWith("chat_abc", "msg_xyz", { reaction: "👍" });
  });

  it("message react --preview — renders preview, no addReaction call", async () => {
    const { runMessageReact } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runMessageReact(client as never, {
      chatId: "chat_abc",
      messageId: "msg_xyz",
      emoji: "👍",
      account: "acc_1",
      preview: true,
    } as MessageArgs, out);

    expect(ns.messaging.addReaction).not.toHaveBeenCalled();
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.method).toBe("messaging.addReaction");
  });
});

describe("message attachment (binary)", () => {
  let ns: ReturnType<typeof makeMessagingNs>;
  let client: ReturnType<typeof makeClient>;
  let tmpDir: string;

  beforeEach(async () => {
    ns = makeMessagingNs();
    client = makeClient(ns);
    // Use Buffer.allocUnsafeSlow to get a dedicated (non-pooled) ArrayBuffer so
    // that buffer.buffer contains only "binary content" and nothing else.
    const fakeBuffer = Buffer.allocUnsafeSlow(14);
    Buffer.from("binary content").copy(fakeBuffer);
    (ns.messaging.getAttachment as Mock).mockResolvedValue(fakeBuffer.buffer);
    tmpDir = await mkdtemp(join(tmpdir(), "curviate-test-bin-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("message attachment <chat_id> <msg_id> <att_id> -o <file> — writes binary to file", async () => {
    const { runMessageAttachment } = await import("../../src/commands/message.js");
    const outFile = join(tmpDir, "out.bin");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runMessageAttachment(client as never, {
      chatId: "chat_abc",
      messageId: "msg_1",
      attachmentId: "att_1",
      output: outFile,
      account: "acc_1",
    } as MessageArgs, out, false);

    expect(ns.messaging.getAttachment).toHaveBeenCalledWith("chat_abc", "msg_1", "att_1");

    // Verify file was written
    const { readFile } = await import("node:fs/promises");
    const written = await readFile(outFile);
    expect(written.toString()).toBe("binary content");
  });

  it("message attachment without -o on TTY — exits 2", async () => {
    const { runMessageAttachment } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      // isTTY=true, no outputPath
      await runMessageAttachment(client as never, {
        chatId: "chat_abc",
        messageId: "msg_1",
        attachmentId: "att_1",
        account: "acc_1",
      } as MessageArgs, out, true);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe("message inmail / inmail-balance", () => {
  let ns: ReturnType<typeof makeMessagingNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeMessagingNs();
    client = makeClient(ns);
    (ns.messaging.sendInMail as Mock).mockResolvedValue({ inmail_id: "im_1" });
    (ns.users.getInMailCredits as Mock).mockResolvedValue({ balance: 50 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("message inmail --to urn:li:member:99 --subject 'Hi' 'text' — calls sendInMail with correct body", async () => {
    const { runMessageInMail } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runMessageInMail(client as never, {
      to: "urn:li:member:99",
      subject: "Hi",
      text: "Hello there",
      account: "acc_1",
      json: true,
    } as MessageArgs, out);

    // --to for inmail runs through resolveIdentifier (URN passes unchanged)
    expect(ns.messaging.sendInMail).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient_urn: "urn:li:member:99",
        subject: "Hi",
        text: "Hello there",
      }),
    );
  });

  // ── Wire-encoding regression: the body MUST carry every API-required field
  // and NOTHING else. OpenAPI required = [account_id, recipient_urn, subject,
  // text] — v2 has no `surface` field at all (was removed upstream; a prior
  // CLI version sent it anyway → guaranteed API 400 for an unrecognized
  // field). This test asserts the exact key set + values the SDK method
  // receives.
  it("message inmail — body carries exactly recipient_urn, subject, text (no surface)", async () => {
    const { runMessageInMail } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runMessageInMail(client as never, {
      to: "urn:li:member:12345",
      subject: "Role at Acme",
      text: "Body text",
      account: "acc_1",
      json: true,
    } as MessageArgs, out);

    expect(client.account).toHaveBeenCalledWith("acc_1");
    const body = (ns.messaging.sendInMail as Mock).mock.calls[0]![0] as Record<string, unknown>;
    // Every body-level required field present, with exact key names + shapes
    // — and no stray `surface` key.
    expect(body).toEqual({
      recipient_urn: "urn:li:member:12345",
      subject: "Role at Acme",
      text: "Body text",
    });
  });

  it("message inmail --to <provider-id> — accepts a provider id directly", async () => {
    const { runMessageInMail } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runMessageInMail(client as never, {
      to: "ACoAAA1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuVwX",
      subject: "Exploring synergies",
      text: "Hi there",
      account: "acc_1",
      json: true,
    } as MessageArgs, out);

    const body = (ns.messaging.sendInMail as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({
      recipient_urn: "ACoAAA1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuVwX",
      subject: "Exploring synergies",
      text: "Hi there",
    });
  });

  it("message inmail --to <urn> — a URN recipient still passes through", async () => {
    const { runMessageInMail } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runMessageInMail(client as never, {
      to: "urn:li:member:778899",
      subject: "Hi",
      text: "Hello",
      account: "acc_1",
      json: true,
    } as MessageArgs, out);

    expect(ns.messaging.sendInMail).toHaveBeenCalledWith(
      expect.objectContaining({ recipient_urn: "urn:li:member:778899" }),
    );
  });

  it("message inmail — empty --to exits 2 before any SDK call", async () => {
    const { runMessageInMail } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runMessageInMail(client as never, {
        to: "",
        subject: "Hi",
        text: "Hello",
        account: "acc_1",
      } as MessageArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(ns.messaging.sendInMail).not.toHaveBeenCalled();
  });

  it("message inmail --preview — renders preview, no sendInMail call", async () => {
    const { runMessageInMail } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runMessageInMail(client as never, {
      to: "urn:li:member:99",
      subject: "Hi",
      text: "Hello",
      account: "acc_1",
      preview: true,
    } as MessageArgs, out);

    expect(ns.messaging.sendInMail).not.toHaveBeenCalled();
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.method).toBe("messaging.sendInMail");
    // Preview must be honest: the assembled body has no surface field.
    expect(parsed.body).toEqual({ recipient_urn: "urn:li:member:99", subject: "Hi", text: "Hello" });
  });

  it("message inmail-balance — calls users.getInMailCredits", async () => {
    const { runMessageInMailBalance } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runMessageInMailBalance(client as never, { account: "acc_1", json: true } as MessageArgs, out);

    expect(ns.users.getInMailCredits).toHaveBeenCalled();
  });

  it("message inmail-balance --all — exits 2 (not paginated)", async () => {
    const { runMessageInMailBalance } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runMessageInMailBalance(client as never, { account: "acc_1", all: true } as MessageArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });
});
