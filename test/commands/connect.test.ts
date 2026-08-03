/**
 * Tests for the `connect` command group.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";

function makeAccountNs() {
  return {
    invites: {
      send: vi.fn(),
      listSent: vi.fn(),
      listReceived: vi.fn(),
      accept: vi.fn(),
      decline: vi.fn(),
      cancel: vi.fn(),
    },
  };
}

function makeClient(accountNs: ReturnType<typeof makeAccountNs>) {
  return {
    account: vi.fn().mockReturnValue(accountNs),
  };
}

type ConnectArgs = {
  id?: string;
  note?: string;
  action?: string;
  account?: string;
  json?: boolean;
  preview?: boolean;
  all?: boolean;
  "max-pages"?: string;
  limit?: string;
  cursor?: string;
  fields?: string;
  "api-key"?: string;
  "base-url"?: string;
  timeout?: string;
  profile?: string;
  verbose?: boolean;
};

describe("connect <id> — send invitation", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.invites.send as Mock).mockResolvedValue({ status: "sent" });
    (accountNs.invites.listSent as Mock).mockResolvedValue({ items: [], cursor: null });
    (accountNs.invites.listReceived as Mock).mockResolvedValue({ items: [], cursor: null });
    (accountNs.invites.accept as Mock).mockResolvedValue({ status: "accepted" });
    (accountNs.invites.cancel as Mock).mockResolvedValue({ status: "cancelled" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("connect <member-url> — resolves URL to slug, calls invites.send", async () => {
    const { runConnectSend } = await import("../../src/commands/connect.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runConnectSend(client as never, {
      id: "https://www.linkedin.com/in/jdoe/?trk=x",
      account: "acc_1",
      json: true,
    } as ConnectArgs, out);

    expect(client.account).toHaveBeenCalledWith("acc_1");
    expect(accountNs.invites.send).toHaveBeenCalledWith(
      expect.objectContaining({ recipient_identifier: "jdoe" }),
    );
  });

  it("connect bare slug — passes slug unchanged", async () => {
    const { runConnectSend } = await import("../../src/commands/connect.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runConnectSend(client as never, { id: "jdoe", account: "acc_1", json: true } as ConnectArgs, out);

    expect(accountNs.invites.send).toHaveBeenCalledWith(
      expect.objectContaining({ recipient_identifier: "jdoe" }),
    );
  });

  it("connect URN — passes URN unchanged", async () => {
    const { runConnectSend } = await import("../../src/commands/connect.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runConnectSend(client as never, {
      id: "urn:li:fsd_profile:ABC123",
      account: "acc_1",
      json: true,
    } as ConnectArgs, out);

    expect(accountNs.invites.send).toHaveBeenCalledWith(
      expect.objectContaining({ recipient_identifier: "urn:li:fsd_profile:ABC123" }),
    );
  });

  it("connect <id> --note <text> — passes message field", async () => {
    const { runConnectSend } = await import("../../src/commands/connect.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runConnectSend(client as never, {
      id: "jdoe",
      note: "Hello!",
      account: "acc_1",
      json: true,
    } as ConnectArgs, out);

    expect(accountNs.invites.send).toHaveBeenCalledWith(
      expect.objectContaining({ recipient_identifier: "jdoe", message: "Hello!" }),
    );
  });

  it("connect --preview — renders preview, does not call send", async () => {
    const { runConnectSend } = await import("../../src/commands/connect.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runConnectSend(client as never, {
      id: "jdoe",
      account: "acc_1",
      preview: true,
    } as ConnectArgs, out);

    expect(accountNs.invites.send).not.toHaveBeenCalled();
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.method).toBe("invites.send");
  });
});

describe("connect sent / received — list reads", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.invites.listSent as Mock).mockResolvedValue({ items: [{ id: "s1" }], cursor: null });
    (accountNs.invites.listReceived as Mock).mockResolvedValue({ items: [{ id: "r1" }], cursor: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("connect sent — calls invites.listSent", async () => {
    const { runConnectSent } = await import("../../src/commands/connect.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runConnectSent(client as never, { account: "acc_1", json: true } as ConnectArgs, out);

    expect(accountNs.invites.listSent).toHaveBeenCalled();
  });

  it("connect sent --all — slim NDJSON lines carry the v2 slim fields (id/created_at/message/user kept, user.type/public_picture_url dropped)", async () => {
    const { runConnectSent } = await import("../../src/commands/connect.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    (accountNs.invites.listSent as Mock).mockResolvedValueOnce({
      items: [
        {
          object: "invitation_sent",
          id: "SENT_s1",
          created_at: "2026-06-16T00:00:00Z",
          message: "Let's connect",
          user: {
            id: "ACoAAJaneDoe",
            type: "individual",
            display_name: "Jane Doe",
            first_name: "Jane",
            last_name: "Doe",
            public_picture_url: "https://media.licdn.com/jane.jpg",
          },
        },
      ],
      cursor: null,
    });

    await runConnectSent(client as never, { account: "acc_1", all: true } as ConnectArgs, out);

    const lines = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).filter((l) => l.trim().startsWith("{"));
    expect(lines).toHaveLength(1);
    const item = JSON.parse(lines.join("")) as Record<string, unknown>;
    expect(item["id"]).toBe("SENT_s1");
    expect(item["created_at"]).toBe("2026-06-16T00:00:00Z");
    expect(item["message"]).toBe("Let's connect");
    expect(item["user"]).toEqual({
      id: "ACoAAJaneDoe",
      display_name: "Jane Doe",
      first_name: "Jane",
      last_name: "Doe",
    });
    expect(item).not.toHaveProperty("object");
    expect(item).not.toHaveProperty("items");
  });

  it("connect sent --preview → usage error exit 2", async () => {
    const { runConnectSent } = await import("../../src/commands/connect.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => { throw new Error(`process.exit(${code})`); });
    try {
      await runConnectSent(client as never, { account: "acc_1", preview: true } as ConnectArgs, out);
      expect.fail("Should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("connect received — calls invites.listReceived", async () => {
    const { runConnectReceived } = await import("../../src/commands/connect.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runConnectReceived(client as never, { account: "acc_1", json: true } as ConnectArgs, out);

    expect(accountNs.invites.listReceived).toHaveBeenCalled();
  });

  it("connect received --all — streams NDJSON", async () => {
    const { runConnectReceived } = await import("../../src/commands/connect.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    (accountNs.invites.listReceived as Mock)
      .mockResolvedValueOnce({ items: [{ id: "r1" }, { id: "r2" }], cursor: "c1" })
      .mockResolvedValueOnce({ items: [{ id: "r3" }], cursor: null });

    await runConnectReceived(client as never, { account: "acc_1", all: true } as ConnectArgs, out);

    const writtenLines = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string);
    const ndjsonLines = writtenLines.filter((l) => l.trim().startsWith("{"));
    expect(ndjsonLines).toHaveLength(3);
  });

  it("connect received --all — slim NDJSON lines carry the v2 slim fields (id/created_at/user.public_identifier kept, user.profile_url/description dropped)", async () => {
    const { runConnectReceived } = await import("../../src/commands/connect.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    (accountNs.invites.listReceived as Mock).mockResolvedValueOnce({
      items: [
        {
          object: "invitation_received",
          id: "RECEIVED_r1",
          created_at: "2026-06-29T00:00:00Z",
          user: {
            id: "ACoAASenderOne",
            type: "individual",
            display_name: "Sender One",
            first_name: "Sender",
            last_name: "One",
            public_picture_url: "https://media.licdn.com/sender-one.jpg",
            public_identifier: "sender-one",
            profile_url: "https://www.linkedin.com/in/sender-one",
            description: "Head of X",
          },
        },
      ],
      cursor: null,
    });

    await runConnectReceived(client as never, { account: "acc_1", all: true } as ConnectArgs, out);

    const lines = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).filter((l) => l.trim().startsWith("{"));
    expect(lines).toHaveLength(1);
    const item = JSON.parse(lines.join("")) as Record<string, unknown>;
    // Per-item slim shape — NOT the collapsed envelope {object,items,cursor}.
    expect(item["id"]).toBe("RECEIVED_r1");
    expect(item["created_at"]).toBe("2026-06-29T00:00:00Z");
    expect(item["user"]).toEqual({
      id: "ACoAASenderOne",
      display_name: "Sender One",
      first_name: "Sender",
      last_name: "One",
      public_identifier: "sender-one",
    });
    expect(item).not.toHaveProperty("object");
    expect(item).not.toHaveProperty("items");
  });

  it("connect received --all --verbose — NDJSON lines carry the raw item unprojected", async () => {
    const { runConnectReceived } = await import("../../src/commands/connect.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    (accountNs.invites.listReceived as Mock).mockResolvedValueOnce({
      items: [
        {
          object: "invitation_received",
          id: "RECEIVED_r1",
          user: { id: "ACoAASenderOne", type: "individual", public_identifier: "sender-one" },
        },
      ],
      cursor: null,
    });

    await runConnectReceived(client as never, { account: "acc_1", all: true, verbose: true } as ConnectArgs, out);

    const lines = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).filter((l) => l.trim().startsWith("{"));
    const item = JSON.parse(lines.join("")) as Record<string, unknown>;
    expect(item["object"]).toBe("invitation_received");
    expect((item["user"] as Record<string, unknown>)["type"]).toBe("individual");
  });
});

describe("connect accept / decline / cancel — writes, invitation_id NOT resolved", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.invites.accept as Mock).mockResolvedValue({ status: "accepted" });
    (accountNs.invites.decline as Mock).mockResolvedValue({ status: "declined" });
    (accountNs.invites.cancel as Mock).mockResolvedValue({ status: "cancelled" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("connect accept <id> — calls invites.accept with the verbatim id, bodyless", async () => {
    const { runConnectAccept } = await import("../../src/commands/connect.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runConnectAccept(client as never, {
      id: "inv_123",
      account: "acc_1",
      json: true,
    } as ConnectArgs, out);

    expect(client.account).toHaveBeenCalledWith("acc_1");
    expect(accountNs.invites.accept).toHaveBeenCalledWith("inv_123");
    expect((accountNs.invites.accept as Mock).mock.calls[0]).toHaveLength(1);
    expect(accountNs.invites.decline).not.toHaveBeenCalled();
  });

  it("connect decline <id> — calls invites.decline with the verbatim id, bodyless", async () => {
    const { runConnectDecline } = await import("../../src/commands/connect.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runConnectDecline(client as never, {
      id: "inv_999",
      account: "acc_1",
      json: true,
    } as ConnectArgs, out);

    expect(accountNs.invites.decline).toHaveBeenCalledWith("inv_999");
    expect((accountNs.invites.decline as Mock).mock.calls[0]).toHaveLength(1);
    expect(accountNs.invites.accept).not.toHaveBeenCalled();
  });

  it("connect accept — without --account exits 2 before any SDK call", async () => {
    const { runConnectAccept } = await import("../../src/commands/connect.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runConnectAccept(client as never, { id: "inv_123" } as ConnectArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(accountNs.invites.accept).not.toHaveBeenCalled();
  });

  it("connect accept --preview — renders the bodyless preview without calling accept", async () => {
    const { runConnectAccept } = await import("../../src/commands/connect.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runConnectAccept(client as never, {
      id: "inv_123",
      account: "acc_1",
      preview: true,
    } as ConnectArgs, out);

    expect(accountNs.invites.accept).not.toHaveBeenCalled();
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.method).toBe("invites.accept");
    // accept/decline are bodyless.
    expect(parsed.body).toEqual({});
  });

  it("connect decline --preview — renders the bodyless preview without calling decline", async () => {
    const { runConnectDecline } = await import("../../src/commands/connect.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runConnectDecline(client as never, {
      id: "inv_123",
      account: "acc_1",
      preview: true,
    } as ConnectArgs, out);

    expect(accountNs.invites.decline).not.toHaveBeenCalled();
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.method).toBe("invites.decline");
    expect(parsed.body).toEqual({});
  });

  it("connect cancel <id> — calls cancel with verbatim id (not URL-resolved)", async () => {
    const { runConnectCancel } = await import("../../src/commands/connect.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    // invitation_id could look like a URL-ish string but must NOT be resolved
    await runConnectCancel(client as never, {
      id: "inv_abc",
      account: "acc_1",
      json: true,
    } as ConnectArgs, out);

    expect(accountNs.invites.cancel).toHaveBeenCalledWith("inv_abc");
  });

  it("connect cancel --preview — renders preview without calling cancel", async () => {
    const { runConnectCancel } = await import("../../src/commands/connect.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runConnectCancel(client as never, {
      id: "inv_abc",
      account: "acc_1",
      preview: true,
    } as ConnectArgs, out);

    expect(accountNs.invites.cancel).not.toHaveBeenCalled();
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.method).toBe("invites.cancel");
  });
});

// ---------------------------------------------------------------------------
// Pagination flag suppression on write commands
// ---------------------------------------------------------------------------

const PAGINATION_FLAGS = ["limit", "cursor", "all", "max-pages", "fields"] as const;

describe("connect write commands — no pagination flags in args definition", () => {
  it("connect (send root) — args definition has no pagination/projection flags", async () => {
    const { connectCommand } = await import("../../src/commands/connect.js");
    const args = (connectCommand as Record<string, unknown>).args as Record<string, unknown>;
    for (const flag of PAGINATION_FLAGS) {
      expect(args, `connect root args must NOT include --${flag}`).not.toHaveProperty(flag);
    }
  });

  it("connect accept / decline — args definition has no pagination/projection flags", async () => {
    const { connectCommand } = await import("../../src/commands/connect.js");
    const subCmds = (connectCommand as Record<string, unknown>).subCommands as Record<
      string,
      { args?: Record<string, unknown> }
    >;
    for (const name of ["accept", "decline"]) {
      const args = subCmds[name]?.args ?? {};
      for (const flag of PAGINATION_FLAGS) {
        expect(args, `connect ${name} args must NOT include --${flag}`).not.toHaveProperty(flag);
      }
    }
  });

  it("connect cancel — args definition has no pagination/projection flags", async () => {
    const { connectCommand } = await import("../../src/commands/connect.js");
    const subCmds = (connectCommand as Record<string, unknown>).subCommands as Record<
      string,
      { args?: Record<string, unknown> }
    >;
    const cancelArgs = subCmds["cancel"]?.args ?? {};
    for (const flag of PAGINATION_FLAGS) {
      expect(cancelArgs, `connect cancel args must NOT include --${flag}`).not.toHaveProperty(flag);
    }
  });

  it("connect sent — args definition DOES have pagination flags (list read, negative control)", async () => {
    const { connectCommand } = await import("../../src/commands/connect.js");
    const subCmds = (connectCommand as Record<string, unknown>).subCommands as Record<
      string,
      { args?: Record<string, unknown> }
    >;
    const sentArgs = subCmds["sent"]?.args ?? {};
    expect(sentArgs, "connect sent must have --limit").toHaveProperty("limit");
    expect(sentArgs, "connect sent must have --cursor").toHaveProperty("cursor");
    expect(sentArgs, "connect sent must have --all").toHaveProperty("all");
  });

  it("connect received — args definition DOES have pagination flags (list read, negative control)", async () => {
    const { connectCommand } = await import("../../src/commands/connect.js");
    const subCmds = (connectCommand as Record<string, unknown>).subCommands as Record<
      string,
      { args?: Record<string, unknown> }
    >;
    const receivedArgs = subCmds["received"]?.args ?? {};
    expect(receivedArgs, "connect received must have --limit").toHaveProperty("limit");
    expect(receivedArgs, "connect received must have --cursor").toHaveProperty("cursor");
    expect(receivedArgs, "connect received must have --all").toHaveProperty("all");
  });
});

// ---------------------------------------------------------------------------
// connect sent slim default
// ---------------------------------------------------------------------------

const SENT_STUB = {
  object: "invitation_list",
  items: [
    {
      object: "invitation_sent",
      id: "SENT_inv_1",
      created_at: "2026-01-01T00:00:00Z",
      message: "Hi!",
      user: {
        id: "ACoAAJdoe",
        type: "individual",
        display_name: "Jane Doe",
        first_name: "Jane",
        last_name: "Doe",
        public_picture_url: "https://media.licdn.com/jdoe.jpg",
      },
    },
  ],
  cursor: null,
};

describe("connect sent slim default", () => {
  it("slim mode drops user.type and user.public_picture_url, keeps required v2 fields", async () => {
    const { runConnectSent } = await import("../../src/commands/connect.js");
    const ns = {
      invites: {
        listSent: vi.fn().mockResolvedValue(SENT_STUB),
        listReceived: vi.fn(),
        send: vi.fn(),
        accept: vi.fn(),
        decline: vi.fn(),
        cancel: vi.fn(),
      },
    };
    const client = { account: vi.fn().mockReturnValue(ns) };
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runConnectSent(client as never, { account: "acc_A", json: true } as ConnectArgs, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as { items: Record<string, unknown>[] };
    const item = result.items[0]!;

    expect(item).toHaveProperty("id", "SENT_inv_1");
    expect(item).toHaveProperty("created_at", "2026-01-01T00:00:00Z");
    expect(item).toHaveProperty("message", "Hi!");
    expect(item["user"]).toEqual({
      id: "ACoAAJdoe",
      display_name: "Jane Doe",
      first_name: "Jane",
      last_name: "Doe",
    });
    expect(item).not.toHaveProperty("object");
  });

  it("--verbose restores user.type and user.public_picture_url to the full server response", async () => {
    const { runConnectSent } = await import("../../src/commands/connect.js");
    const ns = {
      invites: {
        listSent: vi.fn().mockResolvedValue(SENT_STUB),
        listReceived: vi.fn(),
        send: vi.fn(),
        accept: vi.fn(),
        decline: vi.fn(),
        cancel: vi.fn(),
      },
    };
    const client = { account: vi.fn().mockReturnValue(ns) };
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runConnectSent(
      client as never,
      { account: "acc_A", json: true, verbose: true } as ConnectArgs,
      out,
    );

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as { items: Record<string, unknown>[] };
    const item = result.items[0]!;

    expect(item).toHaveProperty("object", "invitation_sent");
    const user = item["user"] as Record<string, unknown>;
    expect(user["type"]).toBe("individual");
    expect(user["public_picture_url"]).toBe("https://media.licdn.com/jdoe.jpg");
  });
});

// ---------------------------------------------------------------------------
// connect received slim default
// ---------------------------------------------------------------------------

const RECEIVED_STUB = {
  object: "invitation_list",
  items: [
    {
      object: "invitation_received",
      id: "RECEIVED_inv_2",
      created_at: "2026-01-01T00:00:00Z",
      user: {
        id: "ACoAAJaneDoe",
        type: "individual",
        display_name: "Jane Doe",
        first_name: "Jane",
        last_name: "Doe",
        public_picture_url: "https://media.licdn.com/jane-doe.jpg",
        public_identifier: "jane-doe",
        profile_url: "https://www.linkedin.com/in/jane-doe",
        description: "Engineer",
      },
    },
  ],
  cursor: null,
};

describe("connect received slim default", () => {
  it("slim mode drops user.type/public_picture_url/profile_url/description, keeps identity fields", async () => {
    const { runConnectReceived } = await import("../../src/commands/connect.js");
    const ns = {
      invites: {
        listReceived: vi.fn().mockResolvedValue(RECEIVED_STUB),
        listSent: vi.fn(),
        send: vi.fn(),
        accept: vi.fn(),
        decline: vi.fn(),
        cancel: vi.fn(),
      },
    };
    const client = { account: vi.fn().mockReturnValue(ns) };
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runConnectReceived(
      client as never,
      { account: "acc_A", json: true } as ConnectArgs,
      out,
    );

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as { items: Record<string, unknown>[] };
    const item = result.items[0]!;

    expect(item).toHaveProperty("id", "RECEIVED_inv_2");
    expect(item).toHaveProperty("created_at", "2026-01-01T00:00:00Z");
    expect(item).not.toHaveProperty("object");

    const user = item["user"] as Record<string, unknown>;
    expect(user["id"]).toBe("ACoAAJaneDoe");
    expect(user["display_name"]).toBe("Jane Doe");
    expect(user["first_name"]).toBe("Jane");
    expect(user["last_name"]).toBe("Doe");
    expect(user["public_identifier"]).toBe("jane-doe");
    expect(user).not.toHaveProperty("type");
    expect(user).not.toHaveProperty("public_picture_url");
    expect(user).not.toHaveProperty("profile_url");
    expect(user).not.toHaveProperty("description");
  });

  it("--verbose restores user.type/public_picture_url/profile_url/description to the full server response", async () => {
    const { runConnectReceived } = await import("../../src/commands/connect.js");
    const ns = {
      invites: {
        listReceived: vi.fn().mockResolvedValue(RECEIVED_STUB),
        listSent: vi.fn(),
        send: vi.fn(),
        accept: vi.fn(),
        decline: vi.fn(),
        cancel: vi.fn(),
      },
    };
    const client = { account: vi.fn().mockReturnValue(ns) };
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runConnectReceived(
      client as never,
      { account: "acc_A", json: true, verbose: true } as ConnectArgs,
      out,
    );

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as { items: Record<string, unknown>[] };
    const item = result.items[0]!;

    expect(item["object"]).toBe("invitation_received");
    const user = item["user"] as Record<string, unknown>;
    expect(user["type"]).toBe("individual");
    expect(user["profile_url"]).toBe("https://www.linkedin.com/in/jane-doe");
    expect(user["description"]).toBe("Engineer");
  });
});

// ---------------------------------------------------------------------------
// Help string assertions — Tier-1 (exact strings)
// ---------------------------------------------------------------------------

describe("connect help strings — Tier-1", () => {
  it("connect (send) positional description contains provider_id", async () => {
    const { connectCommand } = await import("../../src/commands/connect.js");
    const args = (connectCommand as Record<string, unknown>).args as Record<
      string,
      { description?: string }
    >;
    const desc = args["id"]?.description ?? "";
    expect(desc).toContain("provider_id");
  });

  it("connect --note description mentions acceptance rates and char limit", async () => {
    const { connectCommand } = await import("../../src/commands/connect.js");
    const args = (connectCommand as Record<string, unknown>).args as Record<
      string,
      { description?: string }
    >;
    const desc = args["note"]?.description ?? "";
    expect(desc).toContain("Personalized messages increase acceptance rates");
    expect(desc).toMatch(/300 char|≤300 char/);
  });

  it("connect sent description contains pending and connect cancel cross-reference", async () => {
    const { connectCommand } = await import("../../src/commands/connect.js");
    const subCmds = (connectCommand as Record<string, unknown>).subCommands as Record<
      string,
      { meta?: { description?: string } }
    >;
    const desc = subCmds["sent"]?.meta?.description ?? "";
    expect(desc).toContain("pending");
    expect(desc).toContain("connect cancel");
  });

  it("connect received description contains pending and already-handled", async () => {
    const { connectCommand } = await import("../../src/commands/connect.js");
    const subCmds = (connectCommand as Record<string, unknown>).subCommands as Record<
      string,
      { meta?: { description?: string } }
    >;
    const desc = subCmds["received"]?.meta?.description ?? "";
    // Case-insensitive: the assertion is about the copy saying these two
    // things, not about where a sentence happens to break.
    expect(desc.toLowerCase()).toContain("pending");
    expect(desc.toLowerCase()).toContain("already-handled");
  });

  it("connect accept / decline positional id description references connect received as source", async () => {
    const { connectCommand } = await import("../../src/commands/connect.js");
    const subCmds = (connectCommand as Record<string, unknown>).subCommands as Record<
      string,
      { args?: Record<string, { description?: string }> }
    >;
    for (const name of ["accept", "decline"]) {
      const desc = subCmds[name]?.args?.["id"]?.description ?? "";
      expect(desc, `connect ${name} id desc`).toContain("connect received");
    }
  });

  it("the combined respond command is gone; accept / decline take no --shared-secret flag (bodyless)", async () => {
    const { connectCommand } = await import("../../src/commands/connect.js");
    const subCmds = (connectCommand as Record<string, unknown>).subCommands as Record<
      string,
      { args?: Record<string, unknown> }
    >;
    expect(subCmds["respond"]).toBeUndefined();
    expect(subCmds["accept"]?.args?.["shared-secret"]).toBeUndefined();
    expect(subCmds["decline"]?.args?.["shared-secret"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Help string assertions — Tier-2 (additional doc strings)
// ---------------------------------------------------------------------------

describe("connect help strings — Tier-2 additional doc strings", () => {
  it("connect sent description contains created_at and identifies the v2 recipient field", async () => {
    const { connectCommand } = await import("../../src/commands/connect.js");
    const subCmds = (connectCommand as Record<string, unknown>).subCommands as Record<
      string,
      { meta?: { description?: string } }
    >;
    const desc = subCmds["sent"]?.meta?.description ?? "";
    expect(desc).toContain("created_at");
    expect(desc).toContain("user.id");
  });

  it("connect sent description contains no-total-count workaround hint", async () => {
    const { connectCommand } = await import("../../src/commands/connect.js");
    const subCmds = (connectCommand as Record<string, unknown>).subCommands as Record<
      string,
      { meta?: { description?: string } }
    >;
    const desc = subCmds["sent"]?.meta?.description ?? "";
    expect(desc.toLowerCase()).toMatch(/no total count|count client-side/);
  });

  it("connect command description contains propagation delay note with 10-30 seconds", async () => {
    const { connectCommand } = await import("../../src/commands/connect.js");
    const meta = (connectCommand as Record<string, unknown>).meta as { description?: string };
    const desc = meta?.description ?? "";
    expect(desc).toMatch(/10.{0,5}30 seconds|propagation/i);
  });
});
