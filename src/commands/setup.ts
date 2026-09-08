/**
 * `curviate setup`, one-command onboarding: open the dashboard, paste the
 * code it shows you, land an API key in a local profile.
 *
 * ## The shape, and why
 *
 * The one-time code is minted INSIDE the user's already-authenticated
 * dashboard session and displayed only there. There is no approval step and
 * no polling. Redemption needs two secrets held in two places: a `session_id`
 * this process generates and never shows anyone, and the code the browser
 * displays. A code read aloud, screen-shared or shoulder-surfed is useless
 * without the session id sitting in this terminal.
 *
 * The delivered key is additionally sealed to an ephemeral P-256 key this
 * process generates per run, so the pasted code is a retrieval key rather
 * than a bearer credential: the exchange response is unreadable to anyone
 * but the process that started the flow.
 *
 * ## Three values here are secrets
 *
 * The `session_id`, the verification code and the delivered API key must
 * never reach stdout, stderr, a log, or an error body. The only place the
 * key lands is the `0600` profile file; the only place the session id and
 * the private key land is the `0600` resume file below.
 *
 * ## Ordering that matters
 *
 * The authorize URL is printed BEFORE any prompt or gate, so a user who
 * opens the link by hand is never staring at a terminal that has not
 * started. And the code prompt is a PLAIN VISIBLE text input: a masked
 * widget swallows bracketed paste, which is a real shipped failure in this
 * class of tool.
 */

import { defineCommand } from "citty";
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getConfigPath, writeProfile } from "../lib/config.js";
import { createClient } from "../lib/client.js";
import { GLOBAL_FLAGS } from "../lib/global-flags.js";
import { readlineSync, type ReadlineStdin } from "../lib/readline.js";
import { resolveEffectiveConfig } from "../lib/resolve.js";
import { defaultReadStdin, isStdinToken, resolveTextOrStdin } from "../lib/stdin.js";

// ---------------------------------------------------------------------------
// Code format
// ---------------------------------------------------------------------------

/**
 * The code alphabet. No digits and no vowels, so there is no `0`/`O` or
 * `1`/`l` confusion and no accidental words.
 */
const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

/**
 * Normalise a pasted code: uppercase, then drop every character outside the
 * alphabet.
 *
 * That single filter is what makes a lowercase paste, a paste with the
 * readability hyphen dropped, a paste with a trailing space, and a bracketed
 * paste (which arrives wrapped in `ESC [ 200 ~` ... `ESC [ 201 ~`) all
 * submit the same eight characters. None of the wrapper's bytes survive the
 * filter, because none of them is a letter in the alphabet.
 */
