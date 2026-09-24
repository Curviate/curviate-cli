/**
 * Tests for the `post` command group.
 *
 * Coverage:
 *   post get <post_id>                                   → posts.get
 *   post create "<text>" [--attach…]                    → posts.create (v2: JSON only, no multipart)
 *   post react <post_id> --reaction <r>                 → posts.react (body field: `reaction`)
 *   post reactions <post_id>                            → posts.listReactions (paginated)
 *
 * Comment operations moved to the dedicated `comment` command group.
 *
 * --preview on writes: renders preview, no SDK call.
 * --preview on reads: exit 2.
 * --attach missing file: exit 2 before SDK call.
 * --all rejected on non-paginated: exit 2.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makePostsNs() {
  return {
    posts: {
      get: vi.fn(),
      create: vi.fn(),
      react: vi.fn(),
      listReactions: vi.fn(),
    },
  };
}

function makeClient(ns: ReturnType<typeof makePostsNs>) {
  return {
    account: vi.fn().mockReturnValue(ns),
  };
}

type PostArgs = {
  postId?: string;
  text?: string;
  reaction?: string;
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

describe("post get", () => {
  let ns: ReturnType<typeof makePostsNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makePostsNs();
    client = makeClient(ns);
    (ns.posts.get as Mock).mockResolvedValue({ id: "post_1" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("post get <post_id> — calls posts.get with verbatim id", async () => {
    const { runPostGet } = await import("../../src/commands/post.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runPostGet(client as never, { postId: "7332661864792854528", account: "acc_1", json: true } as PostArgs, out);

    expect(ns.posts.get).toHaveBeenCalledWith("7332661864792854528");
  });

  it("post get --all — exits 2 (not paginated)", async () => {
    const { runPostGet } = await import("../../src/commands/post.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runPostGet(client as never, { postId: "post_1", account: "acc_1", all: true } as PostArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe("post create", () => {
  let ns: ReturnType<typeof makePostsNs>;
  let client: ReturnType<typeof makeClient>;
  let tmpDir: string;

  beforeEach(async () => {
    ns = makePostsNs();
    client = makeClient(ns);
    (ns.posts.create as Mock).mockResolvedValue({ post_id: "p_1" });
    tmpDir = await mkdtemp(join(tmpdir(), "curviate-test-post-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("post create '<text>' — calls posts.create with text (always multipart via SDK)", async () => {
    const { runPostCreate } = await import("../../src/commands/post.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runPostCreate(client as never, {
      text: "Hello world",
      account: "acc_1",
      json: true,
    } as PostArgs, out);

    expect(ns.posts.create).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Hello world" }),
    );
  });

  it("post create '<text>' --attach <file> — reads file, passes base64 payload in attachments (v2: no multipart)", async () => {
    const { runPostCreate } = await import("../../src/commands/post.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const filePath = join(tmpDir, "img.jpg");
    await writeFile(filePath, "jpgdata");

    await runPostCreate(client as never, {
      text: "Post with image",
      attach: filePath,
      account: "acc_1",
      json: true,
    } as PostArgs, out);

    const callArgs = (ns.posts.create as Mock).mock.calls[0]![0] as Record<string, unknown>;
    const attachments = callArgs["attachments"] as Array<Record<string, unknown>>;
    expect(Array.isArray(attachments)).toBe(true);
    expect(attachments[0]).toEqual({
      content: Buffer.from("jpgdata").toString("base64"),
      content_type: "image/jpeg",
      filename: "img.jpg",
    });
  });

  it("post create --attach <missing> — exits 2 before SDK call", async () => {
    const { runPostCreate } = await import("../../src/commands/post.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runPostCreate(client as never, {
        text: "Post",
        attach: join(tmpDir, "nope.jpg"),
        account: "acc_1",
      } as PostArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(ns.posts.create).not.toHaveBeenCalled();
  });

  it("post create --preview — renders preview, no posts.create call", async () => {
    const { runPostCreate } = await import("../../src/commands/post.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runPostCreate(client as never, {
      text: "Preview only",
      account: "acc_1",
      preview: true,
    } as PostArgs, out);

    expect(ns.posts.create).not.toHaveBeenCalled();
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.method).toBe("posts.create");
  });

  it("post create --preview with attachment — shows name+size, no bytes", async () => {
    const { runPostCreate } = await import("../../src/commands/post.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const filePath = join(tmpDir, "attach.jpg");
    await writeFile(filePath, "imgcontent");

    await runPostCreate(client as never, {
      text: "Attached post",
      attach: filePath,
      account: "acc_1",
      preview: true,
    } as PostArgs, out);

    expect(ns.posts.create).not.toHaveBeenCalled();
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.attachments[0]).toMatch(/attach\.jpg \(\d+ bytes\)/);
  });
});

describe("post react / reactions", () => {
  let ns: ReturnType<typeof makePostsNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makePostsNs();
    client = makeClient(ns);
    (ns.posts.react as Mock).mockResolvedValue({ reaction: "like" });
    (ns.posts.listReactions as Mock).mockResolvedValue({ items: [], cursor: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("post react <post_id> --reaction like — calls posts.react with body field 'reaction'", async () => {
    const { runPostReact } = await import("../../src/commands/post.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runPostReact(client as never, {
      postId: "post_abc",
      reaction: "like",
      account: "acc_1",
      json: true,
    } as PostArgs, out);

    expect(ns.posts.react).toHaveBeenCalledWith("post_abc", { reaction: "like" });
  });

  it("post react --preview — renders preview, no SDK call", async () => {
    const { runPostReact } = await import("../../src/commands/post.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runPostReact(client as never, {
      postId: "post_abc",
      reaction: "like",
      account: "acc_1",
      preview: true,
    } as PostArgs, out);

    expect(ns.posts.react).not.toHaveBeenCalled();
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.method).toBe("posts.react");
  });

  it("post reactions <post_id> — calls posts.listReactions", async () => {
    const { runPostReactions } = await import("../../src/commands/post.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runPostReactions(client as never, { postId: "post_abc", account: "acc_1", json: true } as PostArgs, out);

    expect(ns.posts.listReactions).toHaveBeenCalledWith("post_abc", expect.anything());
  });

  it("post reactions --all — streams NDJSON", async () => {
    const { runPostReactions } = await import("../../src/commands/post.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    (ns.posts.listReactions as Mock)
      .mockResolvedValueOnce({ items: [{ value: "LIKE" }, { value: "PRAISE" }], cursor: "next" })
      .mockResolvedValueOnce({ items: [{ value: "EMPATHY" }], cursor: null });

    await runPostReactions(client as never, { postId: "post_abc", account: "acc_1", all: true } as PostArgs, out);

    const lines = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string);
    const ndjson = lines.filter((l) => l.trim().startsWith("{"));
    expect(ndjson).toHaveLength(3);
  });
});
