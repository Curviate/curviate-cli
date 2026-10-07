/**
 * `draft` command group (root-scoped): run functions against a mock client.
 * The built-bin flow (argv parsing, real HTTP) is in draft-bin.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runDraftList,
  runDraftGet,
  runDraftCreate,
  runDraftUpdate,
  runDraftDelete,
  runDraftPublish,
  planAttachments,
  INLINE_FILE_BYTES,
  INLINE_BODY_BYTES,
} from "../../src/commands/draft.js";

function makeClient() {
  return {
    drafts: {
      list: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ object: "draft_list", items: [], cursor: null })),
      get: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ object: "draft", id: "drf_1", attachments: [{ id: "att_1" }, { id: "att_2" }] })),
      create: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ object: "draft", id: "drf_1" })),
      update: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ object: "draft", id: "drf_1" })),
      delete: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => undefined),
      publish: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ object: "post_created", id: "urn:li:ugcPost:1" })),
      uploadAttachment: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ object: "draft", id: "drf_1" })),
    },
  };
}
const asClient = (c: ReturnType<typeof makeClient>) => c as never;

function makeOut() {
  return { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
}

/** Run, returning the exit code process.exit was called with (or undefined). */
async function runCatchingExit(fn: () => Promise<void>): Promise<number | undefined> {
  let code: number | undefined;
  const spy = vi.spyOn(process, "exit").mockImplementation(((c?: number) => {
    code = c;
    throw new Error("__exit__");
  }) as never);
  try {
    await fn();
  } catch (e) {
    if ((e as Error).message !== "__exit__") throw e;
  } finally {
    spy.mockRestore();
  }
  return code;
}

function tmpFile(name: string, bytes: number): string {
  const dir = mkdtempSync(join(tmpdir(), "draft-test-"));
  const p = join(dir, name);
  writeFileSync(p, Buffer.alloc(bytes, 1));
  return p;
}

const files = (sizes: number[]) =>
  sizes.map((n, i) => ({ path: `f${i}.png`, buf: Buffer.alloc(n) }));

describe("planAttachments: inline vs upload by INLINE_FILE_BYTES", () => {
  it("a file exactly at the cap is inline; one byte over uploads", () => {
    expect(planAttachments(files([INLINE_FILE_BYTES])).inline).toHaveLength(1);
    const over = planAttachments(files([INLINE_FILE_BYTES + 1]));
    expect(over.inline).toHaveLength(0);
    expect(over.upload).toHaveLength(1);
  });

  it("keeps the caller's order: after the first upload, every later file uploads too", () => {
    const plan = planAttachments(files([10, INLINE_FILE_BYTES + 1, 10]));
    expect(plan.inline.map((f) => f.path)).toEqual(["f0.png"]);
    expect(plan.upload.map((f) => f.path)).toEqual(["f1.png", "f2.png"]);
  });

  it("the 9 MiB body ceiling counts base64 growth: two 5 MiB files do not both ride inline", () => {
    const plan = planAttachments(files([INLINE_FILE_BYTES, INLINE_FILE_BYTES]));
    expect(plan.inline).toHaveLength(1);
    expect(plan.upload).toHaveLength(1);
    expect(Math.ceil((INLINE_FILE_BYTES * 2) / 3) * 4).toBeGreaterThan(INLINE_BODY_BYTES);
  });

  it("no files: nothing to do", () => {
    expect(planAttachments([])).toEqual({ inline: [], upload: [] });
  });
});