export function normaliseCode(raw: string): string {
  let out = "";
  const upper = raw.toUpperCase();
  for (const char of upper) if (CODE_ALPHABET.includes(char)) out += char;
  return out;
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/**
 * The authorize URL the user opens: the base URL's origin, with a trailing
 * `/api` path segment removed, plus `/cli` and the two query values.
 */
export function authorizeUrl(
  baseUrl: string,
  sessionId: string,
  publicKey: string,
): string {
  const parsed = new URL(baseUrl);
  const prefix = parsed.pathname.replace(/\/?api\/?$/, "").replace(/\/$/, "");
  const url = new URL(`${parsed.origin}${prefix}/cli`);
  url.searchParams.set("sid", sessionId);
  url.searchParams.set("pk", publicKey);
  return url.toString();
}

function exchangeUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/api/auth/cli/exchange`;
}

// ---------------------------------------------------------------------------
// Session material
// ---------------------------------------------------------------------------

/** Bytes of session-id entropy. 18 bytes is 144 bits. */
const SESSION_ID_BYTES = 18;

const HKDF_INFO = "curviate-cli-setup-v1";
const SEAL_ALG = "ECDH-P256-HKDF-SHA256-A256GCM";
const GCM_TAG_BYTES = 16;

export interface SessionMaterial {
  sessionId: string;
  /** Raw uncompressed P-256 point, base64url. */
  publicKey: string;
  /** The private scalar, base64url. Never displayed, never transmitted. */
  privateKey: string;
}

export function generateSessionMaterial(): SessionMaterial {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    sessionId: randomBytes(SESSION_ID_BYTES).toString("base64url"),
    publicKey: ecdh.getPublicKey().toString("base64url"),
    privateKey: ecdh.getPrivateKey().toString("base64url"),
  };
}

/** The sealed-key object the exchange returns. */
export interface SealedKey {
  alg: string;
  epk: string;
  iv: string;
  ciphertext: string;
}

/**
 * Recover the API key from the sealed response.
 *
 * ECDH against the server's ephemeral point, HKDF-SHA256 to an AES-256 key,
 * AES-GCM open with no additional data. The authentication tag is the last
 * 16 bytes of `ciphertext`.
 */
export function unsealApiKey(sealed: SealedKey, privateKey: string): string {
  if (sealed.alg !== SEAL_ALG) {
    throw new Error(`Unsupported sealing algorithm "${sealed.alg}".`);
  }
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(privateKey, "base64url"));
  const shared = ecdh.computeSecret(Buffer.from(sealed.epk, "base64url"));
  const key = Buffer.from(
    hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.from(HKDF_INFO, "utf8"), 32),
  );
  const blob = Buffer.from(sealed.ciphertext, "base64url");
  if (blob.length <= GCM_TAG_BYTES) throw new Error("Sealed payload is truncated.");
  const body = blob.subarray(0, blob.length - GCM_TAG_BYTES);
  const tag = blob.subarray(blob.length - GCM_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64url"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

// ---------------------------------------------------------------------------
// Resume state
// ---------------------------------------------------------------------------

/**
 * Why a file exists at all.
 *
 * `--code -` is deliberately a SEPARATE process from the one that printed
 * the authorize URL: an agent relays the URL to a human, waits, and then
 * runs a second command. That second process has to reconstruct the session
 * id and the private key, and neither may travel through argv, an
 * environment variable, or any output stream. So the first process parks
 * them next to the config file at `0600` and the second reads them back.
 *
 * The file is removed on success and on expiry, so it never outlives the
 * flow it belongs to.
 */
interface ResumeState extends SessionMaterial {
  baseUrl: string;
  profile: string;
  createdAt: number;
}

export function resumeStatePath(): string {
  return join(dirname(getConfigPath()), "setup-session.json");
}

async function writeResumeState(state: ResumeState): Promise<void> {
  const path = resumeStatePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(state) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    // Non-POSIX host: the mode above is the best available.
  }
}

async function readResumeState(): Promise<ResumeState | null> {
  try {
    return JSON.parse(await readFile(resumeStatePath(), "utf8")) as ResumeState;
  } catch {
    return null;
  }
}

async function clearResumeState(): Promise<void> {
  await rm(resumeStatePath(), { force: true });
}

// ---------------------------------------------------------------------------
// Exchange
// ---------------------------------------------------------------------------

interface ExchangeBody {
  sealed_key: SealedKey;
  tenant_name: string;
  account_id?: string;
}

type ExchangeFailure =
  | "invalid_code"
  | "expired"
  | "no_api_key"
  | "rate_limited"
  | "unreachable"
  | "unexpected";

type ExchangeResult =
  | { ok: true; body: ExchangeBody }
  | { ok: false; failure: ExchangeFailure; message: string };

/** The structured error envelope, flat or wrapped, whichever arrives. */
function envelopeOf(payload: unknown): { code?: string; message?: string } {
  if (typeof payload !== "object" || payload === null) return {};
  const obj = payload as Record<string, unknown>;
  const inner = (typeof obj["error"] === "object" && obj["error"] !== null ? obj["error"] : obj) as
    Record<string, unknown>;
  return {
    code: typeof inner["code"] === "string" ? inner["code"] : undefined,
    message: typeof inner["message"] === "string" ? inner["message"] : undefined,
  };
}

async function exchange(
  baseUrl: string,
  sessionId: string,
  code: string,
  fetchImpl: typeof fetch,
): Promise<ExchangeResult> {
  let response: Response;
  try {
    response = await fetchImpl(exchangeUrl(baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, verification_code: code }),
    });
  } catch {
    // Deliberately not quoting the caught error: a transport error can carry
    // the request it failed on, and that request body holds two secrets.
    return {
      ok: false,
      failure: "unreachable",
      message:
        `Could not reach the API at ${baseUrl}. Check your network, ` +
        "or the base URL if you overrode it, and run `curviate setup` again.",
    };
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (response.ok) {
    const body = payload as ExchangeBody | null;
    if (!body || typeof body !== "object" || !body.sealed_key) {
      return { ok: false, failure: "unexpected", message: "The API returned an unreadable response." };
    }
    return { ok: true, body };
  }

  const { code: errorCode, message } = envelopeOf(payload);
  switch (errorCode) {
    case "CLI_SETUP_INVALID_CODE":
      return { ok: false, failure: "invalid_code", message: "That code was not accepted." };
    case "CLI_SETUP_EXPIRED":
      return {
        ok: false,
        failure: "expired",
        message:
          "That code has expired. A code is good for ten minutes and for five " +
          "attempts. Run `curviate setup` again to get a fresh one.",
      };
    case "CLI_SETUP_NO_API_KEY":
      return {
        ok: false,
        failure: "no_api_key",
        message: message ?? "This workspace has no API key. Create one in the dashboard, then run `curviate setup` again.",
      };
    case "PLATFORM_RATE_LIMIT":
      return {
        ok: false,
        failure: "rate_limited",
        message: message ?? "Too many attempts against this endpoint. Wait a moment and try again.",
      };
    default:
      return {
        ok: false,
        failure: "unexpected",
        message: message ?? `The API refused the exchange (HTTP ${response.status}).`,
      };
  }
}

/** Exit code for a failed exchange. */
function exitCodeFor(failure: ExchangeFailure): number {
  if (failure === "rate_limited") return 6;
  if (failure === "unreachable") return 7;
  if (failure === "unexpected") return 1;
  return 3;
}

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

/**
 * Is there plausibly a browser on this machine?
 *
 * Detected rather than flagged: continuous integration, any of the three
 * markers a remote shell sets, and a Linux session with no display are all
 * browserless. Everything else about the flow is identical either way, which
 * is the point: the paste works the same whether the page opened here or on
 * the user's phone.
 */
export function browserAvailable(
  env: NodeJS.ProcessEnv,
  platform: string,
): boolean {
  if (env["CI"]) return false;
  if (env["SSH_CONNECTION"] || env["SSH_TTY"] || env["SSH_CLIENT"]) return false;
  if (platform === "linux" && !env["DISPLAY"] && !env["WAYLAND_DISPLAY"]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// IO seam
// ---------------------------------------------------------------------------

export interface SetupIO {
  stdout: { write: (s: string) => void };
  stderr: { write: (s: string) => void };
  /** Is stdin a terminal? Decides whether a prompt is possible at all. */
  isTTY: boolean;
  /** Is stdout a terminal? Decides human vs. agent rendering. */
  isOutputTTY: boolean;
  env: NodeJS.ProcessEnv;
  platform: string;
  /**
   * A PLAIN, VISIBLE line read. Never the masked reader `login` uses: a
   * masked widget swallows bracketed paste, and the pasted code is the
   * entire point of this command.
   */
  prompt: (prompt: string) => Promise<string>;
  /**
   * The stream the DEFAULT prompt reads from. Defaults to the real stdin.
   *
   * It is a separate seam from `prompt` on purpose: a test that supplies its
   * own `prompt` replaces the production reader and can no longer see whether
   * that reader asked for masking, which is the one property a paste depends
   * on. Supplying only the stream leaves the masking decision under test.
   */
  stdinStream?: ReadlineStdin;
  readStdin: () => Promise<string>;
  open: (url: string) => Promise<unknown>;
  fetch: typeof fetch;
  /** One real API call, proving the key that was just written works. */
  verify: (apiKey: string, baseUrl: string) => Promise<void>;
  /** Session material generator, overridden only to pin values in a test. */
  generate: () => SessionMaterial;
}

/**
 * The real browser opener, imported dynamically so the package (and any
 * browser it might spawn) is touched only on this exact path.
 */
async function defaultOpen(url: string): Promise<unknown> {
  const open = (await import("open")).default;
  return open(url);
}

async function defaultVerify(apiKey: string, baseUrl: string): Promise<void> {
  await createClient({ apiKey, baseUrl }).accounts.list();
}

export function resolveSetupIO(io: Partial<SetupIO> = {}): SetupIO {
  return {
    stdout: io.stdout ?? { write: (s: string) => void process.stdout.write(s) },
    stderr: io.stderr ?? { write: (s: string) => void process.stderr.write(s) },
    isTTY: io.isTTY ?? (process.stdin.isTTY ?? false),
    isOutputTTY: io.isOutputTTY ?? (process.stdout.isTTY ?? false),
    env: io.env ?? process.env,
    platform: io.platform ?? process.platform,
    // The unmasked branch, deliberately: a masked widget swallows bracketed
    // paste, and a pasted code is the whole point of this command.
    prompt:
      io.prompt ??
      ((p: string) => readlineSync(p, io.stdinStream ? { stdin: io.stdinStream } : {})),
    ...(io.stdinStream !== undefined ? { stdinStream: io.stdinStream } : {}),
    readStdin: io.readStdin ?? defaultReadStdin,
    open: io.open ?? defaultOpen,
    fetch: io.fetch ?? fetch,
    verify: io.verify ?? defaultVerify,
    generate: io.generate ?? generateSessionMaterial,
  };
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export interface SetupArgs {
  profile?: string;
  "base-url"?: string;
  "api-key"?: string;
  timeout?: string;
  json?: boolean;
  "no-browser"?: boolean;
  code?: string;
}

const MAX_ATTEMPTS = 3;

const NON_TTY_MESSAGE =
  "error: `curviate setup` needs a terminal to paste the code into.\n" +
  "hint: set CURVIATE_API_KEY, or pipe an existing key with `curviate login --api-key -`.\n";

const SECRET_FLAG_WARNING =
  "Note: a value on the command line is visible to other processes via `ps` and saved in shell history; prefer `--code -` to read it from stdin.\n";

/**
 * Run `setup`. Returns the process exit code; `0` on success.
 *
 * Split out from the citty handler so tests drive the whole flow with an
 * injected terminal, an injected clock-free transport and an injected
 * browser opener, and read the exit code as a value instead of trapping
 * `process.exit`.
 */
export async function runSetup(args: SetupArgs, io: SetupIO): Promise<number> {
  const profileName = args.profile ?? "default";
  const effective = await resolveEffectiveConfig({
    baseUrl: args["base-url"],
    profile: args.profile,
  });
  const baseUrl = effective.baseUrl;
  const json = args.json === true || !io.isOutputTTY;

  // ---- Resume: a second process finishing a flow the first one started ----
  if (args.code !== undefined) {
    // Resolve stdin FIRST. The code may be a secret arriving on a pipe, and
    // reading it before anything else means an empty pipe is diagnosed as an
    // empty pipe rather than as a missing session.
    const raw = await resolveTextOrStdin(args.code, io, async () =>
      (await io.readStdin()).trim(),
    );
    // A code typed as a flag VALUE is visible in `ps` and in shell history,
    // so it earns the same warning every other secret value flag carries.
    if (!isStdinToken(args.code)) io.stderr.write(SECRET_FLAG_WARNING);

    const state = await readResumeState();
    if (!state) {
      io.stderr.write(
        "error: no setup is in progress. Run `curviate setup --json` first, open the " +
          "authorize URL it prints, then pass the code back with `curviate setup --code -`.\n",
      );
      return 2;
    }
    return finishExchange(
      state.baseUrl,
      state,
      normaliseCode(raw),
      state.profile,
      { json, single: true },
      io,
    );
  }

  // ---- Fresh flow ----
  const material = io.generate();
  const url = authorizeUrl(baseUrl, material.sessionId, material.publicKey);

  if (json) {
    // The agent path. One object, and neither the code nor the key is ever a
    // field in it: an agent relays the URL to a human, and then runs the
    // command `next_step` names.
    await writeResumeState({
      ...material,
      baseUrl,
      profile: profileName,
      createdAt: Date.now(),
    });
    io.stdout.write(
      JSON.stringify({
        authorize_url: url,
        next_step: "curviate setup --code -",
        instructions:
          "Open authorize_url in a signed-in browser, press Authorize, then run " +
          "next_step with the displayed code on stdin.",
      }) + "\n",
    );
    return 0;
  }

  // The URL goes out BEFORE any prompt or gate. A user who opens the link by
  // hand must never find a terminal that has not started.
  io.stdout.write(url + "\n");
  io.stderr.write(
    "Open the link above, press Authorize, and paste the code it shows you.\n",
  );

  if (!io.isTTY) {
    io.stderr.write(NON_TTY_MESSAGE);
    return 2;
  }

  const canOpen = browserAvailable(io.env, io.platform);
  if (args["no-browser"] === true) {
    if (canOpen) {
      io.stderr.write(
        "Not opening a browser because --no-browser was passed, though one appears to be available here.\n",
      );
    }
  } else if (!canOpen) {
    io.stderr.write(
      "No browser here, so nothing was opened. Open the link on any device you are signed in on.\n",
    );
  } else {
    try {
      await io.open(url);
    } catch {
      io.stderr.write("Could not open a browser. Open the link above by hand.\n");
    }
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const label =
      attempt === 0 ? "Paste the code: " : `Retry (${attempt}/${MAX_ATTEMPTS - 1}): `;
    const typed = normaliseCode(await io.prompt(label));
    const result = await finishExchange(
      baseUrl,
      material,
      typed,
      profileName,
      { json, single: attempt === MAX_ATTEMPTS - 1 },
      io,
    );
    if (result === 0) return 0;
    if (result !== RETRY) return result;
  }
  return 3;
}

/** Sentinel returned by `finishExchange` when the caller should re-prompt. */
const RETRY = -1;

async function finishExchange(
  baseUrl: string,
  material: SessionMaterial,
  code: string,
  profileName: string,
  opts: { json: boolean; single: boolean },
  io: SetupIO,
): Promise<number> {
  const result = await exchange(baseUrl, material.sessionId, code, io.fetch);

  if (!result.ok) {
    if (result.failure === "invalid_code" && !opts.single) {
      io.stderr.write(result.message + "\n");
      return RETRY;
    }
    if (result.failure === "expired" || result.failure === "invalid_code") {
      // Both end the flow, so the parked session material is dead weight and
      // is removed rather than left on disk.
      await clearResumeState();
    }
    const finalMessage =
      result.failure === "invalid_code"
        ? "That code was not accepted. Run `curviate setup` again for a fresh one."
        : result.message;
    io.stderr.write(`error: ${finalMessage}\n`);
    return exitCodeFor(result.failure);
  }

  let apiKey: string;
  try {
    apiKey = unsealApiKey(result.body.sealed_key, material.privateKey);
  } catch {
    io.stderr.write(
      "error: the delivered credential could not be opened by this process. Run `curviate setup` again.\n",
    );
    return 1;
  }

  await writeProfile(profileName, {
    apiKey,
    tenant: result.body.tenant_name,
    ...(result.body.account_id !== undefined ? { account: result.body.account_id } : {}),
  });
  await clearResumeState();

  try {
    await io.verify(apiKey, baseUrl);
  } catch {
    io.stderr.write(
      "error: the credential was saved but a verifying call did not succeed. Run `curviate doctor` for detail.\n",
    );
    return 3;
  }

  const summary = {
    ok: true,
    tenant: result.body.tenant_name,
    profile: profileName,
    ...(result.body.account_id !== undefined ? { account_id: result.body.account_id } : {}),
  };
  if (opts.json) {
    io.stdout.write(JSON.stringify(summary) + "\n");
  } else {
    io.stderr.write(
      `Authenticated as ${result.body.tenant_name}. Saved to profile "${profileName}".\n`,
    );
    if (result.body.account_id !== undefined) {
      io.stderr.write(`Default account set to ${result.body.account_id}.\n`);
    }
    io.stderr.write("Run `curviate doctor` to confirm.\n");
  }
  return 0;
}

export const setupCommand = defineCommand({
  meta: {
    name: "setup",
    description:
      "Connect this machine to your workspace: opens the dashboard, takes the code it shows you, and saves an API key.",
  },
  args: {
    profile: GLOBAL_FLAGS.profile,
    "base-url": GLOBAL_FLAGS["base-url"],
    json: GLOBAL_FLAGS.json,
    "no-browser": {
      type: "boolean",
      description: "Do not try to open a browser; just print the link.",
      default: false,
    },
    code: {
      type: "string",
      stdinArg: true,
      description:
        'Verification code from the dashboard. Pass "-" to read it from stdin, which keeps it out of argv, `ps` and shell history.',
    },
  },
  async run({ args }) {
    const io = resolveSetupIO();
    const code = await runSetup(
      {
        profile: args.profile as string | undefined,
        "base-url": args["base-url"] as string | undefined,
        json: args.json as boolean | undefined,
        "no-browser": args["no-browser"] as boolean | undefined,
        code: args.code as string | undefined,
      },
      io,
    );
    if (code !== 0) process.exit(code);
  },
});
