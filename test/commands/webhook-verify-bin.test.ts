/**
 * Black-box tests - spawn the BUILT bin (dist/cli.js) and verify that EVERY
 * documented form of `webhook verify --body` actually verifies a real delivery.
 *
 * Why the built bin and not the run-function: the defect these tests pin lived
 * entirely in the citty `run()` argv layer. `runWebhookVerify` takes an already
 * resolved `rawBody` string, so a unit test that calls it directly passes while
 * every real invocation fails. `--body` was read with `readFileSync` on the flag
 * value, so inline JSON was opened as a filename (ENOENT / ENAMETOOLONG), and
 * `--body -` was opened as the literal stdin sentinel the dispatcher substitutes
 * for a bare dash. All three documented forms failed; only the file-path form
 * ever worked.
 *
 * The payload is a real capture, not a hand-written fixture: the exact POST body
 * bytes and the exact signature header the platform's dispatch worker produced
 * on the wire. The signature is replayed verbatim and never re-signed - re-signing
 * would throw away the one property that makes the test real - so the tests widen
 * the replay window with `--max-age-secs` instead, exactly as a customer would to
 * verify a delivery captured earlier.
 *
 * Build prereq: dist/cli.js must exist. The beforeAll builds it if absent.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Test lives in test/commands/ - two levels above the package root.
const pkgRoot = resolve(__dirname, "../..");
const cliPath = resolve(pkgRoot, "dist", "cli.js");

const capture = JSON.parse(
  readFileSync(resolve(pkgRoot, "test", "fixtures", "webhook-delivery.capture.json"), "utf8"),
) as {
  secret: string;
  signatureHeader: string;
  rawBody: string;
  eventName: string;
};

/**
 * The capture is fixed in time, so its timestamp ages past the 300 s default
 * replay window. Widen the window rather than re-signing - the replayed header
 * must stay byte-identical to what the platform emitted.
 */
const WIDE_WINDOW = "999999999";

const BASE_ENV = {
  ...process.env,
  NODE_ENV: "production",
  // Present on purpose: `webhook verify` is offline and must never read it.
  CURVIATE_API_KEY: "cvt_live_bin_test_stub",
};

function run(args: string[], opts: { input?: string } = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    env: BASE_ENV,
    // Always close stdin. Left open, any stdin-reading path blocks to the timeout.
    input: opts.input ?? "",
  });
}

let tmpDir: string;
let bodyFile: string;
let bodyFileTrailingNewline: string;

beforeAll(() => {
  if (!existsSync(cliPath)) {
    execSync("node_modules/.bin/tsup", { cwd: pkgRoot, stdio: "ignore" });
  }
  tmpDir = mkdtempSync(join(tmpdir(), "curviate-webhook-verify-"));
  bodyFile = join(tmpDir, "body.json");
  // Exact bytes, no trailing newline - what the raw request body actually is.
  writeFileSync(bodyFile, capture.rawBody, "utf8");
  bodyFileTrailingNewline = join(tmpDir, "body-newline.json");
  // What a shell redirect, `curl -o`, or an editor save actually produces.
  writeFileSync(bodyFileTrailingNewline, capture.rawBody + "\n", "utf8");
});

/** Assert the command verified the capture and printed the parsed event. */
function expectVerified(r: ReturnType<typeof run>, label: string) {
  expect(r.status, `${label}: exit 0 (stderr: ${r.stderr.slice(0, 300)})`).toBe(0);
  const parsed = JSON.parse(r.stdout.trim()) as Record<string, unknown>;
  expect(parsed["event"], `${label}: parsed event name`).toBe(capture.eventName);
  expect(parsed["id"], `${label}: delivery id survives the round trip`).toBe(
    (JSON.parse(capture.rawBody) as { id: string }).id,
  );
  expect(r.stderr, `${label}: nothing on stderr`).toBe("");
  // The signing secret is a credential: it is never echoed back on any stream.
  expect(r.stdout + r.stderr, `${label}: secret never echoed`).not.toContain(capture.secret);
}

// ---------------------------------------------------------------------------
// The three documented --body forms, each against the real captured delivery
// ---------------------------------------------------------------------------

describe("webhook verify --body: every documented form verifies a real delivery", () => {
  it("inline JSON: the raw body passed directly on the command line", () => {
    const r = run([
      "webhook", "verify",
      "--secret", capture.secret,
      "--header", capture.signatureHeader,
      "--body", capture.rawBody,
      "--max-age-secs", WIDE_WINDOW,
    ]);
    expectVerified(r, "inline JSON");
  });

  it("file path: the raw body saved to a file", () => {
    const r = run([
      "webhook", "verify",
      "--secret", capture.secret,
      "--header", capture.signatureHeader,
      "--body", bodyFile,
      "--max-age-secs", WIDE_WINDOW,
    ]);
    expectVerified(r, "file path");
  });

  it("--body -: the raw body piped on stdin", () => {
    const r = run(
      [
        "webhook", "verify",
        "--secret", capture.secret,
        "--header", capture.signatureHeader,
        "--body", "-",
        "--max-age-secs", WIDE_WINDOW,
      ],
      { input: capture.rawBody },
    );
    expectVerified(r, "stdin");
  });

  it("a saved file with the trailing newline a shell redirect adds still verifies", () => {
    const r = run([
      "webhook", "verify",
      "--secret", capture.secret,
      "--header", capture.signatureHeader,
      "--body", bodyFileTrailingNewline,
      "--max-age-secs", WIDE_WINDOW,
    ]);
    expectVerified(r, "file with trailing newline");
  });

  it("stdin with the trailing newline a pipe adds still verifies", () => {
    const r = run(
      [
        "webhook", "verify",
        "--secret", capture.secret,
        "--header", capture.signatureHeader,
        "--body", "-",
        "--max-age-secs", WIDE_WINDOW,
      ],
      { input: capture.rawBody + "\n" },
    );
    expectVerified(r, "stdin with trailing newline");
  });
});