describe("draft create", () => {
  it("--schedule-at reaches the API byte for byte; account and text map to fields", async () => {
    const c = makeClient();
    const out = makeOut();
    const at = "2026-10-12T09:00:30.5+02:00"; // seconds, fraction, offset: no normalisation
    await runDraftCreate(asClient(c), { text: "hi", account: "acc_1", "schedule-at": at, json: true }, out);
    expect(c.drafts.create).toHaveBeenCalledWith({ account_id: "acc_1", text: "hi", scheduled_at: at });
  });

  it("no flags at all creates an empty Draft: {} (no account is defaulted)", async () => {
    const c = makeClient();
    await runDraftCreate(asClient(c), { json: true }, makeOut());
    expect(c.drafts.create).toHaveBeenCalledWith({});
  });

  it("a small file rides inline as base64; no upload call", async () => {
    const c = makeClient();
    await runDraftCreate(asClient(c), { attach: tmpFile("a.png", 100), json: true }, makeOut());
    const body = c.drafts.create.mock.calls[0]![0] as { attachments: Array<Record<string, string>> };
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0]).toMatchObject({ content_type: "image/png", filename: "a.png" });
    expect(Buffer.from(body.attachments[0]!["content"]!, "base64")).toHaveLength(100);
    expect(c.drafts.uploadAttachment).not.toHaveBeenCalled();
  });

  it("a file over INLINE_FILE_BYTES goes through the upload route, not the create body", async () => {
    const c = makeClient();
    const big = tmpFile("clip.mp4", INLINE_FILE_BYTES + 1);
    await runDraftCreate(asClient(c), { attach: big, account: "acc_1", json: true }, makeOut());
    expect(c.drafts.create.mock.calls[0]![0]).toEqual({ account_id: "acc_1" });
    expect(c.drafts.uploadAttachment).toHaveBeenCalledTimes(1);
    const [id, data, opts] = c.drafts.uploadAttachment.mock.calls[0]! as unknown as [string, Buffer, unknown];
    expect(id).toBe("drf_1");
    expect(data.byteLength).toBe(INLINE_FILE_BYTES + 1);
    expect(opts).toEqual({ filename: "clip.mp4", contentType: "video/mp4" });
  });

  it("--unschedule on create, and --schedule-at with --unschedule, exit 2 with nothing sent", async () => {
    const c = makeClient();
    expect(await runCatchingExit(() => runDraftCreate(asClient(c), { unschedule: true }, makeOut()))).toBe(2);
    expect(
      await runCatchingExit(() => runDraftUpdate(asClient(c), { id: "drf_1", unschedule: true, "schedule-at": "2026-10-12T09:00:00Z" }, makeOut())),
    ).toBe(2);
    expect(c.drafts.create).not.toHaveBeenCalled();
    expect(c.drafts.update).not.toHaveBeenCalled();
  });

  it("blank --account or --schedule-at is a value, not an omission: exit 2", async () => {
    const c = makeClient();
    expect(await runCatchingExit(() => runDraftCreate(asClient(c), { account: " " }, makeOut()))).toBe(2);
    expect(await runCatchingExit(() => runDraftCreate(asClient(c), { "schedule-at": "" }, makeOut()))).toBe(2);
    expect(c.drafts.create).not.toHaveBeenCalled();
  });

  it("an unreadable --attach exits 2 before any request", async () => {
    const c = makeClient();
    expect(await runCatchingExit(() => runDraftCreate(asClient(c), { attach: "/nonexistent/x.png" }, makeOut()))).toBe(2);
    expect(c.drafts.create).not.toHaveBeenCalled();
  });

  it("--preview sends nothing and never prints file bytes", async () => {
    const c = makeClient();
    const out = makeOut();
    await runDraftCreate(asClient(c), { text: "t", attach: tmpFile("a.png", 10), preview: true }, out);
    expect(c.drafts.create).not.toHaveBeenCalled();
    const printed = JSON.parse(out.stdout.write.mock.calls[0]![0] as string);
    expect(printed.method).toBe("drafts.create");
    expect(printed.attachments).toEqual(["a.png (10 bytes)"]);
    expect(printed.body.attachments).toBeUndefined();
  });

  it("an upload failure after create names the Draft that exists", async () => {
    const c = makeClient();
    const { CurviateError } = await import("@curviate/sdk");
    c.drafts.uploadAttachment.mockRejectedValueOnce(
      new CurviateError({ code: "MEDIA_QUOTA_EXCEEDED", message: "quota", userFixable: true, retryLikelyToSucceed: false }),
    );
    const out = makeOut();
    const code = await runCatchingExit(() =>
      runDraftCreate(asClient(c), { attach: tmpFile("v.mp4", INLINE_FILE_BYTES + 1), json: true }, out),
    );
    expect(code).toBe(2); // MEDIA_QUOTA_EXCEEDED -> invalid input family
    expect(out.stderr.write.mock.calls.map((x) => x[0]).join("")).toContain("drf_1");
  });
});

describe("an image over the 5 MiB cap is refused before any request", () => {
  it("5 MiB passes; 5 MiB + 1 exits 2 on create and on update with nothing sent", async () => {
    const MAX = 5 * 1024 * 1024;
    const c = makeClient();
    await runDraftCreate(asClient(c), { attach: tmpFile("ok.png", MAX), json: true }, makeOut());
    expect(c.drafts.create).toHaveBeenCalledTimes(1);

    const c2 = makeClient();
    const out = makeOut();
    const over = tmpFile("big.png", MAX + 1);
    expect(await runCatchingExit(() => runDraftCreate(asClient(c2), { attach: over, json: true }, out))).toBe(2);
    expect(await runCatchingExit(() => runDraftUpdate(asClient(c2), { id: "drf_1", attach: over, json: true }, out))).toBe(2);
    expect(out.stderr.write.mock.calls[0]![0]).toContain("5 MiB");
    expect(c2.drafts.create).not.toHaveBeenCalled();
    expect(c2.drafts.update).not.toHaveBeenCalled();
    expect(c2.drafts.uploadAttachment).not.toHaveBeenCalled();
  });

  it("a video or PDF over 5 MiB is not an image: it still goes through the upload route", async () => {
    const c = makeClient();
    await runDraftCreate(asClient(c), { attach: tmpFile("v.mp4", 5 * 1024 * 1024 + 1), json: true }, makeOut());
    expect(c.drafts.uploadAttachment).toHaveBeenCalledTimes(1);
  });
});

