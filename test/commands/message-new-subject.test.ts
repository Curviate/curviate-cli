/**
 * `message new --subject <s>`.
 *
 * `POST /v1/{account_id}/chats` has always accepted an optional `subject`
 * (<= 200 chars) and round-trips it onto the opening message, and MCP's
 * `start_chat` exposes it. The CLI never followed, so the capability was
 * unreachable from the command line — an unfinished ripple, not a missing
 * server feature. `message inmail` already had `--subject`.
 *
 * Pinned here:
 *   - present  -> `subject` is in the startChat body, verbatim
 *   - omitted  -> the key is ABSENT from the body (not `subject: ""`; the
 *     server has no `.min(1)` on it, so an empty string would reach the
 *     platform as a chat named "" rather than an unnamed chat)
 *   - ""/blank -> exit 2, same lost-value ruling as `--cursor ""`
 *   - > 200    -> exit 2, naming the served limit, before the round trip
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

function makeNs() {
  return {
    users: { get: vi.fn() },
    messaging: { startChat: vi.fn() },
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

describe("message new --subject", () => {
  let ns: ReturnType<typeof makeNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeNs();
    ns.messaging.startChat.mockResolvedValue({ object: "chat", id: "chat_1" });
    client = makeClient(ns);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function newChat(extra: Record<string, unknown>) {
    const { runMessageNew } = await import("../../src/commands/message.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    await runMessageNew(
      client as never,
      { to: "ACoAAA123", text: "Hello", account: "acc_1", json: true, ...extra } as never,
      out,
    );
    return out;
  }

  it("passes --subject through to the chats POST body", async () => {
    await newChat({ subject: "Intro from Ralf" });
    expect(ns.messaging.startChat).toHaveBeenCalledWith(
      expect.objectContaining({ attendees_ids: ["ACoAAA123"], text: "Hello", subject: "Intro from Ralf" }),
    );
  });

  it("omits the key entirely when --subject is not given", async () => {
    await newChat({});
    expect(ns.messaging.startChat).toHaveBeenCalledTimes(1);
    const body = ns.messaging.startChat.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(body)).not.toContain("subject");
  });

  it.each([["", "empty"], ["   ", "whitespace-only"]])("refuses a %s --subject with exit 2 and sends nothing", async (subject) => {
    const exit = mockExit();
    const out = await newChat({ subject }).catch((e: Error) => e);
    expect(String(out)).toContain("process.exit(2)");
    expect(exit).toHaveBeenCalledWith(2);
    expect(ns.messaging.startChat).not.toHaveBeenCalled();
  });

  it("refuses a subject over the served 200-character limit with exit 2 and sends nothing", async () => {
    const exit = mockExit();
    const out = await newChat({ subject: "x".repeat(201) }).catch((e: Error) => e);
    expect(String(out)).toContain("process.exit(2)");
    expect(exit).toHaveBeenCalledWith(2);
    expect(ns.messaging.startChat).not.toHaveBeenCalled();
  });

  it("accepts a subject at exactly 200 characters (boundary, same path)", async () => {
    const subject = "x".repeat(200);
    await newChat({ subject });
    expect(ns.messaging.startChat).toHaveBeenCalledWith(expect.objectContaining({ subject }));
  });

  it("carries --subject into --preview without calling the API", async () => {
    const out = await newChat({ subject: "Intro", preview: true });
    expect(ns.messaging.startChat).not.toHaveBeenCalled();
    const written = out.stdout.write.mock.calls.map((c) => String(c[0])).join("");
    expect(written).toContain("Intro");
  });
});
