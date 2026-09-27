/**
 * `message inmail --subject <s>`.
 *
 * `POST /v1/{account_id}/messages/inmail` requires `subject` (1-200 chars,
 * unlike `message new`'s optional chat subject). citty's own `required: true`
 * already rejects a fully omitted `--subject` before this function runs; an
 * explicitly empty or whitespace-only value is still "given" as far as citty
 * is concerned, so the command-level guard is what catches it.
 *
 * Pinned here:
 *   - ""/blank -> exit 2 before --to resolution (no users.get) or sendInMail
 *   - > 200    -> exit 2, naming the served limit, before the round trip
 *   - present  -> reaches sendInMail verbatim (same-path positive control)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

function makeNs() {
  return {
    users: { get: vi.fn() },
    messaging: { sendInMail: vi.fn() },
  };
}

function makeClient(ns: ReturnType<typeof makeNs>) {
  return { account: vi.fn().mockReturnValue(ns) };
}

function mockExit() {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
}

describe("message inmail --subject", () => {
  let ns: ReturnType<typeof makeNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeNs();
    ns.messaging.sendInMail.mockResolvedValue({ object: "inmail_sent", chat_id: "chat_1", message_id: "msg_1" });
    client = makeClient(ns);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function inmail(extra: Record<string, unknown>) {
    const { runMessageInMail } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    await runMessageInMail(
      client as never,
      { to: "ACoAAA123", text: "Hello", account: "acc_1", json: true, ...extra } as never,
      out,
    );
    return out;
  }

  it("sends --subject through to sendInMail verbatim", async () => {
    await inmail({ subject: "Agent tooling" });
    expect(ns.messaging.sendInMail).toHaveBeenCalledWith(
      expect.objectContaining({ recipient_urn: "ACoAAA123", text: "Hello", subject: "Agent tooling" }),
    );
  });

  it.each([["", "empty"], ["   ", "whitespace-only"]])(
    "refuses a %s --subject with exit 2 before any request",
    async (subject) => {
      const exit = mockExit();
      const out = await inmail({ subject, to: "raphael-redmer" }).catch((e: Error) => e);
      expect(String(out)).toContain("process.exit(2)");
      expect(exit).toHaveBeenCalledWith(2);
      // --to is a bare slug here: if subject were checked after --to
      // resolution, users.get would already have fired.
      expect(ns.users.get).not.toHaveBeenCalled();
      expect(ns.messaging.sendInMail).not.toHaveBeenCalled();
    },
  );

  it("refuses a subject over the served 200-character limit with exit 2 and sends nothing", async () => {
    const exit = mockExit();
    const out = await inmail({ subject: "x".repeat(201) }).catch((e: Error) => e);
    expect(String(out)).toContain("process.exit(2)");
    expect(exit).toHaveBeenCalledWith(2);
    expect(ns.messaging.sendInMail).not.toHaveBeenCalled();
  });

  it("accepts a subject at exactly 200 characters (boundary, same path)", async () => {
    const subject = "x".repeat(200);
    await inmail({ subject });
    expect(ns.messaging.sendInMail).toHaveBeenCalledWith(expect.objectContaining({ subject }));
  });

  it("carries --subject into --preview without calling the API", async () => {
    const out = await inmail({ subject: "Intro", preview: true, account: "acc_1" });
    expect(ns.messaging.sendInMail).not.toHaveBeenCalled();
    const written = out.stdout.write.mock.calls.map((c) => String(c[0])).join("");
    expect(written).toContain("Intro");
  });
});
