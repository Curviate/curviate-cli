/**
 * Tests for the `webhook` command group (root-scoped).
 *
 * Covers:
 *   webhook create     — webhooks.create() + --account-ids array + --preview
 *   webhook list       — webhooks.list() + --all pagination
 *   webhook events     — webhooks.listEvents() (non-paginated)
 *   webhook update     — webhooks.update() + --source is usage error (exit 2) + --preview
 *   webhook delete     — webhooks.delete() + --preview
 *   webhook verify     — offline constructEvent(): no Curviate client, valid → event+exit0, error → envelope+exit2
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { createHmac } from "node:crypto";

// ---------------------------------------------------------------------------
// Client mock factory (root-scoped webhooks)
// ---------------------------------------------------------------------------

function makeClient() {
  return {
    webhooks: {
      create: vi.fn(),
      list: vi.fn(),
      listEvents: vi.fn(),
      get: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  };
}

type Client = ReturnType<typeof makeClient>;

type WebhookFlags = {
  id?: string;
  "account-id"?: string;
  "account-ids"?: string;
  "request-url"?: string;
  source?: string;
  name?: string;
  enabled?: boolean;
  events?: string;
  data?: string;
  cursor?: string;
  limit?: string;
  all?: boolean;
  "max-pages"?: string;
  json?: boolean;
  fields?: string;
  preview?: boolean;
  // webhook verify flags
  secret?: string;
  header?: string;
  body?: string;
  "max-age-secs"?: string;
  "api-key"?: string;
  "base-url"?: string;
  timeout?: string;
  profile?: string;
};

function makeOut() {
  return {
    stdout: { write: vi.fn() },
    stderr: { write: vi.fn() },
  };
}

// ---------------------------------------------------------------------------
// HMAC helper for webhook verify tests
// ---------------------------------------------------------------------------

/**
 * Build a valid `X-Curviate-Signature` header for a given secret + body.
 * Mirrors the SDK's own HMAC-SHA256(secret, "<timestamp>.<body>") approach.
 */
function buildSignatureHeader(secret: string, bodyStr: string, nowSecs?: number): string {
  const t = nowSecs ?? Math.floor(Date.now() / 1000);
  const payload = `${t}.${bodyStr}`;
  const hmac = createHmac("sha256", secret).update(payload).digest("hex");
  return `t=${t},v1=${hmac}`;
}

// ---------------------------------------------------------------------------
// webhook create
// ---------------------------------------------------------------------------

describe("webhook create", () => {
  let client: Client;

  beforeEach(() => {
    client = makeClient();
    (client.webhooks.create as Mock).mockResolvedValue({ object: "webhook", id: "wh_1" });
  });

  afterEach(() => vi.restoreAllMocks());

  it("calls webhooks.create with source, request_url, account_ids array", async () => {
    const { runWebhookCreate } = await import("../../src/commands/webhook.js");
    const out = makeOut();
    await runWebhookCreate(client as never, {
      source: "messaging",
      "request-url": "https://example.com/hook",
      "account-ids": "acc_1,acc_2",
      json: true,
    } as WebhookFlags, out);

    expect(client.webhooks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "messaging",
        request_url: "https://example.com/hook",
        account_ids: ["acc_1", "acc_2"],
      }),
    );
  });

  it("missing --source exits 2", async () => {
    const { runWebhookCreate } = await import("../../src/commands/webhook.js");
    const out = makeOut();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runWebhookCreate(client as never, {
        "request-url": "https://example.com/hook",
        "account-ids": "acc_1",
      } as WebhookFlags, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(client.webhooks.create).not.toHaveBeenCalled();
  });

  it("missing --request-url exits 2", async () => {
    const { runWebhookCreate } = await import("../../src/commands/webhook.js");
    const out = makeOut();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runWebhookCreate(client as never, {
        source: "messaging",
        "account-ids": "acc_1",
      } as WebhookFlags, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(client.webhooks.create).not.toHaveBeenCalled();
  });

  it("missing --account-ids exits 2", async () => {
    const { runWebhookCreate } = await import("../../src/commands/webhook.js");
    const out = makeOut();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runWebhookCreate(client as never, {
        source: "messaging",
        "request-url": "https://example.com/hook",
      } as WebhookFlags, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(client.webhooks.create).not.toHaveBeenCalled();
  });

  it("--preview renders request without calling create", async () => {
    const { runWebhookCreate } = await import("../../src/commands/webhook.js");
    const out = makeOut();
    await runWebhookCreate(client as never, {
      source: "messaging",
      "request-url": "https://example.com/hook",
      "account-ids": "acc_1",
      preview: true,
    } as WebhookFlags, out);

    expect(client.webhooks.create).not.toHaveBeenCalled();
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.method).toBe("webhooks.create");
  });

  it("dead --format flag removed: a stray format field is never forwarded to the body", async () => {
    const { runWebhookCreate } = await import("../../src/commands/webhook.js");
    const out = makeOut();
    await runWebhookCreate(client as never, {
      source: "messaging",
      "request-url": "https://example.com/hook",
      "account-ids": "acc_1",
      // Simulates a caller still passing the removed flag through the typed
      // object (e.g. a stale script) — the server silently ignores `format`
      // and always persists `json`, so the CLI must not send it either.
      format: "form",
      json: true,
    } as WebhookFlags, out);

    expect(client.webhooks.create).toHaveBeenCalledWith(
      expect.not.objectContaining({ format: expect.anything() }),
    );
  });
});