describe("draft update", () => {
  it("--unschedule sends scheduled_at:null (not omitted)", async () => {
    const c = makeClient();
    await runDraftUpdate(asClient(c), { id: "drf_1", unschedule: true, json: true }, makeOut());
    expect(c.drafts.update).toHaveBeenCalledWith("drf_1", { scheduled_at: null });
  });

  it("no change flags sends {} (the explicit retry of a failed Draft)", async () => {
    const c = makeClient();
    await runDraftUpdate(asClient(c), { id: "drf_1", json: true }, makeOut());
    expect(c.drafts.update).toHaveBeenCalledWith("drf_1", {});
  });

  it("an inline --attach keeps the existing attachments (the API replaces the list)", async () => {
    const c = makeClient();
    await runDraftUpdate(asClient(c), { id: "drf_1", attach: tmpFile("a.png", 5), json: true }, makeOut());
    const body = c.drafts.update.mock.calls[0]![1] as { attachments: Array<Record<string, unknown>> };
    expect(body.attachments.slice(0, 2)).toEqual([{ id: "att_1" }, { id: "att_2" }]);
    expect(body.attachments[2]).toMatchObject({ filename: "a.png" });
  });

  it("an over-cap --attach appends via upload and does not touch the list", async () => {
    const c = makeClient();
    await runDraftUpdate(asClient(c), { id: "drf_1", attach: tmpFile("a.pdf", INLINE_FILE_BYTES + 1), json: true }, makeOut());
    expect(c.drafts.get).not.toHaveBeenCalled();
    expect(c.drafts.update).toHaveBeenCalledWith("drf_1", {});
    expect(c.drafts.uploadAttachment).toHaveBeenCalledTimes(1);
  });
});

describe("draft list / get / delete / publish", () => {
  it("list: --status splits to an array; --account none and the date range pass through", async () => {
    const c = makeClient();
    await runDraftList(
      asClient(c),
      { status: "scheduled, published", account: "none", from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z", order: "asc", json: true },
      makeOut(),
    );
    expect(c.drafts.list).toHaveBeenCalledWith({
      status: ["scheduled", "published"],
      account_id: "none",
      from: "2026-10-01T00:00:00Z",
      to: "2026-11-01T00:00:00Z",
      order: "asc",
    });
  });

  it("list: an unknown --status exits 2 naming it; nothing sent", async () => {
    const c = makeClient();
    const out = makeOut();
    expect(await runCatchingExit(() => runDraftList(asClient(c), { status: "draft,sent" }, out))).toBe(2);
    expect(out.stderr.write.mock.calls[0]![0]).toContain("sent");
    expect(c.drafts.list).not.toHaveBeenCalled();
  });

  it("list --all streams every page", async () => {
    const c = makeClient();
    c.drafts.list
      .mockResolvedValueOnce({ object: "draft_list", items: [{ id: "a" }], cursor: "c1" } as never)
      .mockResolvedValueOnce({ object: "draft_list", items: [{ id: "b" }], cursor: null } as never);
    const out = makeOut();
    await runDraftList(asClient(c), { all: true, "page-delay": "0", json: true }, out);
    const lines = out.stdout.write.mock.calls.map((x) => x[0] as string).join("");
    expect(lines).toContain('"id":"a"');
    expect(lines).toContain('"id":"b"');
    expect(c.drafts.list).toHaveBeenCalledTimes(2);
  });

  it("get / delete / publish call their SDK method with the id; --preview sends nothing", async () => {
    const c = makeClient();
    await runDraftGet(asClient(c), { id: "drf_1", json: true }, makeOut());
    await runDraftDelete(asClient(c), { id: "drf_1", json: true }, makeOut());
    await runDraftPublish(asClient(c), { id: "drf_1", json: true }, makeOut());
    expect(c.drafts.get).toHaveBeenCalledWith("drf_1");
    expect(c.drafts.delete).toHaveBeenCalledWith("drf_1");
    expect(c.drafts.publish).toHaveBeenCalledWith("drf_1");

    const c2 = makeClient();
    const out = makeOut();
    await runDraftDelete(asClient(c2), { id: "drf_1", preview: true }, out);
    await runDraftPublish(asClient(c2), { id: "drf_1", preview: true }, out);
    expect(c2.drafts.delete).not.toHaveBeenCalled();
    expect(c2.drafts.publish).not.toHaveBeenCalled();
  });

  it("an API refusal maps to its exit code: DRAFT_PUBLISHING -> 7, SCHEDULE_CONFLICT -> 2", async () => {
    const { CurviateError } = await import("@curviate/sdk");
    for (const [code, exit] of [["DRAFT_PUBLISHING", 7], ["SCHEDULE_CONFLICT", 2]] as const) {
      const c = makeClient();
      c.drafts.publish.mockRejectedValueOnce(
        new CurviateError({ code, message: "m", userFixable: true, retryLikelyToSucceed: false }),
      );
      expect(await runCatchingExit(() => runDraftPublish(asClient(c), { id: "drf_1", json: true }, makeOut()))).toBe(exit);
    }
  });
});