// ---------------------------------------------------------------------------
// The verification verdict itself is still real - accepting more input forms
// must not weaken what a passing verdict means.
// ---------------------------------------------------------------------------

describe("webhook verify: the verdict is unchanged by how the body arrived", () => {
  it("a tampered inline body is rejected with invalid_signature, exit 2", () => {
    const tampered = capture.rawBody.replace("message.received", "message.deleted");
    expect(tampered).not.toBe(capture.rawBody);

    const r = run([
      "webhook", "verify",
      "--secret", capture.secret,
      "--header", capture.signatureHeader,
      "--body", tampered,
      "--max-age-secs", WIDE_WINDOW,
    ]);
    expect(r.status).toBe(2);
    const parsed = JSON.parse(r.stdout.trim()) as { error: { reason: string; name: string } };
    expect(parsed.error.name).toBe("WebhookSignatureError");
    expect(parsed.error.reason).toBe("invalid_signature");
  });

  it("a tampered piped body is rejected with invalid_signature, exit 2", () => {
    const tampered = capture.rawBody.replace("acc_capture", "acc_attacker");
    expect(tampered).not.toBe(capture.rawBody);

    const r = run(
      [
        "webhook", "verify",
        "--secret", capture.secret,
        "--header", capture.signatureHeader,
        "--body", "-",
        "--max-age-secs", WIDE_WINDOW,
      ],
      { input: tampered },
    );
    expect(r.status).toBe(2);
    const parsed = JSON.parse(r.stdout.trim()) as { error: { reason: string } };
    expect(parsed.error.reason).toBe("invalid_signature");
  });

  it("the default replay window still rejects this aged capture as replay_detected", () => {
    const r = run([
      "webhook", "verify",
      "--secret", capture.secret,
      "--header", capture.signatureHeader,
      "--body", bodyFile,
    ]);
    expect(r.status).toBe(2);
    const parsed = JSON.parse(r.stdout.trim()) as { error: { reason: string } };
    expect(parsed.error.reason).toBe("replay_detected");
  });
});

// ---------------------------------------------------------------------------
// Bad input is a usage error (exit 2), not an internal failure (exit 1)
// ---------------------------------------------------------------------------

describe("webhook verify --body: unusable input fails as a usage error", () => {
  it("a path that does not exist names all three accepted forms and exits 2", () => {
    const r = run([
      "webhook", "verify",
      "--secret", capture.secret,
      "--header", capture.signatureHeader,
      "--body", join(tmpDir, "no-such-file.json"),
    ]);
    expect(r.status, `stderr: ${r.stderr.slice(0, 300)}`).toBe(2);
    expect(r.stderr).toContain("--body");
    // Actionable: the message must tell the reader what IS accepted.
    expect(r.stderr).toMatch(/inline JSON/i);
    expect(r.stderr).toMatch(/file/i);
    expect(r.stderr).toMatch(/stdin/i);
    expect(r.stdout.trim()).toBe("");
  });

  it("--body omitted exits 2 rather than reporting a bogus signature failure", () => {
    const r = run([
      "webhook", "verify",
      "--secret", capture.secret,
      "--header", capture.signatureHeader,
    ]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--body");
    // Must NOT masquerade as a signature verdict: that is what sends a customer
    // off rotating a secret that was never wrong.
    expect(r.stdout).not.toContain("WebhookSignatureError");
  });

  it("--body - with empty stdin exits 2 rather than verifying an empty body", () => {
    const r = run(
      [
        "webhook", "verify",
        "--secret", capture.secret,
        "--header", capture.signatureHeader,
        "--body", "-",
      ],
      { input: "" },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/stdin/i);
    expect(r.stdout).not.toContain("WebhookSignatureError");
  });
});

// ---------------------------------------------------------------------------
// Help text a reader copies from must match what the platform actually sends.
//
// Asserted against the command definition rather than a spawned `--help`:
// citty renders help through consola, which writes nothing when the process is
// spawned from a vitest worker (`--version`, written with process.stdout.write,
// comes through from the same spawn; the consola-rendered help does not, even
// redirected to a file). These description strings ARE what citty renders, so
// this is the same fact read one layer up. The rendered help of the built binary
// is asserted in scripts/verify-dist.mjs, which runs outside vitest.
// ---------------------------------------------------------------------------

describe("webhook verify help text", () => {
  it("names the signature header the platform actually sends", async () => {
    const { webhookCommand } = await import("../../src/commands/webhook.js");
    const verify = (webhookCommand.subCommands as Record<string, { args: Record<string, { description?: string }> }>)["verify"]!;
    const header = verify.args["header"]!.description ?? "";

    expect(header).toContain("Curviate-Signature");
    // The platform sends `Curviate-Signature`. A reader who copies an
    // `X-`-prefixed name reads for a header that is never present.
    expect(header).not.toMatch(/X-Curviate-Signature/i);
    // It also never read the header from stdin, which the help used to claim.
    expect(header).not.toMatch(/stdin/i);
  });

  it("documents all three accepted --body forms", async () => {
    const { webhookCommand } = await import("../../src/commands/webhook.js");
    const verify = (webhookCommand.subCommands as Record<string, { args: Record<string, { description?: string }> }>)["verify"]!;
    const body = verify.args["body"]!.description ?? "";

    expect(body).toMatch(/inline JSON/i);
    expect(body).toMatch(/file/i);
    expect(body).toMatch(/stdin/i);
  });
});
