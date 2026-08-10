/**
 * Executes every ```bash example in README.md against the BUILT binary, a
 * local HTTP stub standing in for the API, and a freshly-signed webhook
 * fixture for the one offline example, asserting each produces non-empty,
 * non-error output.
 *
 * Why execution and not a read-through: three rounds of hand-correction had
 * already produced three generations of a README with wrong field names,
 * wrong envelope shapes, and a flag ordering the shipped dispatcher actually
 * rejects. A reviewer reading the text sees plausible JSON; only running the
 * real pipeline (real `curviate`, real `jq`, real `xargs`) surfaces that
 * `.unread` doesn't exist or that `--all` streams NDJSON, not an array.
 *
 * Approach:
 *   - `dist/cli.js` is built fresh (via the shared ensureFreshBuild helper)
 *     and exposed on PATH as `curviate` through a tiny shim script, so every
 *     README command, pipe, and xargs invocation resolves to the real build
 *     the same way a user's shell would.
 *   - The shim appends `--base-url <stub>` to every invocation, so nothing
 *     here ever reaches the real API (`--base-url`'s built-in default is
 *     production - see CLAUDE.md).
 *   - The stub server returns one canonical "superset" fixture object,
 *     carrying every field name ANY README jq pipeline projects (id,
 *     account_id, full_name, job_urn, last_message, user, ...), wrapped in
 *     BOTH a flat single-object shape and an {items:[...],cursor:null}
 *     envelope - a caller reading either shape finds real, non-null data.
 *     One request pattern (the Sales Navigator tier-check example) is
 *     special-cased to a 403 TIER_NOT_ACTIVE envelope instead, because that
 *     example exists specifically to demonstrate exit-code-5 branching.
 *   - `webhook verify` (the one fully-offline example) gets a real payload
 *     signed at test-setup time with a fresh timestamp, so the documented
 *     command runs completely unmodified, no --max-age-secs override needed.
 *   - Every block runs under `set -eo pipefail`, so a failure ANYWHERE in a
 *     multi-line/piped example (not just its last command) fails the test.
 *
 * Non-goal: asserting exact projected VALUES. The stub's fixture data is
 * synthetic, so a jq expression like `.[0].id` proves the FIELD PATH
 * resolves (the actual defect class here), not that the id is any
 * particular string. Field-path correctness is exactly what three rounds of
 * hand-correction kept getting wrong.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureFreshBuild, pkgRoot } from "./helpers/built-cli.js";

// ---------------------------------------------------------------------------
// Fixture data: one canonical object carrying every field any README example
// projects, in both flat and list-envelope shapes.
// ---------------------------------------------------------------------------

const FIXTURE_ITEM = {
  object: "fixture_item",
  id: "id_readme_fixture_001",
  account_id: "acc_1",
  full_name: "Fixture Person",
  name: "Fixture Company",
  display_name: "Fixture Display Name",
  headline: "Fixture Headline Here",
  status: "active",
  auth_method: "credentials",
  // A bare numeric string, matching the real API: "job_urn" is documented as
  // "the same value as" the job's own numeric id (e.g. 4100000000), NOT a
  // urn:li:... string - `job get` rejects a urn-shaped value, which an
  // earlier, wrong version of this fixture (guessing at the shape) caught
  // itself on: it made example 7's real defect (job_urn -> job get piping
  // straight through) look broken when the README was actually correct.
  job_urn: "4428113858",
  title: "Fixture Job Title",
  state: "OPEN",
  unread_count: 1,
  last_message: {
    object: "message",
    id: "msg_readme_fixture",
    account_id: "acc_1",
    chat_id: "id_readme_fixture_001",
    sender_id: "mem_fixture_sender",
    text: "Fixture message text, long enough to slice the first eighty characters from safely.",
    timestamp: new Date().toISOString(),
  },
  user: {
    id: "mem_fixture_user",
    type: "individual",
    display_name: "Fixture Counterpart",
    profile_url: "https://www.linkedin.com/in/fixture",
    public_picture_url: null,
  },
};

const FIXTURE_BODY = {
  ...FIXTURE_ITEM,
  items: [FIXTURE_ITEM],
  cursor: null,
};

const TIER_NOT_ACTIVE_BODY = {
  code: "TIER_NOT_ACTIVE",
  message: "This account does not have the sales_nav add-on tier.",
  required_tier: "sales_nav",
  user_fixable: true,
  retry_likely_to_succeed: false,
};

// ---------------------------------------------------------------------------
// README block extraction
// ---------------------------------------------------------------------------

interface Example {
  /** Nearest preceding `### N. ...` (or `## ...`) heading, for special-casing. */
  heading: string;
  /** The fenced block's raw content. */
  code: string;
}

