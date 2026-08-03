/**
 * LinkedIn-account credential resolution.
 *
 * These are the secrets a customer supplies to connect/reconnect a LinkedIn
 * account (a password, a session cookie pair, an optional managed-proxy
 * password) — distinct from the Curviate API key (see `lib/resolve.ts`).
 * They are pass-through only: they land in exactly one place (the request
 * body assembled by the caller) and are never persisted client-side, logged,
 * or echoed.
 *
 * Resolution order per secret (highest wins):
 *   1. an explicit value flag, XOR its `--*-stdin` sibling
 *   2. an environment variable
 *   3. (required, prompt-eligible secrets only) a masked TTY prompt
 *   4. fail fast — never silently send an empty/missing required secret,
 *      never block reading stdin unless the caller explicitly asked for it
 *
 * An explicitly empty source (`--password ""` or `MY_ENV=""`) is treated as
 * no source at all and falls through to the next tier.
 */

import { defaultReadStdin } from "./stdin.js";
import { readlineSync } from "./readline.js";

export interface OutStreams {
  stderr: { write: (s: string) => void };
}

/**
 * Cue written to stderr before a tier-1b interactive-TTY stdin read — the
 * terminal never sends EOF on Enter, so a live-terminal `--*-stdin` read
 * takes exactly one line instead of waiting to EOF; this line tells the
 * human what's happening. Exported so callers/tests can assert on it without
 * duplicating the literal string.
 */
export const STDIN_TTY_CUE = "Reading secret from stdin (paste + Enter): ";

/**
 * Library-internal default for the single-line-reader seam — mirrors
 * `defaultReadStdin`'s role for `readStdin`. Always masked: the raw-mode
 * branch of `readlineSync` is the only mechanism here that suppresses echo
 * (the non-mask fallback does not), so this must never drop `{ mask: true }`.
 *
 * Passes an EMPTY prompt to `readlineSync`, not the cue: the caller (below)
 * already wrote `STDIN_TTY_CUE` to `out.stderr` before invoking this reader.
 * `readlineSync` itself writes its `prompt` argument to stderr too, so
 * passing the cue text through here would print it a second time on a real
 * terminal — the injected `out.stderr` write is the single visible cue.
 */
function defaultReadSingleLine(): Promise<string> {
  return readlineSync("", { mask: true });
}

export interface ResolveSecretPrompt {
  /** stdin.isTTY — injectable so tests never touch the real terminal. */
  isTTY: boolean;
  /** Injectable masked-prompt function (production: `lib/readline.ts`'s `readlineSync`). */
  readline: (prompt: string, opts?: { mask?: boolean }) => Promise<string>;
  promptText: string;
}

export interface ResolveSecretParams {
  /** The `--<flag>` value, if provided. */
  flagValue?: string;
  /** Whether the paired `--<flag>-stdin` boolean was passed. */
  stdinRequested?: boolean;
  /** Env var name checked at tier 2. */
  envVar: string;
  /**
   * `stdin.isTTY` — top-level (not nested in `prompt`), injectable so tests
   * never touch the real terminal. Gates the tier-1b `stdinRequested`
   * branch: TTY reads a single line via `readSingleLine`; non-TTY reads to
   * EOF via `readStdin`, unchanged. Deliberately separate from
   * `prompt.isTTY` (tier 3's masked-fallback gate, password-only) — the two
   * are gated by different questions (whether a stdin flag was passed, vs.
   * whether nothing at all was given) and must not be conflated. Default
   * false when omitted.
   */
  isTTY?: boolean;
  /** Injectable stdin reader (production: `lib/stdin.ts`'s `defaultReadStdin`). */
  readStdin?: () => Promise<string>;
  /**
   * Injectable single-line reader for the tier-1b interactive-TTY stdin
   * read (production: `lib/readline.ts`'s `readlineSync(cue, {mask:true})`
   * — the raw-mode, no-echo branch). A dedicated seam, never a reuse of
   * `readStdin` (a fundamentally different read shape — one line vs. to
   * EOF) or `prompt.readline` (a different gate, tier 3 vs. tier 1b).
   */
  readSingleLine?: (cue: string) => Promise<string>;
  /** Whether this secret must resolve to something (password, li_at) or may be omitted (li_a, proxy password). Default false. */
  required?: boolean;
  /** Error message written to stderr before exiting 2 when a required secret has no source. */
  failMessage?: string;
  /** Masked-prompt fallback — only ever supplied for the `credentials` password. */
  prompt?: ResolveSecretPrompt;
  /**
   * When false, tiers 3 (prompt) and 4 (fail-fast exit) are skipped even for
   * a required secret with nothing resolved — the caller gets `undefined`
   * back instead. Used for `--preview` (a client-side render must never
   * prompt or exit) and for a `credentials` call still missing `--email`
   * (nothing meaningful to prompt toward yet). Default true.
   *
   * Also the tier-1b default gate (see `allowInteractiveStdinRead` below)
   * when that field is omitted — most callers (li_at, cookie secrets) have
   * no reason for the two gates to diverge.
   */
  allowInteractive?: boolean;
  /**
   * Tier-1b's OWN gate for the interactive-TTY `stdinRequested` read —
   * preview-only, deliberately decoupled from `allowInteractive`. The
   * `credentials` password call gates tier 3 (masked prompt) and tier 4
   * (fail-fast) on `!preview && Boolean(email)` — nothing meaningful to
   * prompt/fail toward without an email yet — but tier-1b must still fire on
   * `--password-stdin` whenever the run isn't a preview, `--email` or not:
   * the user explicitly asked for a stdin read, and suppressing it based on
   * an unrelated flag would silently swallow a real paste (any resulting
   * email-less body still gets rejected downstream, as expected). Defaults
   * to `allowInteractive` when omitted, so callers with no such divergence
   * (li_at) need not pass it.
   */
  allowInteractiveStdinRead?: boolean;
  out: OutStreams;
}

