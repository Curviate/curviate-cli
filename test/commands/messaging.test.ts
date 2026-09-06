/**
 * Tests for messaging identifier resolution and chat-ID normalization.
 *
 * Covers:
 *   message new --to: LinkedIn URL/slug resolved via users.get; provider IDs pass through
 *   message inmail --to: URL/slug/provider-id/URN resolution; slug calls users.get
 *   Chat ID normalization: LinkedIn messaging thread URLs stripped to bare provider ID
 *   on inbox get / inbox messages / message send
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { CurviateError } from "@curviate/sdk";

// ---------------------------------------------------------------------------
// Error factories for SDK error stubs
// ---------------------------------------------------------------------------

function makeNotFoundError() {
  return new CurviateError({
    code: "RESOURCE_NOT_FOUND",
    message: "Profile not found",
    httpStatus: 404,
    userFixable: false,
    retryLikelyToSucceed: false,
  });
}

function makeInvalidRequestError() {
  return new CurviateError({
    code: "INVALID_REQUEST",
    message: "Invalid identifier",
    httpStatus: 400,
    userFixable: true,
    retryLikelyToSucceed: false,
  });
}

// ---------------------------------------------------------------------------
// Mock builders
// ---------------------------------------------------------------------------

function makeFullNs() {
  return {
    users: {
      get: vi.fn(),
    },
    messaging: {
      startChat: vi.fn(),
      sendMessage: vi.fn(),
      getMessage: vi.fn(),
      editMessage: vi.fn(),
      deleteMessage: vi.fn(),
      addReaction: vi.fn(),
      getAttachment: vi.fn(),
      sendInMail: vi.fn(),
      getInMailBalance: vi.fn(),
    },
  };
}

function makeMessagingOnlyNs() {
  return {
    messaging: {
      listChats: vi.fn(),
      getChat: vi.fn(),
      listMessages: vi.fn(),
    },
  };
}

function makeClient(ns: ReturnType<typeof makeFullNs> | ReturnType<typeof makeMessagingOnlyNs>) {
  return { account: vi.fn().mockReturnValue(ns) };
}

type MessageArgs = {
  chatId?: string;
  messageId?: string;
  to?: string;
  text?: string;
  subject?: string;
  account?: string;
  json?: boolean;
  preview?: boolean;
  all?: boolean;
};

type InboxArgs = {
  chatId?: string;
  account?: string;
  json?: boolean;
  before?: string;
  after?: string;
};

// Stub profile response
const PROFILE_STUB = { id: "ACoAAA123", public_identifier: "raphael-redmer" };
// Stub startChat response
const CHAT_STUB = { object: "chat_started", chat_id: "c1", message_id: "m1" };
// Stub sendInMail response
const INMAIL_STUB = { object: "inmail_sent", message_id: "msg_1", chat_id: "chat_1" };
// Stub getChat / listMessages responses
const CHAT_DETAIL_STUB = { object: "chat", id: "2-AbCdEfGhIjKlMnOpQ==" };
const MESSAGE_LIST_STUB = { object: "message_list", items: [], cursor: null };

// ---------------------------------------------------------------------------
// message new --to identifier resolution
// ---------------------------------------------------------------------------

describe("message new --to recipient resolution", () => {
  let ns: ReturnType<typeof makeFullNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeFullNs();
    client = makeClient(ns);
    (ns.users.get as Mock).mockResolvedValue(PROFILE_STUB);
    (ns.messaging.startChat as Mock).mockResolvedValue(CHAT_STUB);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("LinkedIn profile URL extracts slug, calls users.get, passes provider_id to startChat", async () => {
    const { runMessageNew } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runMessageNew(client as never, {
      to: "https://www.linkedin.com/in/raphael-redmer",
      text: "Hello",
      account: "acc_1",
      json: true,
    } as MessageArgs, out);

    expect(ns.users.get).toHaveBeenCalledTimes(1);
    expect(ns.users.get).toHaveBeenCalledWith("raphael-redmer", expect.anything());
    expect(ns.messaging.startChat).toHaveBeenCalledWith(
      expect.objectContaining({ attendees_ids: ["ACoAAA123"], text: "Hello" }),
    );
  });

  it("bare slug calls users.get then startChat with provider_id", async () => {
    const { runMessageNew } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runMessageNew(client as never, {
      to: "raphael-redmer",
      text: "Hello",
      account: "acc_1",
      json: true,
    } as MessageArgs, out);

    expect(ns.users.get).toHaveBeenCalledWith("raphael-redmer", expect.anything());
    expect(ns.messaging.startChat).toHaveBeenCalledWith(
      expect.objectContaining({ attendees_ids: ["ACoAAA123"] }),
    );
  });

  it("provider ID (uppercase prefix shape) bypasses users.get and goes directly to startChat", async () => {
    const { runMessageNew } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runMessageNew(client as never, {
      to: "ACoAAA123",
      text: "Hello",
      account: "acc_1",
      json: true,
    } as MessageArgs, out);

    expect(ns.users.get).not.toHaveBeenCalled();
    expect(ns.messaging.startChat).toHaveBeenCalledWith(
      expect.objectContaining({ attendees_ids: ["ACoAAA123"] }),
    );
  });

  it("profile URL with trailing slash extracts slug correctly", async () => {
    const { runMessageNew } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runMessageNew(client as never, {
      to: "https://www.linkedin.com/in/raphael-redmer/",
      text: "Hello",
      account: "acc_1",
      json: true,
    } as MessageArgs, out);

    expect(ns.users.get).toHaveBeenCalledWith("raphael-redmer", expect.anything());
    expect(ns.messaging.startChat).toHaveBeenCalledWith(
      expect.objectContaining({ attendees_ids: ["ACoAAA123"] }),
    );
  });

  it("users.get not found exits 4 and startChat is never called", async () => {
    const { runMessageNew } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    (ns.users.get as Mock).mockRejectedValue(makeNotFoundError());

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(
      (code?: number | string | null) => { throw new Error(`process.exit(${code})`); },
    );
    try {
      await runMessageNew(client as never, {
        to: "not-found-slug",
        text: "Hello",
        account: "acc_1",
        json: true,
      } as MessageArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(4)");
    } finally {
      exitSpy.mockRestore();
    }

    expect(ns.messaging.startChat).not.toHaveBeenCalled();
  });

  it("URL and bare slug each make exactly one users.get call then one startChat call", async () => {
    const { runMessageNew } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runMessageNew(client as never, {
      to: "https://www.linkedin.com/in/raphael-redmer",
      text: "Hi",
      account: "acc_1",
      json: true,
    } as MessageArgs, out);

    expect(ns.users.get).toHaveBeenCalledTimes(1);
    expect(ns.messaging.startChat).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// message inmail --to resolution
// ---------------------------------------------------------------------------

describe("message inmail --to resolution", () => {
  let ns: ReturnType<typeof makeFullNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeFullNs();
    client = makeClient(ns);
    (ns.users.get as Mock).mockResolvedValue(PROFILE_STUB);
    (ns.messaging.sendInMail as Mock).mockResolvedValue(INMAIL_STUB);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("LinkedIn profile URL extracts slug, calls users.get, sendInMail receives provider_id as recipient_urn", async () => {
    const { runMessageInMail } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runMessageInMail(client as never, {
      to: "https://www.linkedin.com/in/raphael-redmer",
      subject: "Hi",
      text: "Body",
      account: "acc_1",
      json: true,
    } as MessageArgs, out);

    expect(ns.users.get).toHaveBeenCalledTimes(1);
    expect(ns.users.get).toHaveBeenCalledWith("raphael-redmer", expect.anything());
    expect(ns.messaging.sendInMail).toHaveBeenCalledWith(
      expect.objectContaining({ recipient_urn: "ACoAAA123" }),
    );
  });

  it("bare slug calls users.get, sendInMail receives resolved provider_id as recipient_urn", async () => {
    const { runMessageInMail } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runMessageInMail(client as never, {
      to: "raphael-redmer",
      subject: "Hi",
      text: "Body",
      account: "acc_1",
      json: true,
    } as MessageArgs, out);

    expect(ns.users.get).toHaveBeenCalledWith("raphael-redmer", expect.anything());
    expect(ns.messaging.sendInMail).toHaveBeenCalledWith(
      expect.objectContaining({ recipient_urn: "ACoAAA123" }),
    );
  });

  it("provider ID passes directly to sendInMail without calling users.get", async () => {
    const { runMessageInMail } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runMessageInMail(client as never, {
      to: "ACoAAA123",
      subject: "Hi",
      text: "Body",
      account: "acc_1",
      json: true,
    } as MessageArgs, out);

    expect(ns.users.get).not.toHaveBeenCalled();
    expect(ns.messaging.sendInMail).toHaveBeenCalledWith(
      expect.objectContaining({ recipient_urn: "ACoAAA123" }),
    );
  });

  it("URN passes directly to sendInMail without calling users.get", async () => {
    const { runMessageInMail } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runMessageInMail(client as never, {
      to: "urn:li:member:12345",
      subject: "Hi",
      text: "Body",
      account: "acc_1",
      json: true,
    } as MessageArgs, out);

    expect(ns.users.get).not.toHaveBeenCalled();
    expect(ns.messaging.sendInMail).toHaveBeenCalledWith(
      expect.objectContaining({ recipient_urn: "urn:li:member:12345" }),
    );
  });

  it("users.get not found exits 4 and sendInMail is never called", async () => {
    const { runMessageInMail } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    (ns.users.get as Mock).mockRejectedValue(makeNotFoundError());

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(
      (code?: number | string | null) => { throw new Error(`process.exit(${code})`); },
    );
    try {
      await runMessageInMail(client as never, {
        to: "raphael-redmer",
        subject: "Hi",
        text: "Body",
        account: "acc_1",
        json: true,
      } as MessageArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(4)");
    } finally {
      exitSpy.mockRestore();
    }

    expect(ns.messaging.sendInMail).not.toHaveBeenCalled();
  });

  it("empty --to exits 2 without calling users.get or sendInMail", async () => {
    const { runMessageInMail } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(
      (code?: number | string | null) => { throw new Error(`process.exit(${code})`); },
    );
    try {
      await runMessageInMail(client as never, {
        to: "",
        subject: "Hi",
        text: "Body",
        account: "acc_1",
      } as MessageArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }

    expect(ns.users.get).not.toHaveBeenCalled();
    expect(ns.messaging.sendInMail).not.toHaveBeenCalled();
  });

  it("users.get invalid request exits 2 and sendInMail is never called", async () => {
    const { runMessageInMail } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    (ns.users.get as Mock).mockRejectedValue(makeInvalidRequestError());

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(
      (code?: number | string | null) => { throw new Error(`process.exit(${code})`); },
    );
    try {
      await runMessageInMail(client as never, {
        to: "not-valid-form",
        subject: "Hi",
        text: "Body",
        account: "acc_1",
        json: true,
      } as MessageArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }

    expect(ns.messaging.sendInMail).not.toHaveBeenCalled();
  });

  it("slug and URL each make exactly two SDK calls: one users.get then one sendInMail", async () => {
    const { runMessageInMail } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runMessageInMail(client as never, {
      to: "raphael-redmer",
      subject: "Hi",
      text: "Body",
      account: "acc_1",
      json: true,
    } as MessageArgs, out);

    expect(ns.users.get).toHaveBeenCalledTimes(1);
    expect(ns.messaging.sendInMail).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// CHATID thread-URL normalization (inbox get / inbox messages / message send)
// ---------------------------------------------------------------------------

describe("chat ID normalization on inbox get", () => {
  let ns: ReturnType<typeof makeMessagingOnlyNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeMessagingOnlyNs();
    client = makeClient(ns);
    (ns.messaging.getChat as Mock).mockResolvedValue(CHAT_DETAIL_STUB);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("LinkedIn thread URL strips prefix and passes bare provider_id to getChat", async () => {
    const { runInboxGet } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runInboxGet(client as never, {
      chatId: "https://www.linkedin.com/messaging/thread/2-AbCdEfGhIjKlMnOpQ==",
      account: "acc_1",
      json: true,
    } as InboxArgs, out);

    expect(ns.messaging.getChat).toHaveBeenCalledWith("2-AbCdEfGhIjKlMnOpQ==", {});
  });

  it("thread URL with trailing slash strips both prefix and slash", async () => {
    const { runInboxGet } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runInboxGet(client as never, {
      chatId: "https://www.linkedin.com/messaging/thread/2-AbCdEfGhIjKlMnOpQ==/",
      account: "acc_1",
      json: true,
    } as InboxArgs, out);

    expect(ns.messaging.getChat).toHaveBeenCalledWith("2-AbCdEfGhIjKlMnOpQ==", {});
  });

  it("thread URL with query string strips prefix and query string", async () => {
    const { runInboxGet } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runInboxGet(client as never, {
      chatId: "https://www.linkedin.com/messaging/thread/2-AbCdEfGhIjKlMnOpQ==?overlayThreadListFilter=FOCUS_INBOX",
      account: "acc_1",
      json: true,
    } as InboxArgs, out);

    expect(ns.messaging.getChat).toHaveBeenCalledWith("2-AbCdEfGhIjKlMnOpQ==", {});
  });

  it("bare provider ID passes through verbatim without transformation", async () => {
    const { runInboxGet } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runInboxGet(client as never, {
      chatId: "2-AbCdEfGhIjKlMnOpQ==",
      account: "acc_1",
      json: true,
    } as InboxArgs, out);

    expect(ns.messaging.getChat).toHaveBeenCalledWith("2-AbCdEfGhIjKlMnOpQ==", {});
  });

  it("internal chat ID passes through verbatim", async () => {
    const { runInboxGet } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runInboxGet(client as never, {
      chatId: "chat_internal_123",
      account: "acc_1",
      json: true,
    } as InboxArgs, out);

    expect(ns.messaging.getChat).toHaveBeenCalledWith("chat_internal_123", {});
  });
});

describe("chat ID normalization on inbox messages", () => {
  let ns: ReturnType<typeof makeMessagingOnlyNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeMessagingOnlyNs();
    client = makeClient(ns);
    (ns.messaging.listMessages as Mock).mockResolvedValue(MESSAGE_LIST_STUB);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("LinkedIn thread URL is normalized to bare provider_id before listMessages call", async () => {
    const { runInboxMessages } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runInboxMessages(client as never, {
      chatId: "https://www.linkedin.com/messaging/thread/2-AbCdEfGhIjKlMnOpQ==",
      account: "acc_1",
      json: true,
    } as InboxArgs, out);

    expect(ns.messaging.listMessages).toHaveBeenCalledWith("2-AbCdEfGhIjKlMnOpQ==", expect.anything());
  });
});

describe("chat ID normalization on message send", () => {
  let ns: ReturnType<typeof makeFullNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeFullNs();
    client = makeClient(ns);
    (ns.messaging.sendMessage as Mock).mockResolvedValue({ message_id: "msg_1" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("LinkedIn thread URL is normalized to bare provider_id before sendMessage call", async () => {
    const { runMessageSend } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runMessageSend(client as never, {
      chatId: "https://www.linkedin.com/messaging/thread/2-AbCdEfGhIjKlMnOpQ==",
      text: "Hello",
      account: "acc_1",
      json: true,
    } as MessageArgs, out);

    expect(ns.messaging.sendMessage).toHaveBeenCalledWith("2-AbCdEfGhIjKlMnOpQ==", expect.anything());
  });

  it("bare provider_id passes through verbatim on message send", async () => {
    const { runMessageSend } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runMessageSend(client as never, {
      chatId: "2-AbCdEfGhIjKlMnOpQ==",
      text: "Hello",
      account: "acc_1",
      json: true,
    } as MessageArgs, out);

    expect(ns.messaging.sendMessage).toHaveBeenCalledWith("2-AbCdEfGhIjKlMnOpQ==", expect.anything());
  });
});

describe("normalization makes zero network calls on all chat commands", () => {
  it("inbox get with thread URL does not call users.get", async () => {
    const ns = makeMessagingOnlyNs();
    const client = makeClient(ns);
    (ns.messaging.getChat as Mock).mockResolvedValue(CHAT_DETAIL_STUB);

    const { runInboxGet } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runInboxGet(client as never, {
      chatId: "https://www.linkedin.com/messaging/thread/2-XY==",
      account: "acc_1",
      json: true,
    } as InboxArgs, out);

    // Only one call: getChat — no users.get or any other lookup
    expect(ns.messaging.getChat).toHaveBeenCalledTimes(1);
    expect(ns.messaging.getChat).toHaveBeenCalledWith("2-XY==", {});
  });
});
