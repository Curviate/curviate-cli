/**
 * Unit tests for `webhook verify --body` source resolution.
 *
 * `--body` accepts three forms and must not confuse them:
 *   - inline JSON  (the raw body pasted straight onto the command line)
 *   - a file path  (the raw body saved from the incoming request)
 *   - `-`          (the raw body piped on stdin)
 *
 * The discriminator is the leading `{`: a webhook delivery body is always a JSON
 * object, and no path names a file starting with `{`, so the two forms cannot
 * collide. `-` never reaches the resolver as a dash - the dispatcher substitutes
 * the stdin sentinel for a bare dash before citty parses argv - so the resolver
 * has to recognise both spellings, which is what regressed.
 *
 * The end-to-end proof that a real delivery verifies through each form lives in
 * webhook-verify-bin.test.ts, against the built bin.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { STDIN_SENTINEL } from "../../src/lib/stdin.js";

function makeOut() {
  return {
    stdout: { write: vi.fn() },
    stderr: { write: vi.fn() },
  };
}

function stderrText(out: ReturnType<typeof makeOut>): string {
  return out.stderr.write.mock.calls.map((c) => c[0] as string).join("");
}

/** Make process.exit observable: throw so the call site cannot continue. */
function trapExit() {
  return vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
    throw new Error(`process.exit(${code})`);
  });
}

const tmpDir = mkdtempSync(join(tmpdir(), "curviate-webhook-body-"));

const BODY = '{"id":"wdl_1","event":"message.received","data":{"account_id":"acc_1"}}';

afterEach(() => vi.restoreAllMocks());

describe("resolveWebhookBody", () => {
  it("inline JSON is returned verbatim, never opened as a file", async () => {
    const { resolveWebhookBody } = await import("../../src/commands/webhook.js");
    const out = makeOut();
    const readStdin = vi.fn();

    await expect(resolveWebhookBody(BODY, out, readStdin)).resolves.toBe(BODY);
    expect(readStdin).not.toHaveBeenCalled();
    expect(stderrText(out)).toBe("");
  });

  it("inline JSON with leading whitespace is still recognised, and kept byte-exact", async () => {
    const { resolveWebhookBody } = await import("../../src/commands/webhook.js");
    const out = makeOut();
    const padded = `  ${BODY}`;

    // Leading whitespace only informs the detection; the bytes handed to the
    // HMAC must be exactly what the caller passed.
    await expect(resolveWebhookBody(padded, out, vi.fn())).resolves.toBe(padded);
  });

  it("a file path is read from disk", async () => {
    const { resolveWebhookBody } = await import("../../src/commands/webhook.js");
    const out = makeOut();
    const file = join(tmpDir, "plain.json");
    writeFileSync(file, BODY, "utf8");

    await expect(resolveWebhookBody(file, out, vi.fn())).resolves.toBe(BODY);
  });

  it("a trailing newline added by a shell redirect or editor save is stripped", async () => {
    const { resolveWebhookBody } = await import("../../src/commands/webhook.js");
    const out = makeOut();
    const file = join(tmpDir, "trailing.json");
    writeFileSync(file, `${BODY}\n`, "utf8");

    await expect(resolveWebhookBody(file, out, vi.fn())).resolves.toBe(BODY);
  });

  it("a trailing CRLF is stripped too", async () => {
    const { resolveWebhookBody } = await import("../../src/commands/webhook.js");
    const out = makeOut();
    const file = join(tmpDir, "crlf.json");
    writeFileSync(file, `${BODY}\r\n`, "utf8");

    await expect(resolveWebhookBody(file, out, vi.fn())).resolves.toBe(BODY);
  });

  it("newlines INSIDE the body are preserved (a pretty-printed body is signed as-is)", async () => {
    const { resolveWebhookBody } = await import("../../src/commands/webhook.js");
    const out = makeOut();
    const multiline = '{\n  "id": "wdl_1"\n}';
    const file = join(tmpDir, "multiline.json");
    writeFileSync(file, `${multiline}\n`, "utf8");

    await expect(resolveWebhookBody(file, out, vi.fn())).resolves.toBe(multiline);
  });

  it("a bare dash reads stdin", async () => {
    const { resolveWebhookBody } = await import("../../src/commands/webhook.js");
    const out = makeOut();
    const readStdin = vi.fn().mockResolvedValue(BODY);

    await expect(resolveWebhookBody("-", out, readStdin)).resolves.toBe(BODY);
    expect(readStdin).toHaveBeenCalledTimes(1);
  });

  it("the stdin sentinel the dispatcher substitutes for a bare dash reads stdin too", async () => {
    const { resolveWebhookBody } = await import("../../src/commands/webhook.js");
    const out = makeOut();
    const readStdin = vi.fn().mockResolvedValue(BODY);

    // This is the spelling that actually reaches the handler from the real bin.
    await expect(resolveWebhookBody(STDIN_SENTINEL, out, readStdin)).resolves.toBe(BODY);
    expect(readStdin).toHaveBeenCalledTimes(1);
  });

  it("empty stdin is a usage error, not an empty body handed to the verifier", async () => {
    const { resolveWebhookBody } = await import("../../src/commands/webhook.js");
    const out = makeOut();
    const exit = trapExit();

    await expect(resolveWebhookBody("-", out, vi.fn().mockResolvedValue(""))).rejects.toThrow(
      "process.exit(2)",
    );
    expect(exit).toHaveBeenCalledWith(2);
    expect(stderrText(out)).toMatch(/stdin/i);
  });

  it("a missing file is a usage error naming all three accepted forms", async () => {
    const { resolveWebhookBody } = await import("../../src/commands/webhook.js");
    const out = makeOut();
    trapExit();

    await expect(
      resolveWebhookBody(join(tmpDir, "absent.json"), out, vi.fn()),
    ).rejects.toThrow("process.exit(2)");

    const msg = stderrText(out);
    expect(msg).toContain("--body");
    expect(msg).toMatch(/inline JSON/i);
    expect(msg).toMatch(/file/i);
    expect(msg).toMatch(/stdin/i);
    // The underlying reason stays visible so a typo'd path is diagnosable.
    expect(msg).toContain("absent.json");
  });

  it("an omitted --body is a usage error, not an empty-string body", async () => {
    const { resolveWebhookBody } = await import("../../src/commands/webhook.js");
    const out = makeOut();
    trapExit();

    await expect(resolveWebhookBody(undefined, out, vi.fn())).rejects.toThrow("process.exit(2)");
    expect(stderrText(out)).toContain("--body");
  });

  it("an empty --body value is a usage error", async () => {
    const { resolveWebhookBody } = await import("../../src/commands/webhook.js");
    const out = makeOut();
    trapExit();

    await expect(resolveWebhookBody("", out, vi.fn())).rejects.toThrow("process.exit(2)");
    expect(stderrText(out)).toContain("--body");
  });

  it("the resolver never writes the body to stdout (the verifier owns output)", async () => {
    const { resolveWebhookBody } = await import("../../src/commands/webhook.js");
    const out = makeOut();

    await resolveWebhookBody(BODY, out, vi.fn());
    expect(out.stdout.write).not.toHaveBeenCalled();
  });
});