// ---------------------------------------------------------------------------
// webhook list
// ---------------------------------------------------------------------------

describe("webhook list", () => {
  let client: Client;

  beforeEach(() => {
    client = makeClient();
    (client.webhooks.list as Mock).mockResolvedValue({ items: [{ id: "wh_1" }], cursor: null });
  });

  afterEach(() => vi.restoreAllMocks());

  it("calls webhooks.list()", async () => {
    const { runWebhookList } = await import("../../src/commands/webhook.js");
    const out = makeOut();
    await runWebhookList(client as never, { json: true } as WebhookFlags, out);
    expect(client.webhooks.list).toHaveBeenCalled();
  });

  it("--all streams NDJSON over two pages", async () => {
    const { runWebhookList } = await import("../../src/commands/webhook.js");
    const out = makeOut();
    (client.webhooks.list as Mock)
      .mockResolvedValueOnce({ items: [{ id: "wh_1" }, { id: "wh_2" }], cursor: "c1" })
      .mockResolvedValueOnce({ items: [{ id: "wh_3" }], cursor: null });

    await runWebhookList(client as never, { all: true } as WebhookFlags, out);

    const lines = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string);
    const ndjson = lines.filter((l) => l.trim().startsWith("{"));
    expect(ndjson).toHaveLength(3);
  });

  it("--preview on a read exits 2", async () => {
    const { runWebhookList } = await import("../../src/commands/webhook.js");
    const out = makeOut();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runWebhookList(client as never, { preview: true } as WebhookFlags, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// webhook events
// ---------------------------------------------------------------------------

describe("webhook events", () => {
  let client: Client;

  beforeEach(() => {
    client = makeClient();
    (client.webhooks.listEvents as Mock).mockResolvedValue({ items: [{ event: "message.received" }] });
  });

  afterEach(() => vi.restoreAllMocks());

  it("calls webhooks.listEvents()", async () => {
    const { runWebhookEvents } = await import("../../src/commands/webhook.js");
    const out = makeOut();
    await runWebhookEvents(client as never, { json: true } as WebhookFlags, out);
    expect(client.webhooks.listEvents).toHaveBeenCalled();
  });

  it("--all on non-paginated exits 2", async () => {
    const { runWebhookEvents } = await import("../../src/commands/webhook.js");
    const out = makeOut();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runWebhookEvents(client as never, { all: true } as WebhookFlags, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("--preview on a read exits 2", async () => {
    const { runWebhookEvents } = await import("../../src/commands/webhook.js");
    const out = makeOut();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runWebhookEvents(client as never, { preview: true } as WebhookFlags, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// webhook get
// ---------------------------------------------------------------------------

describe("webhook get", () => {
  let client: Client;

  beforeEach(() => {
    client = makeClient();
    (client.webhooks.get as Mock).mockResolvedValue({ object: "webhook", id: "wh_1" });
  });

  afterEach(() => vi.restoreAllMocks());

  it("calls webhooks.get with verbatim id", async () => {
    const { runWebhookGet } = await import("../../src/commands/webhook.js");
    const out = makeOut();
    await runWebhookGet(client as never, { id: "wh_1", json: true } as WebhookFlags, out);
    expect(client.webhooks.get).toHaveBeenCalledWith("wh_1");
  });

  it("--preview on a read exits 2", async () => {
    const { runWebhookGet } = await import("../../src/commands/webhook.js");
    const out = makeOut();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runWebhookGet(client as never, { id: "wh_1", preview: true } as WebhookFlags, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(client.webhooks.get).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// webhook update
// ---------------------------------------------------------------------------

describe("webhook update", () => {
  let client: Client;

  beforeEach(() => {
    client = makeClient();
    (client.webhooks.update as Mock).mockResolvedValue({ object: "webhook", id: "wh_1" });
  });

  afterEach(() => vi.restoreAllMocks());

  it("calls webhooks.update with id + body fields", async () => {
    const { runWebhookUpdate } = await import("../../src/commands/webhook.js");
    const out = makeOut();
    await runWebhookUpdate(client as never, {
      id: "wh_1",
      name: "new-name",
      json: true,
    } as WebhookFlags, out);

    expect(client.webhooks.update).toHaveBeenCalledWith(
      "wh_1",
      expect.objectContaining({ name: "new-name" }),
    );
  });

  it("--source on update is a usage error → exit 2 (source is immutable)", async () => {
    const { runWebhookUpdate } = await import("../../src/commands/webhook.js");
    const out = makeOut();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runWebhookUpdate(client as never, {
        id: "wh_1",
        source: "user",
        name: "x",
      } as WebhookFlags, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(client.webhooks.update).not.toHaveBeenCalled();
  });

  it("--preview renders request without calling update", async () => {
    const { runWebhookUpdate } = await import("../../src/commands/webhook.js");
    const out = makeOut();
    await runWebhookUpdate(client as never, {
      id: "wh_1",
      name: "renamed",
      preview: true,
    } as WebhookFlags, out);

    expect(client.webhooks.update).not.toHaveBeenCalled();
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.method).toBe("webhooks.update");
    expect(parsed.args).toHaveProperty("id", "wh_1");
  });

  it("dead --format flag removed: a stray format field is never forwarded to the body", async () => {
    const { runWebhookUpdate } = await import("../../src/commands/webhook.js");
    const out = makeOut();
    await runWebhookUpdate(client as never, {
      id: "wh_1",
      name: "renamed",
      format: "form",
      json: true,
    } as WebhookFlags, out);

    expect(client.webhooks.update).toHaveBeenCalledWith(
      "wh_1",
      expect.not.objectContaining({ format: expect.anything() }),
    );
  });
});

// ---------------------------------------------------------------------------
// webhook delete
// ---------------------------------------------------------------------------

describe("webhook delete", () => {
  let client: Client;

  beforeEach(() => {
    client = makeClient();
    (client.webhooks.delete as Mock).mockResolvedValue({ object: "webhook_deleted", id: "wh_1" });
  });

  afterEach(() => vi.restoreAllMocks());

  it("calls webhooks.delete with verbatim id", async () => {
    const { runWebhookDelete } = await import("../../src/commands/webhook.js");
    const out = makeOut();
    await runWebhookDelete(client as never, { id: "wh_1", json: true } as WebhookFlags, out);
    expect(client.webhooks.delete).toHaveBeenCalledWith("wh_1");
  });

  it("--preview renders request without calling delete", async () => {
    const { runWebhookDelete } = await import("../../src/commands/webhook.js");
    const out = makeOut();
    await runWebhookDelete(client as never, { id: "wh_1", preview: true } as WebhookFlags, out);
    expect(client.webhooks.delete).not.toHaveBeenCalled();
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.method).toBe("webhooks.delete");
  });
});

// ---------------------------------------------------------------------------
// webhook verify (offline constructEvent — no Curviate client, no network)
// ---------------------------------------------------------------------------

describe("webhook verify", () => {
  afterEach(() => vi.restoreAllMocks());

  const SECRET = "whsec_testkey123";
  const EVENT_BODY = JSON.stringify({ type: "message.received", data: { account_id: "acc_1" } });

  it("valid signature → event JSON on stdout, exit 0, NO createClient called", async () => {
    const { runWebhookVerify } = await import("../../src/commands/webhook.js");
    const out = makeOut();

    const header = buildSignatureHeader(SECRET, EVENT_BODY);

    // Verify that the client factory is NEVER invoked — runWebhookVerify is
    // purely offline (no network, no Curviate client).
    const clientModule = await import("../../src/lib/client.js");
    const createClientSpy = vi.spyOn(clientModule, "createClient").mockImplementation(() => {
      throw new Error("createClient should NOT be called in webhook verify");
    });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });

    // Run with the raw body string directly (not a file path for the unit test)
    await runWebhookVerify({
      secret: SECRET,
      signatureHeader: header,
      rawBody: EVENT_BODY,
    }, out);

    // No exit was called (exit 0 = success means we just return)
    expect(exitSpy).not.toHaveBeenCalled();
    expect(createClientSpy).not.toHaveBeenCalled();

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.type).toBe("message.received");

    createClientSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("replay (stale timestamp) → error envelope on stdout, exit 2", async () => {
    const { runWebhookVerify } = await import("../../src/commands/webhook.js");
    const out = makeOut();

    // 10 minutes ago — replay window default is 5 minutes
    const staleSecs = Math.floor(Date.now() / 1000) - 600;
    const header = buildSignatureHeader(SECRET, EVENT_BODY, staleSecs);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runWebhookVerify({ secret: SECRET, signatureHeader: header, rawBody: EVENT_BODY }, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.error).toBeDefined();
    expect(parsed.error.name).toBe("WebhookSignatureError");
    expect(parsed.error.reason).toBe("replay_detected");
  });

  it("bad HMAC → error envelope with reason=invalid_signature, exit 2", async () => {
    const { runWebhookVerify } = await import("../../src/commands/webhook.js");
    const out = makeOut();

    const nowSecs = Math.floor(Date.now() / 1000);
    const badHeader = `t=${nowSecs},v1=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef`;

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runWebhookVerify({ secret: SECRET, signatureHeader: badHeader, rawBody: EVENT_BODY }, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.error.reason).toBe("invalid_signature");
  });

  it("malformed header (missing v1) → error envelope with reason=malformed_header, exit 2", async () => {
    const { runWebhookVerify } = await import("../../src/commands/webhook.js");
    const out = makeOut();

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runWebhookVerify({
        secret: SECRET,
        signatureHeader: "t=12345",  // missing v1=
        rawBody: EVENT_BODY,
      }, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.error.reason).toBe("malformed_header");
  });

  it("secret is NOT echoed in stdout or stderr", async () => {
    const { runWebhookVerify } = await import("../../src/commands/webhook.js");
    const out = makeOut();

    const header = buildSignatureHeader(SECRET, EVENT_BODY);

    // valid call — should succeed
    await runWebhookVerify({ secret: SECRET, signatureHeader: header, rawBody: EVENT_BODY }, out);

    const allOut = [
      ...(out.stdout.write as Mock).mock.calls.map((c) => c[0] as string),
      ...(out.stderr.write as Mock).mock.calls.map((c) => c[0] as string),
    ].join("");

    expect(allOut).not.toContain(SECRET);
  });

  it("--max-age-secs overrides the replay window", async () => {
    const { runWebhookVerify } = await import("../../src/commands/webhook.js");
    const out = makeOut();

    // 10-second-old timestamp; with max-age-secs=5, it should be rejected
    const staleSecs = Math.floor(Date.now() / 1000) - 10;
    const header = buildSignatureHeader(SECRET, EVENT_BODY, staleSecs);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runWebhookVerify({
        secret: SECRET,
        signatureHeader: header,
        rawBody: EVENT_BODY,
        replayWindowSecs: 5,
      }, out);
      expect.fail("should have been rejected");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });
});
