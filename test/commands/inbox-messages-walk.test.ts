/**
 * `inbox messages` under `--mode cache_only` is served only over a message
 * walk the API has seen run to its end. A single live page starts a new walk
 * and leaves the chat unservable from the store; `--all` walks to the end and
 * closes it. The help text says so, and an exit 14 on this command says how to
 * fix it.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Curviate } from "@curviate/sdk";
import { inboxCommand, runInboxGet, runInboxMessages } from "../../src/commands/inbox.js";

const ACCOUNT = "acc_01JQZK8N3XV4RTYWB2M6D5F0AC";

afterEach(() => vi.restoreAllMocks());

function clientAnswering(status: number, body: unknown): Curviate {
  return new Curviate({
    apiKey: "cvt_live_test",
    baseUrl: "https://walk.curviate.test",
    timeout: 5_000,
    maxRetries: 1,
    fetch: (async () =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch,
  });
}

const NOT_STORED = { code: "NOT_STORED", message: "Nothing is stored.", user_fixable: true, retry_likely_to_succeed: false };
const NOT_FOUND = { code: "RESOURCE_NOT_FOUND", message: "No such chat.", user_fixable: true, retry_likely_to_succeed: false };

async function drive(
  run: typeof runInboxMessages,
  client: Curviate,
  extraFlags: Record<string, unknown> = {},
): Promise<{ exit: number; stderr: string }> {
  const spy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`__exit__${code ?? 0}`);
  }) as never);
  const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
  let exit = 0;
  try {
    await run(
      client,
      { account: ACCOUNT, chatId: "chat_1", json: true, mode: "cache_only", ...extraFlags } as never,
      out,
    );
  } catch (e) {
    const m = /__exit__(\d+)/.exec((e as Error).message);
    exit = m ? Number(m[1]) : -1;
  } finally {
    spy.mockRestore();
  }
  return { exit, stderr: out.stderr.write.mock.calls.map((c) => String(c[0])).join("") };
}

describe("inbox messages: the walk caveat", () => {
  it("help states the one-page limit, the unfiltered page and --all", () => {
    const subs = (inboxCommand as unknown as { subCommands: Record<string, { meta: { description: string } }> })
      .subCommands;
    const desc = subs["messages"]!.meta.description;
    expect(desc).toContain("unfiltered");
    expect(desc).toContain("--all");
    expect(desc).toContain("cache_only");
    // The most common reason a chat is never servable: it does not fit one page.
    expect(desc).toMatch(/one page|single page/);
    expect(desc).toContain("--limit");
  });

  it("exit 14 on inbox messages prints the --all hint", async () => {
    const r = await drive(runInboxMessages, clientAnswering(422, NOT_STORED));
    expect(r.exit).toBe(14);
    // After the error line, the way every other hint reads.
    expect(r.stderr).toMatch(/^error \[NOT_STORED\][^\n]*\nhint: [^\n]*--all[^\n]*\n$/);
  });

  it.each([
    ["--before", { before: "2026-01-01T00:00:00Z" }],
    ["--after", { after: "2026-01-01T00:00:00Z" }],
    ["--cursor", { cursor: "opaque" }],
  ])("a filtered or cursored read gets NO --all hint (%s)", async (_label, flags) => {
    // Such a read is never served from the store and never touches the walk,
    // so "--all" is the wrong instruction.
    const r = await drive(runInboxMessages, clientAnswering(422, NOT_STORED), flags);
    expect(r.exit).toBe(14);
    expect(r.stderr).not.toContain("hint: ");
  });

  it("control: another error on the same command prints no hint", async () => {
    const r = await drive(runInboxMessages, clientAnswering(404, NOT_FOUND));
    expect(r.exit).toBe(4);
    expect(r.stderr).not.toContain("hint: ");
  });

  it("control: exit 14 on inbox get prints no walk hint (a single chat has no walk)", async () => {
    const r = await drive(runInboxGet, clientAnswering(422, NOT_STORED));
    expect(r.exit).toBe(14);
    expect(r.stderr).not.toContain("--all");
  });
});
