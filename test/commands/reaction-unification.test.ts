/**
 * Reaction-signature unification.
 *
 * Four sibling reaction commands previously used three conventions and two
 * flag names. They are unified on the POSITIONAL form (matching
 * comment react/unreact and post unreact):
 *   post react   <post_id> <reaction>        (was: --reaction)
 *   message react <chat_id> <message_id> <emoji>   (was: --emoji)
 * The old flags (`--reaction`, `--emoji`) are kept as documented-deprecated
 * aliases for back-compat (no breaking removal in a patch release).
 *
 * Two layers:
 *   1. Run-function behavior — the canonical positional wins, the deprecated
 *      flag alias is still honored, positional beats alias when both appear,
 *      and a missing value is a usage error (exit 2) not a silent empty body.
 *   2. End-to-end through the built bin — `post react ID like` and
 *      `post react ID --reaction like` render the identical preview body, and
 *      likewise for `message react`.
 */

import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { spawnSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { SPAWN_TIMEOUT_MS, spawnTestTimeout } from "../helpers/spawn-budget.js";

// Vitest's default (5s) is shorter than the built-bin spawn's own timeout
// below (see spawn-budget.ts). Only the section 2 describes actually spawn,
// but a file-wide default is harmless for the section 1 in-process tests.
vi.setConfig({ testTimeout: spawnTestTimeout() });

// ---------------------------------------------------------------------------
// 1. Run-function behavior (no build required)
// ---------------------------------------------------------------------------

function makePostsNs() {
  return { posts: { react: vi.fn().mockResolvedValue({ object: "reaction_added" }) } };
}
function makeMsgNs() {
  return { messaging: { addReaction: vi.fn().mockResolvedValue({ object: "reaction_added" }) } };
}
function makeClient(ns: unknown) {
  return { account: vi.fn().mockReturnValue(ns) };
}
function makeOut() {
  return { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
}
function expectExit2(fn: () => Promise<void>) {
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  return { exitSpy, run: fn };
}

describe("post react — positional reaction + --reaction alias", () => {
  afterEach(() => vi.restoreAllMocks());

  it("canonical positional: flags.reaction drives the body", async () => {
    const { runPostReact } = await import("../../src/commands/post.js");
    const ns = makePostsNs();
    const out = makeOut();
    await runPostReact(makeClient(ns) as never, { postId: "p1", reaction: "like", account: "acc_1", json: true } as never, out);
    expect(ns.posts.react).toHaveBeenCalledWith("p1", { reaction: "like" });
  });

  it("deprecated alias: --reaction (reactionAlias) is honored when the positional is absent", async () => {
    const { runPostReact } = await import("../../src/commands/post.js");
    const ns = makePostsNs();
    const out = makeOut();
    await runPostReact(makeClient(ns) as never, { postId: "p1", reactionAlias: "celebrate", account: "acc_1", json: true } as never, out);
    expect(ns.posts.react).toHaveBeenCalledWith("p1", { reaction: "celebrate" });
  });

  it("positional wins when both the positional and the alias are supplied", async () => {
    const { runPostReact } = await import("../../src/commands/post.js");
    const ns = makePostsNs();
    const out = makeOut();
    await runPostReact(makeClient(ns) as never, { postId: "p1", reaction: "love", reactionAlias: "funny", account: "acc_1", json: true } as never, out);
    expect(ns.posts.react).toHaveBeenCalledWith("p1", { reaction: "love" });
  });

  it("no reaction at all → exit 2, no SDK call", async () => {
    const { runPostReact } = await import("../../src/commands/post.js");
    const ns = makePostsNs();
    const out = makeOut();
    const { exitSpy } = expectExit2(() => Promise.resolve());
    await expect(
      runPostReact(makeClient(ns) as never, { postId: "p1", account: "acc_1" } as never, out),
    ).rejects.toThrow("process.exit(2)");
    expect(ns.posts.react).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});

describe("message react — positional emoji + --emoji alias", () => {
  afterEach(() => vi.restoreAllMocks());

  it("canonical positional: flags.emoji drives the body field `reaction`", async () => {
    const { runMessageReact } = await import("../../src/commands/message.js");
    const ns = makeMsgNs();
    const out = makeOut();
    await runMessageReact(makeClient(ns) as never, { chatId: "c1", messageId: "m1", emoji: "👍", account: "acc_1", json: true } as never, out);
    expect(ns.messaging.addReaction).toHaveBeenCalledWith("c1", "m1", { reaction: "👍" });
  });

  it("deprecated alias: --emoji (emojiAlias) is honored when the positional is absent", async () => {
    const { runMessageReact } = await import("../../src/commands/message.js");
    const ns = makeMsgNs();
    const out = makeOut();
    await runMessageReact(makeClient(ns) as never, { chatId: "c1", messageId: "m1", emojiAlias: "🎉", account: "acc_1", json: true } as never, out);
    expect(ns.messaging.addReaction).toHaveBeenCalledWith("c1", "m1", { reaction: "🎉" });
  });

  it("no emoji at all → exit 2, no SDK call", async () => {
    const { runMessageReact } = await import("../../src/commands/message.js");
    const ns = makeMsgNs();
    const out = makeOut();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    await expect(
      runMessageReact(makeClient(ns) as never, { chatId: "c1", messageId: "m1", account: "acc_1" } as never, out),
    ).rejects.toThrow("process.exit(2)");
    expect(ns.messaging.addReaction).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 2. End-to-end through the built bin — both forms produce the same body
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "../..");
const cliPath = resolve(pkgRoot, "dist", "cli.js");

function runBin(args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
    env: { ...process.env, NODE_ENV: "production", CURVIATE_API_KEY: "rdc_live_reaction_test_stub" },
  });
}

beforeAll(() => {
  if (!existsSync(cliPath)) execSync("pnpm build", { cwd: pkgRoot, stdio: "ignore" });
});

describe("post react — both forms render the same preview body (built bin)", () => {
  it("positional `post react ID like` renders reaction:like", () => {
    const r = runBin(["post", "react", "post_1", "like", "--preview", "--account", "acc_x"]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout.trim()) as { method: string; body: Record<string, unknown> };
    expect(parsed.method).toBe("posts.react");
    expect(parsed.body).toMatchObject({ reaction: "like" });
  });

  it("flag alias `post react ID --reaction like` renders the identical body", () => {
    const r = runBin(["post", "react", "post_1", "--reaction", "like", "--preview", "--account", "acc_x"]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout.trim()) as { method: string; body: Record<string, unknown> };
    expect(parsed.method).toBe("posts.react");
    expect(parsed.body).toMatchObject({ reaction: "like" });
  });

  it("an invalid positional reaction still exits 2 (enum validated)", () => {
    const r = runBin(["post", "react", "post_1", "thumbsup", "--preview", "--account", "acc_x"]);
    expect(r.status).toBe(2);
  });
});

describe("message react — both forms render the same preview body (built bin)", () => {
  it("positional `message react C M 👍` renders reaction:👍", () => {
    const r = runBin(["message", "react", "chat_1", "msg_1", "👍", "--preview", "--account", "acc_x"]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout.trim()) as { method: string; body: Record<string, unknown> };
    expect(parsed.method).toBe("messaging.addReaction");
    expect(parsed.body).toMatchObject({ reaction: "👍" });
  });

  it("flag alias `message react C M --emoji 👍` renders the identical body", () => {
    const r = runBin(["message", "react", "chat_1", "msg_1", "--emoji", "👍", "--preview", "--account", "acc_x"]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout.trim()) as { method: string; body: Record<string, unknown> };
    expect(parsed.method).toBe("messaging.addReaction");
    expect(parsed.body).toMatchObject({ reaction: "👍" });
  });
});