/**
 * Resolve one LinkedIn-account secret through the flag/stdin/env/prompt
 * tiers described above. Returns `undefined` for an optional secret with no
 * source; exits 2 (after writing `failMessage`) for a required secret with
 * no source when interactive fallbacks are exhausted or disallowed.
 */
export async function resolveSecret(params: ResolveSecretParams): Promise<string | undefined> {
  // Tier 1a: value flag (non-empty).
  if (params.flagValue !== undefined && params.flagValue !== "") {
    return params.flagValue;
  }

  // Tier 1b: stdin (mutually exclusive with the value flag — conflicts are
  // rejected upstream by checkCredentialConflicts before resolution starts).
  //
  // Mode-aware: a live terminal never sends EOF on Enter, so a naive
  // to-EOF read hangs forever on a TTY. Non-TTY (piped/redirected) keeps the
  // original to-EOF read, byte-for-byte. An interactive TTY instead reads a
  // single line (paste + Enter resolves immediately) through the dedicated
  // single-line-reader seam — never through `readStdin`, which would still
  // hang on a live terminal past EOF.
  if (params.stdinRequested) {
    if (params.isTTY) {
      // Suppressed entirely under --preview (allowInteractiveStdinRead ===
      // false, defaulting to allowInteractive): no cue, no block, no reader
      // call — a client-side render must never prompt or read from the
      // terminal. Falls through to the next tier exactly as if nothing had
      // been typed. Preview-only — deliberately NOT the same gate as tier 3
      // (see `allowInteractiveStdinRead`'s doc comment): an explicit
      // --*-stdin read must still fire even when tier 3/4 are suppressed for
      // an unrelated reason (e.g. `credentials` with no --email yet).
      const stdinReadAllowed = params.allowInteractiveStdinRead ?? params.allowInteractive;
      if (stdinReadAllowed !== false) {
        params.out.stderr.write(STDIN_TTY_CUE);
        const reader = params.readSingleLine ?? defaultReadSingleLine;
        const raw = await reader(STDIN_TTY_CUE);
        // The raw-mode reader resolves un-trimmed — trimming is this
        // resolver's job (matches the non-TTY EOF tier's own trim).
        const trimmed = raw.trim();
        if (trimmed !== "") {
          return trimmed;
        }
        // An empty line (bare Enter) falls through to the next tier, same
        // as an explicitly empty flag/env value.
      }
    } else {
      const reader = params.readStdin ?? defaultReadStdin;
      const raw = await reader();
      const trimmed = raw.trim();
      if (trimmed !== "") {
        return trimmed;
      }
      // An explicitly requested-but-empty stdin read falls through, same as
      // an explicitly empty flag/env value — never silently send "".
    }
  }

  // Tier 2: environment variable (non-empty).
  const envValue = process.env[params.envVar];
  if (envValue !== undefined && envValue !== "") {
    return envValue;
  }

  // Optional secret: flag > env > omitted. No prompt, no fail-fast.
  if (!params.required) {
    return undefined;
  }

  // Interactive fallbacks suppressed (preview render, or a gating condition
  // like "no --email yet" upstream) — return undefined rather than prompt
  // or exit, so a client-side render never blocks or fails.
  if (params.allowInteractive === false) {
    return undefined;
  }

  // Tier 3: masked TTY prompt (password only — `prompt` is only ever passed
  // for the credentials-method password; the cookie method has none).
  if (params.prompt && params.prompt.isTTY) {
    const value = await params.prompt.readline(params.prompt.promptText, { mask: true });
    if (value) {
      return value;
    }
    // A blank prompt entry falls straight to the fail-fast below — this is
    // not a re-prompt loop.
  }

  // Tier 4: fail fast. Never read stdin here — the read only ever happens
  // in the stdinRequested branch above, so a non-interactive caller with no
  // source can never hang.
  params.out.stderr.write(`error: ${params.failMessage ?? "missing required credential"}\n`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Conflict matrix
// ---------------------------------------------------------------------------

export interface CredentialConflictFlags {
  password?: string;
  "password-stdin"?: boolean;
  "li-at"?: string;
  "li-at-stdin"?: boolean;
  "auth-method"?: string;
}

/**
 * Reject the 5 stdin/flag conflict combinations as usage errors (exit 2,
 * zero SDK/network calls) before any resolution begins:
 *   1. `--password` and `--password-stdin` together.
 *   2. `--li-at` and `--li-at-stdin` together.
 *   3. `--password-stdin` and `--li-at-stdin` together (stdin feeds one secret).
 *   4. `--li-at-stdin` with `--auth-method credentials` (mismatched secret).
 *   5. `--password-stdin` with `--auth-method cookie` (mismatched secret).
 */
export function checkCredentialConflicts(flags: CredentialConflictFlags, out: OutStreams): void {
  const passwordStdin = flags["password-stdin"] ?? false;
  const liAtStdin = flags["li-at-stdin"] ?? false;

  if (flags.password !== undefined && passwordStdin) {
    failConflict(out, "--password and --password-stdin cannot both be set. Choose one source.");
  }
  if (flags["li-at"] !== undefined && liAtStdin) {
    failConflict(out, "--li-at and --li-at-stdin cannot both be set. Choose one source.");
  }
  if (passwordStdin && liAtStdin) {
    failConflict(
      out,
      "--password-stdin and --li-at-stdin cannot both be set. stdin can feed only one secret per invocation.",
    );
  }
  if (liAtStdin && flags["auth-method"] === "credentials") {
    failConflict(out, "--li-at-stdin requires --auth-method cookie (it does not apply to the credentials method).");
  }
  if (passwordStdin && flags["auth-method"] === "cookie") {
    failConflict(out, "--password-stdin requires --auth-method credentials (it does not apply to the cookie method).");
  }
}

function failConflict(out: OutStreams, message: string): never {
  out.stderr.write(`error: ${message}\n`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// --preview secret masking
// ---------------------------------------------------------------------------

const SECRET_MASK = "••••";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Return a copy of a request body with every known LinkedIn-credential
 * field (`credentials.password`, `cookie.li_at`, `cookie.li_a`,
 * `proxy.password`) replaced by a fixed mask, for `--preview` rendering.
 * Never mutates the input — the real (unmasked) body still goes to the
 * actual SDK call on a non-preview run.
 */
export function maskCredentialSecretsForPreview(body: Record<string, unknown>): Record<string, unknown> {
  const masked: Record<string, unknown> = { ...body };

  const credentials = masked["credentials"];
  if (isRecord(credentials) && "password" in credentials) {
    masked["credentials"] = { ...credentials, password: SECRET_MASK };
  }

  const cookie = masked["cookie"];
  if (isRecord(cookie)) {
    const maskedCookie = { ...cookie };
    if ("li_at" in maskedCookie) maskedCookie["li_at"] = SECRET_MASK;
    if ("li_a" in maskedCookie) maskedCookie["li_a"] = SECRET_MASK;
    masked["cookie"] = maskedCookie;
  }

  const proxy = masked["proxy"];
  if (isRecord(proxy) && "password" in proxy) {
    masked["proxy"] = { ...proxy, password: SECRET_MASK };
  }

  return masked;
}