function extractBashExamples(readme: string): Example[] {
  const examples: Example[] = [];
  const headingRe = /^#{2,3}\s+.*/gm;
  const headings: Array<{ index: number; text: string }> = [...readme.matchAll(headingRe)].map((m) => ({
    index: m.index!,
    text: m[0]!,
  }));

  for (const m of readme.matchAll(/```bash\n([\s\S]*?)```/g)) {
    const code = m[1]!;
    // Only examples that actually invoke the CLI - excludes the Install
    // section's `npm install` / `npx @curviate/cli --help` blocks, which
    // exercise the npm registry, not this build.
    if (!code.split("\n").some((line) => /^curviate\s/.test(line.trim()))) continue;
    // Bare `curviate login` (no --api-key) is interactive-only BY DESIGN: it
    // masks-and-reads a key from a real TTY, which is exactly the one
    // documented behavior this harness cannot fake without a pty layer. Every
    // other example is headless by design; this is the sole exception.
    if (code.trim() === "curviate login") continue;

    const blockIndex = m.index!;
    let heading = "";
    for (const h of headings) {
      if (h.index > blockIndex) break;
      heading = h.text;
    }
    examples.push({ heading, code });
  }
  return examples;
}

// ---------------------------------------------------------------------------
// Harness state
// ---------------------------------------------------------------------------

let cliPath: string;
let server: Server;
let baseUrl: string;
let tierCheckMode = false;
let workDir: string;
let shimDir: string;
let webhookSecret: string;
let webhookSigHeader: string;

beforeAll(async () => {
  cliPath = ensureFreshBuild();

  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      if (tierCheckMode) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify(TIER_NOT_ACTIVE_BODY));
        return;
      }
      // The one binary-response example (resume download): the SDK's
      // transport picks JSON vs. ArrayBuffer parsing from the response
      // Content-Type (see packages/sdk/src/transport.ts's parseSuccess), so
      // answering this path with application/json would silently hand the
      // CLI a parsed JS object where it expects bytes, and -o would write a
      // 0-byte file with no error anywhere in between.
      if (req.url?.includes("/resume")) {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(Buffer.from("%PDF-1.4 readme-example-fixture, not a real PDF\n"));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(FIXTURE_BODY));
    });
  });
  await new Promise<void>((resolvePromise) => server.listen(0, resolvePromise));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  // A dedicated CWD, so accounts.csv / resume.pdf (README examples that
  // write files instead of stdout) land somewhere disposable, and so
  // webhook-payload.json (example 5's stdin source) has a stable home.
  workDir = mkdtempSync(join(tmpdir(), "readme-examples-work-"));

  // The `curviate` PATH shim: every example, direct or piped through
  // xargs, resolves to the real build with --base-url pinned at the stub -
  // never production, matching the CLAUDE.md hand-check rule even though
  // this is automated.
  shimDir = mkdtempSync(join(tmpdir(), "readme-examples-bin-"));
  const shimPath = join(shimDir, "curviate");
  writeFileSync(
    shimPath,
    `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} "$@" --base-url ${JSON.stringify(baseUrl)}\n`,
    "utf8",
  );
  chmodSync(shimPath, 0o755);

  // Example 5 (webhook verify) is the one fully-offline example - sign a
  // real payload with the CURRENT timestamp so the documented command runs
  // completely unmodified (no --max-age-secs override, unlike the aged
  // fixture capture the unit tests replay).
  webhookSecret = "whsec_readme_example_fixture";
  const payload = {
    id: "wdl_readme_fixture",
    webhook_id: "wh_readme_fixture",
    event: "message.received",
    delivered_at: new Date().toISOString(),
    data: {
      account_id: "acc_1",
      event: "message.received",
      occurred_at: new Date().toISOString(),
      message_id: "msg_readme_fixture",
    },
  };
  const rawBody = JSON.stringify(payload);
  writeFileSync(join(workDir, "webhook-payload.json"), rawBody, "utf8");
  const timestamp = Math.floor(Date.now() / 1000);
  const hmac = createHmac("sha256", webhookSecret).update(`${timestamp}.${rawBody}`).digest("hex");
  webhookSigHeader = `t=${timestamp},v1=${hmac}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  rmSync(workDir, { recursive: true, force: true });
  rmSync(shimDir, { recursive: true, force: true });
});

/**
 * `<placeholder>` text (angle brackets, the README's convention for "put your
 * own value here") is a documentation convention, not literal shell syntax: a
 * reader is expected to REPLACE the whole token before running the command,
 * exactly like `$SOME_ID`. Pasted verbatim, bash parses `<` / `>` as
 * redirection and the block never even starts - `<your-api-key>` fails with
 * "syntax error near unexpected token `newline'" before the CLI is ever
 * invoked. Substituted the same way a `$VAR` reference is, via the env below.
 */
