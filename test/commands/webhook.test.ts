/**
 * `webhook` command group (root-scoped): create / list / events / get / update / delete with a mock client, and
 * `webhook verify` (offline, no client) both at the run-function seam and through the CLI entry point against a real
 * captured delivery (the defect lived in the argv layer: inline JSON was opened as a filename, `--body -` as the sentinel).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWebhookCreate, runWebhookDelete, runWebhookEvents, runWebhookGet, runWebhookList, runWebhookUpdate, runWebhookVerify, resolveWebhookBody } from "../../src/commands/webhook.js";
import { STDIN_SENTINEL } from "../../src/lib/stdin.js";
import { exitCode } from "../helpers/exit-code.js";
import { runCli } from "../helpers/run-inproc.js";

const client = { webhooks: { create: vi.fn(), list: vi.fn(), listEvents: vi.fn(), get: vi.fn(), update: vi.fn(), delete: vi.fn() } };
let out: { stdout: { write: Mock }; stderr: { write: Mock } };
beforeEach(() => {
  vi.resetAllMocks();
  out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
});
afterEach(() => vi.restoreAllMocks());
const text = (w: { write: Mock }) => w.write.mock.calls.map((c) => c[0] as string).join("");
const json = () => JSON.parse(text(out.stdout)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
const run = (fn: (...a: never[]) => Promise<unknown>, flags: object) => fn(client as never, flags as never, out as never);
const CREATE = { source: "messaging", "request-url": "https://example.com/hook", "account-ids": "acc_1,acc_2", json: true };

describe("webhook CRUD", () => {
  it("create builds source, request_url and the account_ids array, and never forwards the removed --format", async () => {
    client.webhooks.create.mockResolvedValue({ object: "webhook", id: "wh_1" });
    await run(runWebhookCreate, { ...CREATE, format: "form" });
    expect(client.webhooks.create).toHaveBeenCalledWith(expect.objectContaining({ source: "messaging", request_url: "https://example.com/hook", account_ids: ["acc_1", "acc_2"] }));
    expect(client.webhooks.create.mock.calls[0]![0]).not.toHaveProperty("format");
  });

  it.each([["--source", { source: undefined }], ["--request-url", { "request-url": undefined }], ["--account-ids", { "account-ids": undefined }]])("create without %s exits 2 with no call", async (_f, drop) => {
    expect(await exitCode(() => run(runWebhookCreate, { ...CREATE, ...drop }))).toBe(2);
    expect(client.webhooks.create).not.toHaveBeenCalled();
  });

  it("update sends id + body fields and never --format; --source is immutable (exit 2)", async () => {
    client.webhooks.update.mockResolvedValue({ object: "webhook", id: "wh_1" });
    await run(runWebhookUpdate, { id: "wh_1", name: "new-name", format: "form", json: true });
    expect(client.webhooks.update).toHaveBeenCalledWith("wh_1", expect.objectContaining({ name: "new-name" }));
    expect(client.webhooks.update.mock.calls[0]![1]).not.toHaveProperty("format");
    client.webhooks.update.mockClear();
    expect(await exitCode(() => run(runWebhookUpdate, { id: "wh_1", source: "user", name: "x" }))).toBe(2);
    expect(client.webhooks.update).not.toHaveBeenCalled();
  });

  it("get and delete pass the id verbatim; list calls list; events calls listEvents and rejects --all (exit 2)", async () => {
    client.webhooks.get.mockResolvedValue({ id: "wh_1" });
    client.webhooks.delete.mockResolvedValue({ id: "wh_1" });
    client.webhooks.list.mockResolvedValue({ items: [], cursor: null });
    client.webhooks.listEvents.mockResolvedValue({ items: [] });
    await run(runWebhookGet, { id: "wh_1", json: true });
    await run(runWebhookDelete, { id: "wh_1", json: true });
    await run(runWebhookList, { json: true });
    await run(runWebhookEvents, { json: true });
    expect(client.webhooks.get).toHaveBeenCalledWith("wh_1");
    expect(client.webhooks.delete).toHaveBeenCalledWith("wh_1");
    expect(client.webhooks.list).toHaveBeenCalled();
    expect(client.webhooks.listEvents).toHaveBeenCalled();
    expect(await exitCode(() => run(runWebhookEvents, { all: true }))).toBe(2);
  });

  it("list --all streams NDJSON over two pages", async () => {
    client.webhooks.list.mockResolvedValueOnce({ items: [{ id: "wh_1" }, { id: "wh_2" }], cursor: "c1" }).mockResolvedValueOnce({ items: [{ id: "wh_3" }], cursor: null });
    await run(runWebhookList, { all: true });
    expect(text(out.stdout).split("\n").filter((l) => l.trim().startsWith("{"))).toHaveLength(3);
  });

  it.each([
    ["create", runWebhookCreate, client.webhooks.create, "webhooks.create", { ...CREATE, json: false }],
    ["update", runWebhookUpdate, client.webhooks.update, "webhooks.update", { id: "wh_1", name: "renamed" }],
    ["delete", runWebhookDelete, client.webhooks.delete, "webhooks.delete", { id: "wh_1" }],
  ])("%s --preview renders the request without calling the SDK", async (_n, fn, sdk, method, flags) => {
    await run(fn as never, { ...flags, preview: true });
    expect(sdk).not.toHaveBeenCalled();
    expect(json().method).toBe(method);
  });
});

describe("webhook verify (run-function seam)", () => {
  const SECRET = "whsec_testkey123";
  const BODY = JSON.stringify({ type: "message.received", data: { account_id: "acc_1" } });
  const sign = (body: string, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex")}`;
  const verify = (o: object = {}) => runWebhookVerify({ secret: SECRET, signatureHeader: sign(BODY), rawBody: BODY, ...o }, out);

  it("a valid signature prints the event, exits 0, and never echoes the secret", async () => {
    expect(await exitCode(verify)).toBeUndefined();
    expect(json().type).toBe("message.received");
    expect(text(out.stdout) + text(out.stderr)).not.toContain(SECRET);
  });

  it.each([
    ["a stale timestamp", { signatureHeader: sign(BODY, Math.floor(Date.now() / 1000) - 600) }, "replay_detected"],
    ["a bad HMAC", { signatureHeader: `t=${Math.floor(Date.now() / 1000)},v1=${"deadbeef".repeat(8)}` }, "invalid_signature"],
    ["a header with no v1", { signatureHeader: "t=12345" }, "malformed_header"],
    ["a 10 s-old timestamp under --max-age-secs 5", { signatureHeader: sign(BODY, Math.floor(Date.now() / 1000) - 10), replayWindowSecs: 5 }, "replay_detected"],
  ])("%s: error envelope with reason=%s... exit 2", async (_l, over, reason) => {
    expect(await exitCode(() => verify(over))).toBe(2);
    expect(json().error).toMatchObject({ name: "WebhookSignatureError", reason });
  });
});

describe("webhook verify --body: every documented form verifies a real captured delivery (through the CLI entry point)", () => {
  const capture = JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "webhook-delivery.capture.json"), "utf8")) as { secret: string; signatureHeader: string; rawBody: string; eventName: string };
  const WIDE = "999999999"; // the capture's timestamp is fixed in time: widen the window, never re-sign
  const dir = mkdtempSync(join(tmpdir(), "curviate-webhook-verify-"));
  const file = join(dir, "body.json");
  const fileNl = join(dir, "body-newline.json");
  writeFileSync(file, capture.rawBody);
  writeFileSync(fileNl, capture.rawBody + "\n");
  // CURVIATE_API_KEY present on purpose: verify is offline and must never read it
  const cli = (body: string, stdin = "", extra: string[] = ["--max-age-secs", WIDE]) =>
    runCli(["webhook", "verify", "--secret", capture.secret, "--header", capture.signatureHeader, ...(body === "" ? [] : ["--body", body]), ...extra], { stdin, env: { CURVIATE_API_KEY: "cvt_live_bin_test_stub" } });

  it.each([
    ["inline JSON", () => cli(capture.rawBody)],
    ["a file path", () => cli(file)],
    ["a file with the trailing newline a shell redirect adds", () => cli(fileNl)],
    ["stdin (--body -)", () => cli("-", capture.rawBody)],
    ["stdin with the trailing newline a pipe adds", () => cli("-", capture.rawBody + "\n")],
  ])("%s", async (_l, go) => {
    const r = await go();
    expect(r.status, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout.trim()) as Record<string, unknown>;
    expect(parsed["event"]).toBe(capture.eventName);
    expect(parsed["id"]).toBe((JSON.parse(capture.rawBody) as { id: string }).id);
    expect(r.stderr).toBe("");
    expect(r.stdout + r.stderr).not.toContain(capture.secret);
  });

  it("the verdict is unchanged by how the body arrived: a tampered inline or piped body is invalid_signature, the aged capture is replay_detected under the default window; all exit 2", async () => {
    const reason = (r: { status: number; stdout: string }) => (r.status === 2 ? (JSON.parse(r.stdout.trim()) as { error: { reason: string } }).error.reason : `exit ${r.status}`);
    expect(reason(await cli(capture.rawBody.replace("message.received", "message.deleted")))).toBe("invalid_signature");
    expect(reason(await cli("-", capture.rawBody.replace("acc_capture", "acc_attacker")))).toBe("invalid_signature");
    expect(reason(await cli(file, "", []))).toBe("replay_detected");
  });

  it("unusable input is a usage error (exit 2) that never masquerades as a signature verdict: a missing file names all three forms, an omitted --body, empty stdin", async () => {
    const missing = await cli(join(dir, "no-such-file.json"), "", []);
    expect(missing.status).toBe(2);
    for (const re of [/--body/, /inline JSON/i, /file/i, /stdin/i]) expect(missing.stderr).toMatch(re);
    expect(missing.stdout.trim()).toBe("");
    const omitted = await cli("", "", []);
    const empty = await cli("-", "", []);
    expect([omitted.status, empty.status]).toEqual([2, 2]);
    expect(omitted.stderr).toContain("--body");
    expect(empty.stderr).toMatch(/stdin/i);
    expect(omitted.stdout + empty.stdout).not.toContain("WebhookSignatureError");
  });
});

describe("resolveWebhookBody (byte-exactness the HMAC depends on)", () => {
  const BODY = '{"id":"wdl_1","event":"message.received","data":{"account_id":"acc_1"}}';
  const dir = mkdtempSync(join(tmpdir(), "curviate-webhook-body-"));
  const fileWith = (name: string, content: string) => (writeFileSync(join(dir, name), content), join(dir, name));
  const resolve = (v: string | undefined, stdin = vi.fn()) => resolveWebhookBody(v, out, stdin);

  it("inline JSON (even with leading whitespace) is returned verbatim and never opened as a file; a file loses only its trailing LF/CRLF, keeping newlines inside", async () => {
    const stdin = vi.fn();
    expect(await resolve(BODY, stdin)).toBe(BODY);
    expect(await resolve(`  ${BODY}`, stdin)).toBe(`  ${BODY}`);
    expect(stdin).not.toHaveBeenCalled();
    expect(await resolve(fileWith("a.json", BODY))).toBe(BODY);
    expect(await resolve(fileWith("b.json", `${BODY}\r\n`))).toBe(BODY);
    expect(await resolve(fileWith("c.json", '{\n  "id": "wdl_1"\n}\n'))).toBe('{\n  "id": "wdl_1"\n}');
    expect(text(out.stdout) + text(out.stderr)).toBe("");
  });

  it("a bare dash and the dispatcher's stdin sentinel both read stdin", async () => {
    for (const spelling of ["-", STDIN_SENTINEL]) {
      const stdin = vi.fn().mockResolvedValue(BODY);
      expect(await resolve(spelling, stdin)).toBe(BODY);
      expect(stdin).toHaveBeenCalledTimes(1);
    }
  });

  it.each([["empty stdin", "-"], ["an omitted --body", undefined], ["an empty --body", ""], ["a missing file", "/nonexistent/absent.json"]])("%s is a usage error (exit 2) naming --body", async (_l, v) => {
    expect(await exitCode(() => resolve(v, vi.fn().mockResolvedValue("")))).toBe(2);
    expect(text(out.stderr)).toMatch(v === "-" ? /stdin/i : /--body/);
  });
});
