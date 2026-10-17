/**
 * Argv -> handler routing for the write-bearing bare forms, through the CLI
 * entry point against a recording sink. The assertion is on what reached the
 * wire: a mistyped subcommand must never become a send or an invitation, and
 * a bare "-" must bind to the text positional and read stdin.
 */
import { describe, it, expect } from "vitest";
import { useSink, line } from "./helpers/sink.js";

const sink = useSink({ body: { id: "msg_stub", chat_id: "2-stub" } });
const REAL_CHAT_ID = "2-NmMyYzhlZWEtYjA5OS00OWQ0LWFhZjItYjBiYzUwZjcxYzM3XzEwMA==";
const A = ["--account", "acc_1"];
const segments = (url: string) => url.split(/[?#]/)[0]!.split("/").filter(Boolean).map(decodeURIComponent);
const previewOf = async (args: string[], stdin?: string) => {
  const r = await sink.run([...args, "--preview", ...A], { stdin });
  return { r, p: r.stdout.trim() ? (JSON.parse(r.stdout.trim()) as { method: string; args?: Record<string, unknown>; body?: Record<string, unknown> }) : undefined };
};

describe("a bare '-' text binds to the text positional and reads stdin", () => {
  it.each([
    [["message", "chat_9", "-"], "messaging.sendMessage"],
    [["message", "send", "chat_9", "-"], "messaging.sendMessage"],
    [["message", "new", "--to", "ACoAAA123", "-"], "messaging.startChat"],
    [["message", "edit", "chat_9", "msg_abc", "-"], "messaging.editMessage"],
    [["message", "inmail", "--to", "ACoAAA123", "--subject", "Hi", "-"], "messaging.sendInMail"],
  ])("%j -> %s with the trailing newline stripped and inner newlines kept", async (argv, method) => {
    const { r, p } = await previewOf(argv, "Line 1\nLine 2\n");
    expect(r.status, r.stderr).toBe(0);
    expect(p!.method).toBe(method);
    expect(p!.body!["text"]).toBe("Line 1\nLine 2");
    if (argv[1] === "send" || argv[1] === "chat_9") expect(p!.args!["chat_id"]).toBe("chat_9");
  });

  it.each([
    ["message", "chat_9", "-"],
    ["message", "new", "--to", "ACoAAA123", "-"],
    ["message", "edit", "chat_9", "msg_abc", "-"],
    ["message", "inmail", "--to", "ACoAAA123", "--subject", "Hi", "-"],
  ])("%j with empty stdin: exit 2, 'stdin: empty input', no preview, no request", async (...argv) => {
    const { r } = await previewOf(argv, "");
    expect([r.status, r.stdout.trim(), r.requests]).toEqual([2, "", []]);
    expect(r.stderr).toContain("stdin: empty input");
  });

  it("`message send <chat> <text>` targets the chat, not 'send'; `message new` stays a startChat, one line", async () => {
    const { p } = await previewOf(["message", "send", "chat_correct_123", "hi"]);
    expect(p!.args!["chat_id"]).toBe("chat_correct_123");
    const { r, p: n } = await previewOf(["message", "new", "--to", "ACoAAA123", "hello text"]);
    expect(n!.method).toBe("messaging.startChat");
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
  });
});

describe("message: an unknown subcommand must not send", () => {
  it.each(["search", "list", "find", "history", "read", "sned", "inmail-balence", "reply"])(
    "`message %s \"<text>\"` issues NO request and exits non-zero, naming the real subcommands",
    async (token) => {
      const r = await sink.run(["message", token, "hello there", ...A]);
      expect(r.requests).toEqual([]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/message/i);
      expect(r.stderr).toContain("send");
      expect(r.stderr).toContain("inmail");
    },
  );

  it("an unknown token alone, or with a message-looking text, still sends nothing", async () => {
    for (const args of [["message", "search"], ["message", "list", "Hi Sophie, following up on our conversation."]]) {
      const r = await sink.run([...args, ...A]);
      expect([r.requests, r.status === 0]).toEqual([[], false]);
    }
  });

  it.each([
    [["message", REAL_CHAT_ID, "hello there"]],
    [["message", `https://www.linkedin.com/messaging/thread/${REAL_CHAT_ID}/`, "hello there"]],
    [["message", "send", REAL_CHAT_ID, "hello there"]],
  ])("%j issues exactly one send on the one-segment chat path", async (argv) => {
    const r = await sink.run([...argv, "--account", "acc_x"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.requests).toHaveLength(1);
    expect(r.requests[0]!.method).toBe("POST");
    expect(segments(r.requests[0]!.url)).toEqual(["v1", "acc_x", "chats", REAL_CHAT_ID, "messages"]);
    expect(JSON.parse(r.requests[0]!.body)).toMatchObject({ text: "hello there" });
  });

  it("a COMPANY_ chat id sends; `message send` is the escape hatch for an unfamiliar chat id", async () => {
    for (const argv of [["message", "COMPANY_83734124_PRIMARY", "hi"], ["message", "send", "an-unusual-chat-id", "hi"]]) {
      const r = await sink.run([...argv, "--account", "acc_x"]);
      expect([r.status, r.requests.map(line)]).toEqual([0, [expect.stringMatching(/^POST /)]]);
    }
  });
});

describe("connect: a mistyped subcommand must not send an invitation", () => {
  it.each([
    ["snet", "sent"], ["sen", "sent"], ["recieved", "received"], ["acept", "accept"],
    ["accpet", "accept"], ["cancle", "cancel"], ["declien", "decline"],
  ])("`connect %s` issues NO request and points at `%s`", async (typo, intended) => {
    const r = await sink.run(["connect", typo, "--account", "acc_x"]);
    expect(r.requests).toEqual([]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(intended);
  });

  it.each(["raphael-redmer-123", "ACoAAABcDeFgHiJkLm", "https://www.linkedin.com/in/cancle/"])(
    "`connect %s` (a real slug, a provider id, a profile URL for a slug the guard flags) sends one invitation",
    async (id) => {
      const r = await sink.run(["connect", id, "--account", "acc_x"]);
      expect([r.status, r.requests.length, r.requests[0]?.method]).toEqual([0, 1, "POST"]);
    },
  );
});