function substitutePlaceholders(code: string): string {
  return code.replace(/<your-api-key>/g, "$CURVIATE_API_KEY");
}

/**
 * Run one README fenced block as a real shell script, PATH-shimmed to the
 * built binary.
 *
 * MUST be the async `execFile`, never `execFileSync`/`spawnSync`. The stub
 * HTTP server lives in THIS SAME Node.js process (created in `beforeAll`), and
 * a *Sync child_process call blocks this process's entire event loop until
 * the child exits - which means the server can never run its own request
 * callback to answer the child, which is waiting on exactly that response.
 * Every example hung at its request's timeout (proven by instrumenting the
 * server: it never logged an incoming connection at all while a `*Sync` call
 * was in flight). The async form lets the event loop keep servicing the
 * in-process server while the child runs.
 */
function runExample(code: string): Promise<{ stdout: string; stderr: string }> {
  const env = {
    ...process.env,
    PATH: `${shimDir}:${process.env["PATH"] ?? ""}`,
    NODE_ENV: "production",
    CURVIATE_API_KEY: "rdc_live_readme_example_fixture",
    SOME_ID: "prof_readme_fixture",
    PROJECT_ID: "proj_readme_fixture",
    JOB_ID: "job_readme_fixture",
    CHANNEL_ID: "chan_readme_fixture",
    STAGE_ID: "stage_readme_fixture",
    CURVIATE_WEBHOOK_SECRET: webhookSecret,
    CURVIATE_SIG_HEADER: webhookSigHeader,
  };
  return new Promise((resolvePromise, reject) => {
    execFile(
      "bash",
      ["-c", `set -eo pipefail\n${substitutePlaceholders(code)}`],
      { cwd: workDir, env, encoding: "utf8", timeout: 30_000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`${err.message}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`));
          return;
        }
        resolvePromise({ stdout, stderr });
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Tests: one per extracted example, generated at collection time so a
// failure in any single example reports against ITS OWN heading rather than
// aborting every other example in the same run.
// ---------------------------------------------------------------------------

const readme = readFileSync(join(pkgRoot, "README.md"), "utf8");
const examples = extractBashExamples(readme);

describe("README examples execute against the built binary (non-empty, non-error)", () => {
  it("found a substantial number of runnable examples (the extractor itself works)", () => {
    // A regression here (e.g. the ```bash fence convention changing) would
    // make every test below vacuously pass over zero examples - the same
    // "scanned nothing, reported clean" shape the check:clean guard learned
    // to refuse. Refuse here too.
    expect(examples.length).toBeGreaterThanOrEqual(20);
  });

  for (const { heading, code } of examples) {
    const isTierCheck = heading.includes("Check tier entitlement");
    const isCsvExport = heading.includes("Export all accounts to a CSV");
    const isResumeDownload = heading.includes("Download an applicant's resume");

    it(`${heading || "(untitled)"}: ${code.split("\n")[0]!.trim()}…`, async () => {
      tierCheckMode = isTierCheck;
      try {
        const { stdout } = await runExample(code);

        if (isCsvExport) {
          const csvPath = join(workDir, "accounts.csv");
          expect(existsSync(csvPath), "accounts.csv should have been written").toBe(true);
          expect(statSync(csvPath).size, "accounts.csv should be non-empty").toBeGreaterThan(0);
        } else if (isResumeDownload) {
          const resumePath = join(workDir, "resume.pdf");
          expect(existsSync(resumePath), "resume.pdf should have been written").toBe(true);
          expect(statSync(resumePath).size, "resume.pdf should be non-empty").toBeGreaterThan(0);
        } else {
          expect(stdout.length, `expected non-empty stdout; got:\n${stdout}`).toBeGreaterThan(0);
        }
      } finally {
        tierCheckMode = false;
      }
    }, 15_000);
  }
});

// ---------------------------------------------------------------------------
// The extractor itself, unit-level (no subprocess), so a change to the
// heading-matching or curviate-line filter is provable without a full run.
// ---------------------------------------------------------------------------

describe("extractBashExamples", () => {
  it("attributes a block to its nearest preceding heading", () => {
    const found = extractBashExamples(
      "## Usage\n\n### 4. Check tier entitlement before a sweep\n\n```bash\ncurviate account list\n```\n",
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.heading).toContain("Check tier entitlement");
  });

  it("skips a fenced block with no curviate-first line (the Install section)", () => {
    const found = extractBashExamples(
      "## Install\n\n```bash\nnpm install -g @curviate/cli\n```\n\n```bash\nnpx @curviate/cli --help\n```\n",
    );
    expect(found).toHaveLength(0);
  });

  it("skips the plain (non-bash) Usage synopsis fence", () => {
    const found = extractBashExamples("## Usage\n\n```\ncurviate [command] [subcommand] [flags]\n```\n");
    expect(found).toHaveLength(0);
  });
});
