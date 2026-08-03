/**
 * Black-box smoke gate for the built dist.
 *
 * Runs AFTER `pnpm build`. Spawns `dist/cli.js` directly (not src/) and
 * asserts the binary behaves correctly. This is the build-output regression
 * gate, run before publish.
 *
 * Run:  node scripts/verify-dist.mjs
 * Exit 0 = all assertions passed.
 * Exit 1 = a case failed — prints the failure and aborts.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");
const cliPath = resolve(pkgRoot, "dist", "cli.js");
const pkgJson = JSON.parse(readFileSync(resolve(pkgRoot, "package.json"), "utf8"));
const expectedVersion = pkgJson.version;

// Vendor name and internal codenames assembled from fragments so the literals
// never appear in this file and don't trip the scanner on itself.
const vendorName = ["uni", "pi", "le"].join("");
const codenamePat = new RegExp(
  ["red" + "arc", "@curviate/" + "shared", "apps/" + "server"].join("|"),
  ""
);
const LEAK_PATTERNS = [
  new RegExp(vendorName, "i"),
  /\b(FR|AC|NFR|TS|ADR)-\d+/,
  /#\d{3,}/,
  codenamePat,
  /docs\/(specs|adr)\b/,
];

function assert(condition, label) {
  if (!condition) {
    console.error(`FAIL: ${label}`);
    process.exit(1);
  }
  console.log(`PASS: ${label}`);
}

// Run CLI with NODE_ENV=production so consola is not silenced by test-mode detection.
function run(args, opts) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, NODE_ENV: "production" },
    ...opts,
  });
}

function assertLeakFree(text, context) {
  for (const pattern of LEAK_PATTERNS) {
    if (pattern.test(text)) {
      console.error(`FAIL: leak detected in ${context} output — pattern ${pattern}`);
      console.error(`      matched in: ${text.slice(0, 200)}`);
      process.exit(1);
    }
  }
}

/**
 * Build a valid X-Curviate-Signature header.
 * HMAC-SHA256(secret, "${timestamp}.${body}") → "t=${t},v1=${hmac}"
 * Mirrors the SDK's constructEvent payload construction.
 */
function buildSignatureHeader(secret, bodyStr, nowSecs) {
  const t = nowSecs ?? Math.floor(Date.now() / 1000);
  const payload = `${t}.${bodyStr}`;
  const hmac = createHmac("sha256", secret).update(payload).digest("hex");
  return `t=${t},v1=${hmac}`;
}

/**
 * Write content to a temp file, run fn with the path, then delete it.
 */
function withTempFile(content, fn) {
  const tmpFile = join(tmpdir(), `curviate-verify-${Date.now()}.json`);
  writeFileSync(tmpFile, content, "utf8");
  try {
    return fn(tmpFile);
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

console.log("=== verify-dist: CLI binary smoke gate ===\n");

// ---------------------------------------------------------------------------
// 1. --version: prints expected version and exits 0
// ---------------------------------------------------------------------------
{
  const result = run(["--version"]);
  assert(result.status === 0, `--version exits 0 (got ${result.status})`);
  const printed = (result.stdout + result.stderr).trim();
  assert(
    printed.includes(expectedVersion),
    `--version output contains "${expectedVersion}" (got "${printed}")`
  );
  assertLeakFree(printed, "--version");
}

// ---------------------------------------------------------------------------
// 2. --help: exits 0, output is leak-clean
// ---------------------------------------------------------------------------
{
  const result = run(["--help"]);
  assert(result.status === 0, `--help exits 0 (got ${result.status})`);
  const helpText = result.stdout + result.stderr;
  assert(helpText.length > 0, "--help produces output");
  assertLeakFree(helpText, "--help");
}

// ---------------------------------------------------------------------------
// 3. no arguments: exits 0
// ---------------------------------------------------------------------------
{
  const result = run([]);
  assert(result.status === 0, `no-args exits 0 (got ${result.status})`);
}

// ---------------------------------------------------------------------------
// 4. --preview write: exits 0, no network call, output does not contain dry_run
//    Uses `webhook create --preview` — an offline preview render (root-scoped,
//    all required flags provided, no account or network needed).
// ---------------------------------------------------------------------------
{
  const result = run([
    "webhook", "create",
    "--source", "messaging",
    "--request-url", "https://example.com/hook",
    "--account-ids", "acc_1",
    "--preview",
    "--api-key", "rdc_live_verify_dist_stub",
  ]);
  assert(
    result.status === 0,
    `webhook create --preview exits 0 (got ${result.status}; stderr: ${result.stderr.slice(0, 200)})`
  );
  const out = result.stdout + result.stderr;
  assert(
    !(/dry[_-]run/i.test(out)),
    `--preview output must not contain "dry_run" token`
  );
  assert(
    out.includes("webhooks.create") || out.includes("preview"),
    `--preview output should describe the pending request (got: ${out.slice(0, 200)})`
  );
  assertLeakFree(out, "webhook create --preview");
}

// ---------------------------------------------------------------------------
// 5. webhook verify — every documented --body form verifies a REAL delivery.
//
// The payload is a capture, not a hand-written body: the exact POST bytes and
// the exact signature header the platform's dispatch worker put on the wire.
// The header is replayed verbatim and never re-signed, so the replay window is
// widened instead — the same thing a customer does to verify a delivery they
// captured earlier.
//
// All three forms are gated here because all three were broken at once while
// only the file form was ever exercised: inline JSON and `-` were both handed
// to readFileSync as filenames.
// ---------------------------------------------------------------------------
{
  const capture = JSON.parse(
    readFileSync(resolve(pkgRoot, "test", "fixtures", "webhook-delivery.capture.json"), "utf8")
  );
  const WIDE_WINDOW = "999999999";

  const assertVerified = (result, label) => {
    assert(
      result.status === 0,
      `webhook verify (${label}) exits 0 (got ${result.status}; stderr: ${result.stderr.slice(0, 200)})`
    );
    assert(
      result.stdout.includes(capture.eventName),
      `webhook verify (${label}) prints the parsed event (got: ${result.stdout.slice(0, 200)})`
    );
    assert(
      !(result.stdout + result.stderr).includes(capture.secret),
      `webhook verify (${label}) never echoes the signing secret`
    );
    assertLeakFree(result.stdout + result.stderr, `webhook verify (${label})`);
  };

  // Form 1: inline JSON on the command line.
  assertVerified(
    run([
      "webhook", "verify",
      "--secret", capture.secret,
      "--header", capture.signatureHeader,
      "--body", capture.rawBody,
      "--max-age-secs", WIDE_WINDOW,
    ]),
    "inline JSON"
  );

  // Form 2: a path to a file holding the raw body.
  withTempFile(capture.rawBody, (tmpFile) => {
    assertVerified(
      run([
        "webhook", "verify",
        "--secret", capture.secret,
        "--header", capture.signatureHeader,
        "--body", tmpFile,
        "--max-age-secs", WIDE_WINDOW,
      ]),
      "file path"
    );
  });

  // Form 3: the raw body piped on stdin.
  assertVerified(
    run(
      [
        "webhook", "verify",
        "--secret", capture.secret,
        "--header", capture.signatureHeader,
        "--body", "-",
        "--max-age-secs", WIDE_WINDOW,
      ],
      { input: capture.rawBody }
    ),
    "stdin"
  );

  // A tampered body must still be rejected: accepting more input forms must not
  // soften what a passing verdict means.
  {
    const tampered = capture.rawBody.replace("acc_capture", "acc_attacker");
    assert(tampered !== capture.rawBody, "tamper control actually modified the body");
    const result = run([
      "webhook", "verify",
      "--secret", capture.secret,
      "--header", capture.signatureHeader,
      "--body", tampered,
      "--max-age-secs", WIDE_WINDOW,
    ]);
    assert(
      result.status === 2 && result.stdout.includes("invalid_signature"),
      `webhook verify (tampered inline body) exits 2 with invalid_signature (got ${result.status}: ${result.stdout.slice(0, 200)})`
    );
  }

  // Unusable input is a usage error (2), never an internal failure (1) and never
  // a signature verdict — a bogus verdict is what sends someone off rotating a
  // secret that was never wrong.
  {
    const result = run([
      "webhook", "verify",
      "--secret", capture.secret,
      "--header", capture.signatureHeader,
      "--body", join(tmpdir(), "curviate-verify-dist-no-such-file.json"),
    ]);
    assert(
      result.status === 2,
      `webhook verify (unreadable --body path) exits 2 (got ${result.status})`
    );
    assert(
      !result.stdout.includes("WebhookSignatureError"),
      "webhook verify (unreadable --body path) does not report a signature verdict"
    );
  }
}

// ---------------------------------------------------------------------------
// 6. webhook verify — bad signature: exits 2
// ---------------------------------------------------------------------------
{
  const secret = "curviate_verify_dist_gate_secret";
  const eventBody = JSON.stringify({ type: "message.received", data: { account_id: "acc_1" }, id: "evt_1" });
  const t = Math.floor(Date.now() / 1000);
  // Deliberately wrong HMAC (all zeros)
  const badHeader = `t=${t},v1=${"0".repeat(64)}`;

  withTempFile(eventBody, (tmpFile) => {
    const result = run([
      "webhook", "verify",
      "--secret", secret,
      "--header", badHeader,
      "--body", tmpFile,
    ]);
    assert(
      result.status === 2,
      `webhook verify (bad signature) exits 2 (got ${result.status})`
    );
  });
}

// ---------------------------------------------------------------------------
// 7. webhook verify — stale timestamp (replay_detected): exits 2
// ---------------------------------------------------------------------------
{
  const secret = "curviate_verify_dist_gate_secret";
  const eventBody = JSON.stringify({ type: "message.received", data: { account_id: "acc_1" }, id: "evt_1" });
  // Timestamp 10 minutes in the past — well outside the 5-minute replay window
  const staleTs = Math.floor(Date.now() / 1000) - 600;
  const staleHeader = buildSignatureHeader(secret, eventBody, staleTs);

  withTempFile(eventBody, (tmpFile) => {
    const result = run([
      "webhook", "verify",
      "--secret", secret,
      "--header", staleHeader,
      "--body", tmpFile,
    ]);
    assert(
      result.status === 2,
      `webhook verify (stale/replay) exits 2 (got ${result.status})`
    );
  });
}

// ---------------------------------------------------------------------------
// 8. Usage error (missing required flag): exits non-zero
//    `webhook create` requires --source, --request-url, --account-ids.
//    Passing only --api-key should yield a usage error.
// ---------------------------------------------------------------------------
{
  const result = run([
    "webhook", "create",
    "--api-key", "rdc_live_verify_dist_stub",
  ]);
  assert(
    result.status === 2,
    `webhook create (missing required flags) exits 2 — usage error (got ${result.status})`
  );
}

// ---------------------------------------------------------------------------
// 9. Subcommand --help spot-checks: exit 0, leak-clean
// ---------------------------------------------------------------------------
{
  const spotChecks = [
    ["profile", "--help"],
    ["account", "list", "--help"],
    ["webhook", "verify", "--help"],
    ["sales-nav", "--help"],
    ["recruiter", "search", "--help"],
  ];

  for (const args of spotChecks) {
    const result = run(args);
    const helpText = result.stdout + result.stderr;
    assert(result.status === 0, `${args.join(" ")} exits 0 (got ${result.status})`);
    assert(helpText.length > 0, `${args.join(" ")} produces output`);
    assertLeakFree(helpText, args.join(" "));
  }
}

// ---------------------------------------------------------------------------
// 10. Rendered help says what the platform actually does.
//
// Asserted here rather than in vitest: citty renders help through consola,
// which writes nothing when the process is spawned from a vitest worker. This
// script runs outside vitest, so it reads the real rendered help of the built
// binary — the exact text a customer sees.
// ---------------------------------------------------------------------------
{
  const result = run(["webhook", "verify", "--help"]);
  const helpText = result.stdout + result.stderr;

  assert(
    helpText.includes("Curviate-Signature") && !/X-Curviate-Signature/i.test(helpText),
    "webhook verify --help names the signature header the platform sends, unprefixed"
  );
  assert(
    /inline JSON/i.test(helpText) && /stdin/i.test(helpText) && /file/i.test(helpText),
    "webhook verify --help documents all three accepted --body forms"
  );

  // No em dash in customer-facing copy.
  assert(
    !helpText.includes("—"),
    "webhook verify --help contains no em dash"
  );
}

// ---------------------------------------------------------------------------
// 11. No em dash anywhere the binary prints.
// ---------------------------------------------------------------------------
{
  const surfaces = [
    ["--help"],
    ["webhook", "--help"],
    ["message", "--help"],
    ["account", "--help"],
    ["connect", "--help"],
  ];
  for (const args of surfaces) {
    const result = run(args);
    assert(
      !(result.stdout + result.stderr).includes("—"),
      `${args.join(" ")} output contains no em dash`
    );
  }
}

console.log("\nAll dist checks passed.");
