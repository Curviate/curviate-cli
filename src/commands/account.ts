/**
 * `curviate account` — account connection management (root-scoped).
 *
 * Subcommands:
 *   account list                                      — list connected accounts
 *   account get <account_id>                          — get one account
 *   account link <body…>                              — link a new account (write)
 *   account connect-session poll --session <id>       — poll a hosted connect session for completion (write)
 *   account update <account_id> <body…>               — update metadata / proxy config (write)
 *   account disconnect <account_id>                   — hard-disconnect an account (write)
 *   account checkpoint solve <account_id> --code      — solve a checkpoint with an OTP/2FA code (path-addressed, write)
 *   account checkpoint poll <account_id>              — poll mobile-app approval (path-addressed, write)
 *   account checkpoint request <account_id>           — re-request the challenge notification (path-addressed, write)
 *
 * Root-scoped: all methods live on `curviate.accounts.*` (NOT account-scoped).
 * account_id positionals pass verbatim (NOT resolveIdentifier — not a member/company id).
 * Checkpoint ops are path-addressed: the account_id (the provisional account from
 * the 202 response) is a positional argument that the SDK interpolates into the
 * request path, not a body field.
 *
 * The run functions are typed against the real exported `Curviate` client, so a
 * renamed/removed/relocated SDK method is a compile error at the call site rather
 * than a latent runtime failure. Coverage is tracked in the SDK-parity manifest
 * (test/parity.test.ts).
 *
 * Slim projection (default): account list and account get return a
 * compact field subset — six cached account-enrichment fields (username,
 * premium_id, public_identifier, substrate_created_at, signatures, groups)
 * are verbose-only. Pass --verbose for the full SDK response. account get
 * keeps --fields but suppresses --limit/--cursor/--all/--max-pages (a
 * single-object read) — account list is unaffected (a genuine list read,
 * keeps all pagination flags).
 */

import { defineCommand } from "citty";
import { GLOBAL_FLAGS, READ_SINGLE_FLAGS, WRITE_SINGLE_FLAGS } from "../lib/global-flags.js";
import { resolveEffectiveConfig } from "../lib/resolve.js";
import { createClient } from "../lib/client.js";
import { renderSuccess, renderError, renderUnexpectedError } from "../lib/output.js";
import { buildPreviewOutput } from "../lib/preview.js";
import { streamAll, pageDelayFromFlags } from "../lib/paginate.js";
import { slimAccountList, slimAccountListItem, slimAccountGet } from "../lib/slim.js";
import { readlineSync } from "../lib/readline.js";
import { defaultReadStdin } from "../lib/stdin.js";
import {
  resolveSecret,
  checkCredentialConflicts,
  maskCredentialSecretsForPreview,
} from "../lib/credential-resolve.js";
import { AUTH_NEEDED } from "../lib/exit-codes.js";
import {
  printChallengeCopy,
  printResendHintIfApplicable,
  type ChallengeType,
} from "../lib/checkpoint-copy.js";
import {
  CHECKPOINT_POLL_FIRST_DELAY_MS,
  nextCheckpointPollDelayMs,
} from "../lib/checkpoint-cadence.js";
import type { Curviate, CurviateError, paths } from "@curviate/sdk";

/**
 * `POST /v1/auth/intent` body — a narrow cast target only (see
 * `runAccountLink`'s comment): the body is assembled dynamically from
 * credential-resolution helpers, not a single typed literal.
 */
type AuthIntentBody = paths["/v1/auth/intent"]["post"]["requestBody"]["content"]["application/json"];

// ps/shell-history warning template (mirrors the --api-key warning in global-flags.ts).
const PW_WARNING = (stdinFlag: string, envVar: string) =>
  `Note: a value on the command line is visible to other processes via \`ps\` and saved in shell history; prefer \`${stdinFlag}\` or the ${envVar} env var.`;
const OPTIONAL_SECRET_WARNING = (envVar: string) =>
  `Note: a value on the command line is visible to other processes via \`ps\` and saved in shell history; prefer the ${envVar} env var.`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AccountFlags = {
  // positional / path
  "account-id"?: string;
  // link / reconnect body fields
  "seat-id"?: string;
  "auth-method"?: string;
  email?: string;
  password?: string;
  "password-stdin"?: boolean;
  "li-at"?: string;
  "li-at-stdin"?: boolean;
  "li-a"?: string;
  "no-interactive"?: boolean;
  country?: string;
  ip?: string;
  "proxy-protocol"?: string;
  "proxy-host"?: string;
  "proxy-port"?: string;
  "proxy-username"?: string;
  "proxy-password"?: string;
  "user-agent"?: string;
  "recruiter-contract-id"?: string;
  // update body fields
  metadata?: string;     // JSON object string → flat string→string metadata map
  "clear-proxy"?: boolean; // update: send proxy:null to clear the custom proxy
  // connect-link / reconnect-link body fields
  "expires-in-seconds"?: string;
  "redirect-url"?: string;
  // connect-link / reconnect-link / connect-session poll open+wait UX
  open?: boolean;        // connect-link / reconnect-link: auto-open the URL (TTY+interactive default: on)
  session?: string;      // connect-session poll: the session_id to poll
  // checkpoint body fields (account_id is the positional/path arg, not a body field)
  code?: string;
  wait?: boolean;        // checkpoint poll / connect-link / connect-session poll --wait: adaptive-cadence loop instead of a single poll
  // global
  json?: boolean;
  fields?: string;
  limit?: string;
  cursor?: string;
  all?: boolean;
  "max-pages"?: string;
  "page-delay"?: string;
  preview?: boolean;
  verbose?: boolean;
  "api-key"?: string;
  "base-url"?: string;
  timeout?: string;
  profile?: string;
};

type OutputStreams = {
  stdout: { write: (s: string) => void };
  stderr: { write: (s: string) => void };
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function rejectPreviewOnRead(preview: boolean | undefined, out: OutputStreams): void {
  if (preview) {
    out.stderr.write("error: --preview is only valid on write commands (mutations). Reads just run.\n");
    process.exit(2);
  }
}

function rejectAllOnNonPaginated(all: boolean | undefined, out: OutputStreams): void {
  if (all) {
    out.stderr.write("error: --all is not supported on non-paginated commands.\n");
    process.exit(2);
  }
}

function buildOutputStreams(): OutputStreams {
  return {
    stdout: { write: (s: string) => process.stdout.write(s) },
    stderr: { write: (s: string) => process.stderr.write(s) },
  };
}

function resolveOutputOpts(flags: AccountFlags) {
  return {
    json: (flags.json ?? false) || !process.stdout.isTTY,
    isTTY: process.stdout.isTTY ?? false,
    fields: flags.fields,
    verbose: flags.verbose ?? false,
  };
}

async function handleError(err: unknown, outOpts: ReturnType<typeof resolveOutputOpts>, out: OutputStreams): Promise<never> {
  const { CurviateError } = await import("@curviate/sdk");
  if (err instanceof CurviateError) {
    const { getExitCode } = await import("../lib/exit-codes.js");
    renderError(err as CurviateError, outOpts, out);
    process.exit(getExitCode(err.code));
  }
  renderUnexpectedError(err, out);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Exported run functions (testable without citty)
// ---------------------------------------------------------------------------

/** Run `account list [--all] [--limit] [--cursor]`. */
export async function runAccountList(
  client: Curviate,
  flags: AccountFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const outOpts = resolveOutputOpts(flags);
  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;
  const limit = flags.limit ? parseInt(flags.limit, 10) : undefined;
  const cursor = flags.cursor;

  const params: Record<string, unknown> = {};
  if (limit !== undefined) params["limit"] = limit;
  if (cursor) params["cursor"] = cursor;

  try {
    if (all) {
      const fn = (p: Record<string, unknown>) =>
        client.accounts.list(p) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        // Slim mode (default) projects each NDJSON item too; --verbose emits raw items.
        const projected = outOpts.verbose ? item : slimAccountListItem(item as Record<string, unknown>);
        out.stdout.write(JSON.stringify(projected) + "\n");
      }
    } else {
      const result = await client.accounts.list(params);
      renderSuccess(result, { ...outOpts, slim: slimAccountList }, out);
    }
  } catch (err) {
    await handleError(err, outOpts, out);
  }
}

/** Run `account get <account_id>`. account_id passes verbatim. */
export async function runAccountGet(
  client: Curviate,
  flags: AccountFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);
  rejectAllOnNonPaginated(flags.all, out);

  const accountId = flags["account-id"] ?? "";
  const outOpts = resolveOutputOpts(flags);

  try {
    const result = await client.accounts.get(accountId);
    renderSuccess(result, { ...outOpts, slim: slimAccountGet }, out);
  } catch (err) {
    await handleError(err, outOpts, out);
  }
}

/**
 * Injectable seams for LinkedIn-credential resolution (masked prompt +
 * non-TTY fail-fast) and for the guided checkpoint follow-through loop. All
 * optional — real defaults (the actual TTY state, the real masked readline,
 * the real stdin reader, the real clock/timer) are substituted when
 * omitted, so existing call sites need not pass this at all.
 */
export interface CredentialIO {
  /** stdin.isTTY — injectable for tests. Defaults to the real process.stdin.isTTY. */
  isTTY?: boolean;
  /**
   * stdout.isTTY — injectable for tests. Defaults to the real
   * process.stdout.isTTY. Combined with `isTTY` to decide the guided
   * checkpoint loop's interactive/non-interactive branch — either stream
   * being non-TTY forces the non-interactive path.
   */
  isOutputTTY?: boolean;
  /**
   * Injectable prompt function. Defaults to lib/readline.ts's readlineSync.
   * Used masked ({mask:true}) for the credentials password prompt, and
   * unmasked (no opts) for the checkpoint-code prompt — a checkpoint code
   * is not persisted secret material, but it must never reach argv.
   */
  readline?: (prompt: string, opts?: { mask?: boolean }) => Promise<string>;
  /** Injectable stdin reader for --password-stdin/--li-at-stdin. Defaults to lib/stdin.ts's defaultReadStdin. */
  readStdin?: () => Promise<string>;
  /**
   * Injectable single-line reader for an interactive-TTY --password-stdin/
   * --li-at-stdin read (a live terminal never sends EOF on Enter, so that
   * case must read one line, not to EOF). Defaults to
   * lib/readline.ts's readlineSync in its masked, no-echo raw-mode branch —
   * never the non-mask fallback, which does not suppress echo.
   */
  readSingleLine?: (cue: string) => Promise<string>;
  /** Injectable sleep for the interactive mobile-app-approval poll sub-loop. Defaults to a real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for the poll sub-loop's elapsed-time/timeout arithmetic. Defaults to Date.now. */
  now?: () => number;
  /**
   * Injectable browser opener for `account connect-link`'s auto-open.
   * Defaults to the real `open` package (dynamically imported so it is never
   * loaded — and never spawns a real browser — unless this default path is
   * actually reached). Tests inject a stub here instead of mocking the ESM
   * package directly.
   */
  open?: (url: string) => Promise<unknown>;
}

/**
 * Build the auth body for link/reconnect. Resolves the LinkedIn-account
 * secrets (password, li_at, li_a, proxy password) through the flag > stdin >
 * env > prompt > fail-fast tiers before assembling the body — the secret
 * reaches only this returned object, never a log or preview render.
 *
 * Under `--preview` (ctx.previewMode), interactive fallbacks (prompt,
 * fail-fast) are skipped entirely — a client-side render must never prompt
 * or exit — so a missing required secret simply resolves to `undefined` and
 * is omitted from the body.
 */
async function buildAuthBody(
  flags: AccountFlags,
  ctx: {
    out: OutputStreams;
    isTTY: boolean;
    readline: (prompt: string, opts?: { mask?: boolean }) => Promise<string>;
    readStdin: () => Promise<string>;
    readSingleLine: (cue: string) => Promise<string>;
    previewMode: boolean;
  },
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {};

  if (flags["auth-method"]) body["auth_method"] = flags["auth-method"];
  if (flags["user-agent"]) body["user_agent"] = flags["user-agent"];
  if (flags["recruiter-contract-id"]) body["recruiter_contract_id"] = flags["recruiter-contract-id"];

  // credentials object (auth-method === "credentials")
  if (flags["auth-method"] === "credentials") {
    const password = await resolveSecret({
      flagValue: flags.password,
      stdinRequested: flags["password-stdin"],
      envVar: "CURVIATE_LINKEDIN_PASSWORD",
      isTTY: ctx.isTTY,
      readStdin: ctx.readStdin,
      readSingleLine: ctx.readSingleLine,
      required: true,
      // The masked-prompt/fail-fast tiers (3/4) only engage once --email is
      // present (nothing meaningful to prompt toward yet otherwise) — and
      // never under --preview (a client-side render must not prompt or
      // exit).
      allowInteractive: !ctx.previewMode && Boolean(flags.email),
      // Tier-1b's own gate is preview-only, deliberately NOT email-gated: a
      // user who passed --password-stdin on a TTY gets the read regardless
      // of --email — an email-less body still fails downstream validation,
      // as expected, rather than the flag being silently ignored.
      allowInteractiveStdinRead: !ctx.previewMode,
      failMessage: "no password. Pass --password, --password-stdin, or set CURVIATE_LINKEDIN_PASSWORD",
      prompt: { isTTY: ctx.isTTY, readline: ctx.readline, promptText: "LinkedIn password: " },
      out: ctx.out,
    });

    if (flags.email || password !== undefined) {
      body["credentials"] = {
        ...(flags.email ? { email: flags.email } : {}),
        ...(password !== undefined ? { password } : {}),
      };
    }
  }

  // cookie object (auth-method === "cookie") — no interactive prompt, by design.
  if (flags["auth-method"] === "cookie") {
    const liAt = await resolveSecret({
      flagValue: flags["li-at"],
      stdinRequested: flags["li-at-stdin"],
      envVar: "CURVIATE_LINKEDIN_LI_AT",
      isTTY: ctx.isTTY,
      readStdin: ctx.readStdin,
      readSingleLine: ctx.readSingleLine,
      required: true,
      allowInteractive: !ctx.previewMode,
      failMessage: "no li_at. Pass --li-at, --li-at-stdin, or set CURVIATE_LINKEDIN_LI_AT",
      out: ctx.out,
    });
    const liA = await resolveSecret({
      flagValue: flags["li-a"],
      envVar: "CURVIATE_LINKEDIN_LI_A",
      out: ctx.out,
    });

    if (liAt !== undefined || liA !== undefined) {
      body["cookie"] = {
        ...(liAt !== undefined ? { li_at: liAt } : {}),
        ...(liA !== undefined ? { li_a: liA } : {}),
      };
    }
  }

  // location hints
  if (flags.country) body["country"] = flags.country;
  if (flags.ip) body["ip"] = flags.ip;

  // proxy (optional secret: flag > env > omitted, no prompt, no fail-fast)
  if (flags["proxy-host"]) {
    const proxyPassword = await resolveSecret({
      flagValue: flags["proxy-password"],
      envVar: "CURVIATE_PROXY_PASSWORD",
      out: ctx.out,
    });
    body["proxy"] = {
      protocol: flags["proxy-protocol"] ?? "http",
      host: flags["proxy-host"],
      port: flags["proxy-port"] ? parseInt(flags["proxy-port"], 10) : 80,
      ...(flags["proxy-username"] ? { username: flags["proxy-username"] } : {}),
      ...(proxyPassword !== undefined ? { password: proxyPassword } : {}),
    };
  }

  return body;
}

/**
 * The real browser opener, dynamically imported so the `open` package (and
 * any browser it might spawn) is only ever touched on this exact code path —
 * never during a test, which always injects its own `open` stub instead.
 */
async function defaultOpen(url: string): Promise<unknown> {
  const open = (await import("open")).default;
  return open(url);
}

function resolveCredentialIO(io: CredentialIO): {
  isTTY: boolean;
  isOutputTTY: boolean;
  readline: (prompt: string, opts?: { mask?: boolean }) => Promise<string>;
  readStdin: () => Promise<string>;
  readSingleLine: (cue: string) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  open: (url: string) => Promise<unknown>;
} {
  return {
    isTTY: io.isTTY ?? (process.stdin.isTTY ?? false),
    isOutputTTY: io.isOutputTTY ?? (process.stdout.isTTY ?? false),
    readline: io.readline ?? readlineSync,
    readStdin: io.readStdin ?? defaultReadStdin,
    // Always the masked, no-echo raw-mode branch — never a bare readlineSync
    // pass-through, which would default mask to false and echo the secret.
    // Prompt is deliberately EMPTY, not `cue`: credential-resolve.ts already
    // wrote STDIN_TTY_CUE to out.stderr before calling this reader, and
    // readlineSync itself writes its `prompt` argument to stderr too — the
    // cue text would otherwise print twice on a real terminal.
    readSingleLine: io.readSingleLine ?? (() => readlineSync("", { mask: true })),
    sleep: io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    now: io.now ?? (() => Date.now()),
    open: io.open ?? defaultOpen,
  };
}

// ---------------------------------------------------------------------------
// Guided checkpoint follow-through (link/reconnect 202 → resolve in-process)
// ---------------------------------------------------------------------------

/** The 202 checkpoint-required envelope (also the shape of a chained submit response). */
interface CheckpointEnvelope {
  object?: string;
  status?: string;
  account_id?: string;
  challenge_type?: string;
  expires_at?: string;
}

type ResolvedCredentialIO = ReturnType<typeof resolveCredentialIO>;

function printConnected(
  result: unknown,
  ctx: { out: OutputStreams; outOpts: ReturnType<typeof resolveOutputOpts>; successVerb: "linked" | "reconnected" },
): void {
  const r = result as { account_id?: string };
  ctx.out.stderr.write(`Account ${ctx.successVerb}: ${r.account_id ?? ""}\n`);
  renderSuccess(result, ctx.outOpts, ctx.out);
}

/** The wire body of a CHECKPOINT_INVALID_CODE error carries an extra (untyped-by-the-SDK) attempts_remaining field. */
function printInvalidCodeRetryHint(err: unknown, out: OutputStreams): void {
  const attemptsRemaining = (err as { attempts_remaining?: unknown }).attempts_remaining;
  const message =
    typeof attemptsRemaining === "number"
      ? `That code was not accepted. ${attemptsRemaining} attempt(s) remaining.`
      : "That code was not accepted. Please try again.";
  out.stderr.write(`${message}\n`);
}

type MobileApprovalOutcome =
  | { kind: "active"; result: unknown }
  | { kind: "terminal_failure"; status: "expired" | "failed" }
  | { kind: "timeout" };

/**
 * Wait for mobile-app-approval by polling on the same adaptive cadence as
 * the checkpoint poll wait loop, bounded by the checkpoint's expiry (or a
 * 10-minute default when the response carries no expiry hint).
 */
async function waitForMobileApproval(
  client: Curviate,
  accountId: string,
  expiresAt: string | undefined,
  ctx: {
    out: OutputStreams;
    outOpts: ReturnType<typeof resolveOutputOpts>;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
  },
): Promise<MobileApprovalOutcome> {
  const startedAt = ctx.now();
  const timeoutAt = expiresAt ? new Date(expiresAt).getTime() : startedAt + 10 * 60_000;

  await ctx.sleep(CHECKPOINT_POLL_FIRST_DELAY_MS);

  for (;;) {
    let result: unknown;
    try {
      result = await client.auth.pollCheckpoint(accountId);
    } catch (err) {
      return await handleError(err, ctx.outOpts, ctx.out);
    }
    const status = (result as { status?: string }).status;
    if (status === "active") return { kind: "active", result };
    if (status === "expired" || status === "failed") {
      return { kind: "terminal_failure", status };
    }
    const n = ctx.now();
    if (n >= timeoutAt) return { kind: "timeout" };
    await ctx.sleep(nextCheckpointPollDelayMs(n - startedAt));
  }
}

/**
 * Resolve a 202 checkpoint_required response in-process: print the
 * challenge copy and the resend hint, then either read/submit a code
 * (looping through 422 retries and chained challenges) or wait out a
 * codeless mobile-app-approval challenge.
 */
async function runInteractiveCheckpointLoop(
  client: Curviate,
  initial: CheckpointEnvelope,
  ctx: {
    out: OutputStreams;
    outOpts: ReturnType<typeof resolveOutputOpts>;
    readline: (prompt: string, opts?: { mask?: boolean }) => Promise<string>;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    successVerb: "linked" | "reconnected";
  },
): Promise<void> {
  const { CurviateError } = await import("@curviate/sdk");
  let current: CheckpointEnvelope = initial;

  for (;;) {
    const challengeType = current.challenge_type as ChallengeType;
    const accountId = current.account_id ?? "";

    printChallengeCopy(challengeType, ctx.out);
    printResendHintIfApplicable(challengeType, accountId, ctx.out);

    if (challengeType === "mobile_app_approval") {
      const outcome = await waitForMobileApproval(client, accountId, current.expires_at, {
        out: ctx.out,
        outOpts: ctx.outOpts,
        sleep: ctx.sleep,
        now: ctx.now,
      });
      if (outcome.kind === "active") {
        printConnected(outcome.result, { out: ctx.out, outOpts: ctx.outOpts, successVerb: ctx.successVerb });
        return;
      }
      if (outcome.kind === "terminal_failure") {
        ctx.out.stderr.write(
          `This checkpoint has ${outcome.status}. Run the connect command again to restart.\n`,
        );
        process.exit(9);
        return;
      }
      // outcome.kind === "timeout"
      ctx.out.stderr.write(
        `Still waiting for approval. Finish out-of-band: curviate account checkpoint poll ${accountId}\n`,
      );
      process.exit(AUTH_NEEDED);
      return;
    }

    // Code-based challenge: inner retry loop (422 re-prompts without
    // re-printing the challenge copy; a chained 202 breaks out to the
    // outer loop, which prints the new stage's copy).
    for (;;) {
      const code = await ctx.readline("Enter the code: ");
      try {
        const result = await client.auth.solveCheckpoint(accountId, { code });
        const r = result as CheckpointEnvelope;
        if (r.status === "checkpoint_required") {
          current = { ...r, account_id: r.account_id ?? accountId };
          break;
        }
        printConnected(result, { out: ctx.out, outOpts: ctx.outOpts, successVerb: ctx.successVerb });
        return;
      } catch (err) {
        if (err instanceof CurviateError && err.code === "CHECKPOINT_INVALID_CODE") {
          printInvalidCodeRetryHint(err, ctx.out);
          continue;
        }
        await handleError(err, ctx.outOpts, ctx.out);
      }
    }
  }
}

/**
 * Branch a link/reconnect response on the 202 checkpoint_required
 * discriminator: a completed (200/201) result renders as before; a
 * checkpoint resolves in-process on an interactive TTY session, or renders
 * the envelope and exits AUTH_NEEDED (12) otherwise.
 */
async function handleAccountConnectResult(
  client: Curviate,
  result: unknown,
  ctx: {
    out: OutputStreams;
    flags: AccountFlags;
    outOpts: ReturnType<typeof resolveOutputOpts>;
    io: ResolvedCredentialIO;
    successVerb: "linked" | "reconnected";
  },
): Promise<void> {
  const envelope = result as CheckpointEnvelope;

  if (envelope.status !== "checkpoint_required") {
    renderSuccess(result, ctx.outOpts, ctx.out);
    return;
  }

  const isInteractive = ctx.io.isTTY && ctx.io.isOutputTTY && !(ctx.flags["no-interactive"] ?? false);

  if (!isInteractive) {
    renderSuccess(result, ctx.outOpts, ctx.out);
    process.exit(AUTH_NEEDED);
    return;
  }

  await runInteractiveCheckpointLoop(client, envelope, {
    out: ctx.out,
    outOpts: ctx.outOpts,
    readline: ctx.io.readline,
    sleep: ctx.io.sleep,
    now: ctx.io.now,
    successVerb: ctx.successVerb,
  });
}

/**
 * Run `account link <body…>`.
 * Required: --seat-id, --auth-method.
 */
export async function runAccountLink(
  client: Curviate,
  flags: AccountFlags,
  out: OutputStreams,
  io: CredentialIO = {},
): Promise<void> {
  // Validate required fields
  if (!flags["seat-id"]) {
    out.stderr.write("error: --seat-id is required for account link.\n");
    process.exit(2);
  }
  if (!flags["auth-method"]) {
    out.stderr.write("error: --auth-method is required for account link (credentials | cookie).\n");
    process.exit(2);
  }

  checkCredentialConflicts(flags, out);

  // Cookie auth requires a User-Agent (the session cookie must be paired with
  // the browser UA it was minted under). Optional for credentials auth. Skipped
  // under --preview — a client-side render must never exit (mirrors the
  // credential-resolution fail-fast's own preview carve-out).
  if (!flags.preview && flags["auth-method"] === "cookie" && !flags["user-agent"]) {
    out.stderr.write("error: --user-agent is required when --auth-method=cookie.\n");
    process.exit(2);
  }

  const resolvedIo = resolveCredentialIO(io);
  const authBody = await buildAuthBody(flags, {
    out,
    isTTY: resolvedIo.isTTY,
    readline: resolvedIo.readline,
    readStdin: resolvedIo.readStdin,
    readSingleLine: resolvedIo.readSingleLine,
    previewMode: flags.preview ?? false,
  });

  const body: Record<string, unknown> = {
    seat_id: flags["seat-id"],
    ...authBody,
    // --account-id (0.15.0): present → re-authenticate this existing account in
    // place (reconnect); omit → connect a new account, with NO account_id key in
    // the body at all (not undefined, not empty).
    ...(flags["account-id"] ? { account_id: flags["account-id"] } : {}),
  };

  const outOpts = resolveOutputOpts(flags);

  if (flags.preview) {
    const preview = buildPreviewOutput({ method: "auth.intent", args: {}, body: maskCredentialSecretsForPreview(body) });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  let result: unknown;
  try {
    // Narrow cast: the body is assembled dynamically across several
    // conditionals (credentials-vs-cookie discriminated union, optional
    // proxy/location fields, async secret resolution) — required-field
    // validation (--seat-id/--auth-method) already runs above, and
    // auth.intent's own 400 covers anything this doesn't catch.
    result = await client.auth.intent(body as AuthIntentBody);
  } catch (err) {
    await handleError(err, outOpts, out);
    return;
  }

  await handleAccountConnectResult(client, result, {
    out,
    flags,
    outOpts,
    io: resolvedIo,
    successVerb: "linked",
  });
}

/** A connect session's poll response — `account_id` is null until `resolved`. */
interface ConnectSessionEnvelope {
  object?: string;
  session_id?: string;
  status?: string;
  account_id?: string | null;
  expires_at?: string;
}

/** Terminal outcome of the connect-session adaptive-cadence wait loop. */
type ConnectSessionWaitOutcome =
  | { kind: "resolved"; result: unknown }
  | { kind: "terminal_failure"; status: "expired" | "failed"; result: unknown }
  | { kind: "timeout"; result: unknown };

/**
 * The connect-session `--wait` adaptive-cadence loop — structurally the same
 * loop as the checkpoint poll wait loop above (same cadence constants, same
 * lazily-derived timeout bound off the first response's `expires_at`), driven
 * against `accounts.getConnectSession` instead of `accounts.pollCheckpoint`.
 * Shared by `connect-link`'s post-open wait and the standalone
 * `connect-session poll --wait` command — one loop, two callers.
 */
async function runConnectSessionWaitLoop(
  client: Curviate,
  sessionId: string,
  ctx: {
    out: OutputStreams;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    showTicker: boolean;
    timeoutOverrideMs?: number;
  },
): Promise<ConnectSessionWaitOutcome> {
  const startedAt = ctx.now();
  let timeoutAt: number | undefined =
    ctx.timeoutOverrideMs !== undefined ? startedAt + ctx.timeoutOverrideMs : undefined;

  await ctx.sleep(CHECKPOINT_POLL_FIRST_DELAY_MS);

  for (;;) {
    // The session_id is a STRING path arg — the SDK interpolates it into
    // /v1/accounts/connect-sessions/{session_id}. Passing an object here would
    // stringify to `[object Object]` and hit a bogus path.
    const result = await client.auth.getSession(sessionId);
    const r = result as ConnectSessionEnvelope;

    if (r.status === "resolved") return { kind: "resolved", result };
    if (r.status === "expired" || r.status === "failed") {
      return { kind: "terminal_failure", status: r.status, result };
    }

    if (timeoutAt === undefined) {
      const expiresAtMs = r.expires_at ? new Date(r.expires_at).getTime() : NaN;
      timeoutAt = Number.isNaN(expiresAtMs) ? startedAt + 10 * 60_000 : expiresAtMs;
    }

    const n = ctx.now();
    if (n >= timeoutAt) return { kind: "timeout", result };

    if (ctx.showTicker) {
      ctx.out.stderr.write(`\rWaiting for the account to connect… ${formatRemaining(timeoutAt - n)} remaining`);
    }

    await ctx.sleep(nextCheckpointPollDelayMs(n - startedAt));
  }
}

function printConnectSessionResolved(
  result: unknown,
  ctx: { out: OutputStreams; outOpts: ReturnType<typeof resolveOutputOpts> },
): void {
  const r = result as ConnectSessionEnvelope;
  ctx.out.stderr.write(`Account connected: ${r.account_id ?? ""}\n`);
  renderSuccess(result, ctx.outOpts, ctx.out);
}

/** Parse `--timeout <ms>` (the wait-loop bound, not the SDK request timeout). Exits 2 on a non-numeric value. */
function resolveWaitTimeoutOverrideMs(flags: AccountFlags, out: OutputStreams): number | undefined {
  if (flags.timeout === undefined) return undefined;
  const parsed = Number(flags.timeout);
  if (Number.isNaN(parsed)) {
    out.stderr.write("error: --timeout must be a number of milliseconds.\n");
    process.exit(2);
  }
  return parsed;
}

/**
 * Run `account connect-session poll --session <session_id> [--wait] [--timeout <ms>]`.
 *
 * Without `--wait` (default): a single poll, prints the body, exits 0
 * regardless of status — the JSON `status` field is for the caller to branch
 * on, not an error signal.
 * With `--wait`: the same adaptive-cadence loop and terminal exit codes as
 * `connect-link`'s own wait (0 resolved, 9 expired/failed, 12 AUTH_NEEDED on
 * a wait-window timeout) — the standalone counterpart for an agent that
 * minted the link with `--no-wait`/non-interactively and is now checking on
 * a session_id it already has.
 */
export async function runAccountConnectSessionPoll(
  client: Curviate,
  flags: AccountFlags,
  out: OutputStreams,
  io: CredentialIO = {},
): Promise<void> {
  if (!flags.session) {
    out.stderr.write("error: --session is required (the account's acc_… id from `account link` or a checkpoint response).\n");
    process.exit(2);
  }

  const sessionId = flags.session;
  const outOpts = resolveOutputOpts(flags);

  if (flags.preview) {
    const preview = buildPreviewOutput({ method: "auth.getSession", args: { session_id: sessionId }, body: {} });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  if (!flags.wait) {
    try {
      const result = await client.auth.getSession(sessionId);
      renderSuccess(result, outOpts, out);
    } catch (err) {
      await handleError(err, outOpts, out);
    }
    return;
  }

  const timeoutOverrideMs = resolveWaitTimeoutOverrideMs(flags, out);
  const resolvedIo = resolveCredentialIO(io);
  const showTicker = resolvedIo.isOutputTTY && !(flags.json ?? false);

  let outcome: ConnectSessionWaitOutcome;
  try {
    outcome = await runConnectSessionWaitLoop(client, sessionId, {
      out,
      sleep: resolvedIo.sleep,
      now: resolvedIo.now,
      showTicker,
      timeoutOverrideMs,
    });
  } catch (err) {
    await handleError(err, outOpts, out);
    return;
  }

  if (outcome.kind === "resolved") {
    printConnectSessionResolved(outcome.result, { out, outOpts });
    return;
  }
  if (outcome.kind === "terminal_failure") {
    renderSuccess(outcome.result, outOpts, out);
    out.stderr.write(
      `This connect session has ${outcome.status}. Start a new connect: curviate account link.\n`,
    );
    process.exit(9);
    return;
  }
  // outcome.kind === "timeout"
  renderSuccess(outcome.result, outOpts, out);
  out.stderr.write(
    `Still waiting for the account to connect. The wait window elapsed. Check again: curviate account connect-session poll --session ${flags.session} --wait\n`,
  );
  process.exit(AUTH_NEEDED);
}

/**
 * Run `account update <account_id> <body…>`.
 * Body: optional metadata (a flat string map that replaces the store
 * wholesale) and/or a custom proxy — set one with --proxy-*, or clear it with
 * --clear-proxy (sends proxy:null). The managed country/ip knobs are gone
 * (a managed location is chosen at connect time instead).
 */
export async function runAccountUpdate(
  client: Curviate,
  flags: AccountFlags,
  out: OutputStreams,
): Promise<void> {
  const accountId = flags["account-id"] ?? "";
  const body: Record<string, unknown> = {};

  if (flags.metadata !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(flags.metadata);
    } catch {
      out.stderr.write('error: --metadata must be a JSON object, e.g. --metadata \'{"team":"growth"}\'.\n');
      process.exit(2);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      out.stderr.write('error: --metadata must be a JSON object, e.g. --metadata \'{"team":"growth"}\'.\n');
      process.exit(2);
    }
    body["metadata"] = parsed;
  }

  // --clear-proxy (proxy:null) is mutually exclusive with setting a proxy.
  if (flags["clear-proxy"]) {
    if (flags["proxy-host"]) {
      out.stderr.write("error: --clear-proxy cannot be combined with --proxy-host (choose one).\n");
      process.exit(2);
    }
    body["proxy"] = null;
  }

  if (flags["proxy-host"]) {
    // Proxy password is optional: flag > env > omitted — no prompt, no fail-fast.
    const proxyPassword = await resolveSecret({
      flagValue: flags["proxy-password"],
      envVar: "CURVIATE_PROXY_PASSWORD",
      out,
    });
    body["proxy"] = {
      protocol: flags["proxy-protocol"] ?? "http",
      host: flags["proxy-host"],
      port: flags["proxy-port"] ? parseInt(flags["proxy-port"], 10) : 80,
      ...(flags["proxy-username"] ? { username: flags["proxy-username"] } : {}),
      ...(proxyPassword !== undefined ? { password: proxyPassword } : {}),
    };
  }

  const outOpts = resolveOutputOpts(flags);

  if (flags.preview) {
    const preview = buildPreviewOutput({
      method: "accounts.update",
      args: { accountId },
      body: maskCredentialSecretsForPreview(body),
    });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  try {
    const result = await client.accounts.update(accountId, body);
    renderSuccess(result, outOpts, out);
  } catch (err) {
    await handleError(err, outOpts, out);
  }
}

/** Run `account disconnect <account_id>`. */
export async function runAccountDisconnect(
  client: Curviate,
  flags: AccountFlags,
  out: OutputStreams,
): Promise<void> {
  const accountId = flags["account-id"] ?? "";
  const outOpts = resolveOutputOpts(flags);

  if (flags.preview) {
    const preview = buildPreviewOutput({
      method: "accounts.disconnect",
      args: { accountId },
      body: {},
    });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  try {
    const result = await client.accounts.disconnect(accountId);
    renderSuccess(result, outOpts, out);
  } catch (err) {
    await handleError(err, outOpts, out);
  }
}

/**
 * Run `account checkpoint solve <account_id> --code <code>`.
 * Path-addressed: account_id is the positional argument (interpolated into the
 * request path); the body is `{ code }`.
 * Required: --account-id (positional), --code.
 */
export async function runAccountCheckpointSolve(
  client: Curviate,
  flags: AccountFlags,
  out: OutputStreams,
): Promise<void> {
  if (!flags["account-id"]) {
    out.stderr.write("error: account_id is required (the provisional account_id from the 202 response).\n");
    process.exit(2);
  }
  if (!flags.code) {
    out.stderr.write("error: --code is required (the OTP / 2FA code).\n");
    process.exit(2);
  }

  const accountId = flags["account-id"] ?? "";
  // flags.code is narrowed to `string` by the `!flags.code` exit(2) above
  // (process.exit returns `never`), so this literal structurally satisfies
  // AuthSolveCheckpointBody without a cast.
  const body = { code: flags.code };

  const outOpts = resolveOutputOpts(flags);

  if (flags.preview) {
    const preview = buildPreviewOutput({
      method: "auth.solveCheckpoint",
      args: { accountId },
      body,
    });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  let chained = false;
  try {
    const result = await client.auth.solveCheckpoint(accountId, body);
    const r = result as CheckpointEnvelope;
    renderSuccess(result, outOpts, out);
    chained = r.status === "checkpoint_required";
  } catch (err) {
    await handleError(err, outOpts, out);
    return;
  }

  // A chained 202 (another challenge required) is a success response, not a
  // CurviateError — the exit call sits outside the try/catch above so it is
  // never miscaught and misrouted through handleError. Short-circuits the
  // one-shot command with AUTH_NEEDED (12): still resolvable, needs a further
  // `checkpoint solve` call for the new challenge_type.
  if (chained) {
    process.exit(AUTH_NEEDED);
  }
}

/**
 * Run `account checkpoint request <account_id>`.
 * Path-addressed: account_id is the positional argument. No --code — a
 * re-request has nothing to submit.
 *
 * Exit 0 on any 200 regardless of the `resent` boolean: a `false` value is an
 * honest answer ("this challenge type has nothing to re-send, or the
 * platform declined"), not a command failure — the caller reads `resent`
 * from the response to branch. Errors (404 no pending checkpoint, 409
 * expired, 501 unsupported) route through the standard exit-code table via
 * `handleError`, unchanged from `solve`/`poll`.
 */
export async function runAccountCheckpointRequest(
  client: Curviate,
  flags: AccountFlags,
  out: OutputStreams,
): Promise<void> {
  if (!flags["account-id"]) {
    out.stderr.write("error: account_id is required (the provisional account_id from the 202 response).\n");
    process.exit(2);
  }

  const accountId = flags["account-id"] ?? "";
  const outOpts = resolveOutputOpts(flags);

  if (flags.preview) {
    const preview = buildPreviewOutput({
      method: "auth.requestCheckpoint",
      args: { accountId },
      body: {},
    });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  try {
    const result = await client.auth.requestCheckpoint(accountId);
    renderSuccess(result, outOpts, out);
  } catch (err) {
    await handleError(err, outOpts, out);
  }
}

/** Terminal outcome of the `checkpoint poll --wait` adaptive-cadence loop. */
type PollWaitOutcome =
  | { kind: "active"; result: unknown }
  | { kind: "terminal_failure"; status: "expired" | "failed"; result: unknown }
  | { kind: "timeout"; result: unknown };

/** "m:ss" countdown for the refreshing wait status line. */
function formatRemaining(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * The `checkpoint poll --wait` adaptive-cadence loop: the same cadence
 * (`lib/checkpoint-cadence.ts`) as the interactive mobile-approval sub-loop,
 * against the standalone poll body rather than a just-received 202 envelope.
 * The wall-clock bound is `timeoutOverrideMs` (the `--timeout` flag) when
 * given; otherwise it is read lazily off the first `pending` response's
 * `expires_at` (falling back to a 10-minute default if that response somehow
 * carries none), since a bare `checkpoint poll --wait` has no envelope of its
 * own to read an expiry from before the first poll.
 */
async function runCheckpointPollWaitLoop(
  client: Curviate,
  accountId: string,
  ctx: {
    out: OutputStreams;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    showTicker: boolean;
    timeoutOverrideMs?: number;
  },
): Promise<PollWaitOutcome> {
  const startedAt = ctx.now();
  let timeoutAt: number | undefined =
    ctx.timeoutOverrideMs !== undefined ? startedAt + ctx.timeoutOverrideMs : undefined;

  await ctx.sleep(CHECKPOINT_POLL_FIRST_DELAY_MS);

  for (;;) {
    const result = await client.auth.pollCheckpoint(accountId);
    const r = result as { status?: string; expires_at?: string };

    if (r.status === "active") return { kind: "active", result };
    if (r.status === "expired" || r.status === "failed") {
      return { kind: "terminal_failure", status: r.status, result };
    }

    if (timeoutAt === undefined) {
      const expiresAtMs = r.expires_at ? new Date(r.expires_at).getTime() : NaN;
      timeoutAt = Number.isNaN(expiresAtMs) ? startedAt + 10 * 60_000 : expiresAtMs;
    }

    const n = ctx.now();
    if (n >= timeoutAt) return { kind: "timeout", result };

    if (ctx.showTicker) {
      ctx.out.stderr.write(`\rWaiting for approval… ${formatRemaining(timeoutAt - n)} remaining`);
    }

    await ctx.sleep(nextCheckpointPollDelayMs(n - startedAt));
  }
}

/**
 * Run `account checkpoint poll <account_id> [--wait] [--timeout <ms>]`.
 * Path-addressed: account_id is the positional argument.
 *
 * Without `--wait` (default): a single poll, unchanged (back-compat).
 * With `--wait`: the adaptive-cadence loop above, until `active` (exit 0),
 * `expired`/`failed` (exit 9), or the wait window elapses while still
 * `pending` (exit AUTH_NEEDED/12 — still resolvable, not a failure).
 */
export async function runAccountCheckpointPoll(
  client: Curviate,
  flags: AccountFlags,
  out: OutputStreams,
  io: CredentialIO = {},
): Promise<void> {
  if (!flags["account-id"]) {
    out.stderr.write("error: account_id is required (the provisional account_id from the 202 response).\n");
    process.exit(2);
  }

  const accountId = flags["account-id"] ?? "";
  const outOpts = resolveOutputOpts(flags);

  if (flags.preview) {
    const preview = buildPreviewOutput({
      method: "auth.pollCheckpoint",
      args: { accountId },
      body: {},
    });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  if (!flags.wait) {
    try {
      const result = await client.auth.pollCheckpoint(accountId);
      renderSuccess(result, outOpts, out);
    } catch (err) {
      await handleError(err, outOpts, out);
    }
    return;
  }

  let timeoutOverrideMs: number | undefined;
  if (flags.timeout !== undefined) {
    const parsed = Number(flags.timeout);
    if (Number.isNaN(parsed)) {
      out.stderr.write("error: --timeout must be a number of milliseconds.\n");
      process.exit(2);
    }
    timeoutOverrideMs = parsed;
  }

  const resolvedIo = resolveCredentialIO(io);
  // "TTY + not --json" per the flag's own contract — the raw --json flag,
  // not resolveOutputOpts's derived json (which also folds in the real
  // process.stdout.isTTY and would make the ticker untestable: this
  // function's own isOutputTTY seam is what tests control).
  const showTicker = resolvedIo.isOutputTTY && !(flags.json ?? false);

  // Poll only ever addresses a mobile_app_approval checkpoint (a code-based
  // checkpoint 422s here — use `checkpoint solve` instead), so the resend
  // hint's per-type gating always resolves to "resendable" — printed once,
  // up front, not per attempt. Stderr diagnostic, not the stdout data
  // payload the "silent until terminal" discipline is about (mirrors
  // renderError's own one-liner-to-stderr-regardless-of-json convention).
  printResendHintIfApplicable("mobile_app_approval", accountId, out);

  let outcome: PollWaitOutcome;
  try {
    outcome = await runCheckpointPollWaitLoop(client, accountId, {
      out,
      sleep: resolvedIo.sleep,
      now: resolvedIo.now,
      showTicker,
      timeoutOverrideMs,
    });
  } catch (err) {
    await handleError(err, outOpts, out);
    return;
  }

  if (outcome.kind === "active") {
    printConnected(outcome.result, { out, outOpts, successVerb: "linked" });
    return;
  }
  if (outcome.kind === "terminal_failure") {
    renderSuccess(outcome.result, outOpts, out);
    out.stderr.write(`This checkpoint has ${outcome.status}. Start over: curviate account link or curviate account reconnect.\n`);
    process.exit(9);
    return;
  }
  // outcome.kind === "timeout"
  renderSuccess(outcome.result, outOpts, out);
  out.stderr.write(
    `Still waiting for approval. The wait window elapsed. Check again: curviate account checkpoint poll ${accountId} --wait\n`,
  );
  process.exit(AUTH_NEEDED);
}

// ---------------------------------------------------------------------------
// Citty command definitions
// ---------------------------------------------------------------------------

const accountListCommand = defineCommand({
  meta: { name: "list", description: "List connected LinkedIn accounts." },
  args: { ...GLOBAL_FLAGS },
  async run({ args }) {
    const flags = args as AccountFlags;
    const cfg = await resolveEffectiveConfig({
      apiKey: flags["api-key"],
      baseUrl: flags["base-url"],
      timeout: flags.timeout,
      profile: flags.profile,
    });
    if (!cfg.apiKey) {
      process.stderr.write("error: no API key, run `curviate login` or pass --api-key.\n");
      process.exit(3);
    }
    const client = createClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, timeout: cfg.timeout });
    const out = buildOutputStreams();
    await runAccountList(client, flags, out);
  },
});

const accountGetCommand = defineCommand({
  meta: { name: "get", description: "Get a connected LinkedIn account." },
  args: {
    // Single-object read: READ_SINGLE_FLAGS omits pagination flags, keeps --fields
    ...READ_SINGLE_FLAGS,
    "account-id": { type: "positional", description: "Account id (acc_…)." },
  },
  async run({ args }) {
    const flags = args as AccountFlags;
    const cfg = await resolveEffectiveConfig({
      apiKey: flags["api-key"],
      baseUrl: flags["base-url"],
      timeout: flags.timeout,
      profile: flags.profile,
    });
    if (!cfg.apiKey) {
      process.stderr.write("error: no API key, run `curviate login` or pass --api-key.\n");
      process.exit(3);
    }
    const client = createClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, timeout: cfg.timeout });
    const out = buildOutputStreams();
    await runAccountGet(client, flags, out);
  },
});

const accountLinkCommand = defineCommand({
  meta: {
    name: "link",
    description:
      "Connect a LinkedIn account to an empty seat. " +
      "If LinkedIn requires verification you'll be prompted for the code interactively; in a non-interactive shell the command exits 12 and you finish with `curviate account checkpoint solve <account_id> --code`.",
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    "seat-id": { type: "string", description: "Empty seat to bind the account to.", required: true },
    "auth-method": { type: "string", description: "Authentication method: credentials | cookie.", required: true },
    email: { type: "string", description: "LinkedIn email (credentials method)." },
    password: { type: "string", description: `LinkedIn password (credentials method). ${PW_WARNING("--password-stdin", "CURVIATE_LINKEDIN_PASSWORD")}` },
    "password-stdin": { type: "boolean", description: "Read the LinkedIn password from stdin (one line, trimmed).", default: false },
    "li-at": { type: "string", description: `LinkedIn session cookie li_at (cookie method). ${PW_WARNING("--li-at-stdin", "CURVIATE_LINKEDIN_LI_AT")}` },
    "li-at-stdin": { type: "boolean", description: "Read the li_at session cookie from stdin (one line, trimmed).", default: false },
    "li-a": { type: "string", description: `Optional premium session cookie li_a (cookie method). ${OPTIONAL_SECRET_WARNING("CURVIATE_LINKEDIN_LI_A")}` },
    country: { type: "string", description: "Proxy location hint (ISO 3166-1 alpha-2)." },
    ip: { type: "string", description: "IP to infer the managed proxy location." },
    "proxy-protocol": { type: "string", description: "Proxy protocol: http | https | socks5." },
    "proxy-host": { type: "string", description: "Proxy host or IP." },
    "proxy-port": { type: "string", description: "Proxy port." },
    "proxy-username": { type: "string", description: "Proxy auth username." },
    "proxy-password": { type: "string", description: `Proxy auth password. ${OPTIONAL_SECRET_WARNING("CURVIATE_PROXY_PASSWORD")}` },
    "user-agent": { type: "string", description: "Browser User-Agent to pin for this account." },
    "recruiter-contract-id": { type: "string", description: "Recruiter contract to bind to (Recruiter tier only)." },
    "account-id": { type: "string", description: "Existing account id (acc_…) to re-authenticate IN PLACE. Passing it makes this an in-place reconnect of that account. Omit to connect a NEW account into --seat-id." },
    "no-interactive": {
      type: "boolean",
      description: "Never prompt for a checkpoint code. On a checkpoint, always render the envelope and exit 12, even on a TTY.",
      default: false,
    },
  },
  async run({ args }) {
    const flags = args as AccountFlags;
    const cfg = await resolveEffectiveConfig({
      apiKey: flags["api-key"],
      baseUrl: flags["base-url"],
      timeout: flags.timeout,
      profile: flags.profile,
    });
    if (!cfg.apiKey) {
      process.stderr.write("error: no API key, run `curviate login` or pass --api-key.\n");
      process.exit(3);
    }
    const client = createClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, timeout: cfg.timeout });
    const out = buildOutputStreams();
    await runAccountLink(client, flags, out);
  },
});

const accountConnectSessionPollCommand = defineCommand({
  meta: {
    name: "poll",
    description:
      "Poll the status of an in-progress connect (auth intent) for completion. Without --wait: a single " +
      "poll. The JSON `status` field (pending | resolved | expired | failed) tells you what to do next. " +
      "With --wait: block on the same adaptive cadence as `account link` until a terminal state.",
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    session: {
      type: "string",
      description: "The account's acc_… id, returned by `account link` or a checkpoint response.",
      required: true,
    },
    wait: {
      type: "boolean",
      description: "Poll on an adaptive cadence (1000ms, then 1500ms for 30s, then 3000ms) until a terminal state, instead of a single poll.",
      default: false,
    },
    // Override WRITE_SINGLE_FLAGS.timeout: on this command --timeout is the
    // --wait loop's own wall-clock bound in MILLISECONDS (requires --wait) —
    // NOT the SDK request timeout. Default: the time remaining to the
    // session's own expiry.
    timeout: {
      type: "string",
      description: "Wait-loop timeout in milliseconds (requires --wait; default: time remaining to the session's expiry). Note the unit: this is milliseconds.",
    },
  },
  async run({ args }) {
    const flags = args as AccountFlags;
    // --timeout here means the --wait bound (ms), not the SDK request
    // timeout — resolve config without it (same fix as `account checkpoint
    // poll` / `account connect-link`).
    const cfg = await resolveEffectiveConfig({
      apiKey: flags["api-key"],
      baseUrl: flags["base-url"],
      profile: flags.profile,
    });
    if (!cfg.apiKey) {
      process.stderr.write("error: no API key, run `curviate login` or pass --api-key.\n");
      process.exit(3);
    }
    const client = createClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, timeout: cfg.timeout });
    const out = buildOutputStreams();
    await runAccountConnectSessionPoll(client, flags, out);
  },
});

const accountConnectSessionCommand = defineCommand({
  meta: { name: "connect-session", description: "In-progress connect operations (poll for completion)." },
  subCommands: {
    poll: accountConnectSessionPollCommand,
  },
  async run() {
    process.stderr.write("Usage: curviate account connect-session poll --session <session_id>\n");
  },
});

const accountUpdateCommand = defineCommand({
  meta: { name: "update", description: "Update an account's metadata and/or custom-proxy configuration." },
  args: {
    ...WRITE_SINGLE_FLAGS,
    "account-id": { type: "positional", description: "Account id (acc_…)." },
    metadata: { type: "string", description: `Custom metadata as a JSON object (flat string→string map). Replaces the store wholesale. Example: '{"team":"growth"}'.` },
    "clear-proxy": { type: "boolean", description: "Clear the custom proxy (revert to automatic proxy protection). Mutually exclusive with --proxy-host.", default: false },
    "proxy-protocol": { type: "string", description: "Proxy protocol: http | https | socks5." },
    "proxy-host": { type: "string", description: "Proxy host or IP." },
    "proxy-port": { type: "string", description: "Proxy port." },
    "proxy-username": { type: "string", description: "Proxy auth username." },
    "proxy-password": { type: "string", description: `Proxy auth password. ${OPTIONAL_SECRET_WARNING("CURVIATE_PROXY_PASSWORD")}` },
  },
  async run({ args }) {
    const flags = args as AccountFlags;
    const cfg = await resolveEffectiveConfig({
      apiKey: flags["api-key"],
      baseUrl: flags["base-url"],
      timeout: flags.timeout,
      profile: flags.profile,
    });
    if (!cfg.apiKey) {
      process.stderr.write("error: no API key, run `curviate login` or pass --api-key.\n");
      process.exit(3);
    }
    const client = createClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, timeout: cfg.timeout });
    const out = buildOutputStreams();
    await runAccountUpdate(client, flags, out);
  },
});

const accountDisconnectCommand = defineCommand({
  meta: { name: "disconnect", description: "Hard-disconnect a LinkedIn account and release its seat." },
  args: {
    ...WRITE_SINGLE_FLAGS,
    "account-id": { type: "positional", description: "Account id (acc_…)." },
  },
  async run({ args }) {
    const flags = args as AccountFlags;
    const cfg = await resolveEffectiveConfig({
      apiKey: flags["api-key"],
      baseUrl: flags["base-url"],
      timeout: flags.timeout,
      profile: flags.profile,
    });
    if (!cfg.apiKey) {
      process.stderr.write("error: no API key, run `curviate login` or pass --api-key.\n");
      process.exit(3);
    }
    const client = createClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, timeout: cfg.timeout });
    const out = buildOutputStreams();
    await runAccountDisconnect(client, flags, out);
  },
});

const accountCheckpointSolveCommand = defineCommand({
  meta: { name: "solve", description: "Solve a checkpoint challenge with an OTP / 2FA code." },
  args: {
    ...WRITE_SINGLE_FLAGS,
    "account-id": {
      type: "positional",
      description: "The provisional account_id (acc_…) from the 202 checkpoint_required response.",
    },
    code: {
      type: "string",
      description: "The OTP / 2FA verification code.",
      required: true,
    },
  },
  async run({ args }) {
    const flags = args as AccountFlags;
    const cfg = await resolveEffectiveConfig({
      apiKey: flags["api-key"],
      baseUrl: flags["base-url"],
      timeout: flags.timeout,
      profile: flags.profile,
    });
    if (!cfg.apiKey) {
      process.stderr.write("error: no API key, run `curviate login` or pass --api-key.\n");
      process.exit(3);
    }
    const client = createClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, timeout: cfg.timeout });
    const out = buildOutputStreams();
    await runAccountCheckpointSolve(client, flags, out);
  },
});

const accountCheckpointPollCommand = defineCommand({
  meta: {
    name: "poll",
    description:
      "Poll for mobile-app approval of a pending checkpoint challenge. " +
      "With --wait, blocks on an adaptive cadence until a terminal state (or --timeout elapses) instead of a single poll.",
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    "account-id": {
      type: "positional",
      description: "The provisional account_id (acc_…) from the 202 checkpoint_required response.",
    },
    wait: {
      type: "boolean",
      description: "Poll on an adaptive cadence (1000ms, then 1500ms for 30s, then 3000ms) until a terminal state, instead of a single poll.",
      default: false,
    },
    // Override WRITE_SINGLE_FLAGS.timeout: on this command --timeout is the
    // --wait loop's own wall-clock bound in MILLISECONDS (requires --wait) —
    // NOT the SDK request timeout, and NOT seconds like `inbox sync-chat
    // --timeout`. Default: the time remaining to the checkpoint's own expiry.
    timeout: {
      type: "string",
      description: "Wait-loop timeout in milliseconds (requires --wait; default: time remaining to the checkpoint's expiry). Note the unit: this is milliseconds; `inbox sync-chat --timeout` is seconds.",
    },
  },
  async run({ args }) {
    const flags = args as AccountFlags;
    // --timeout here means the --wait bound (ms), not the SDK request
    // timeout — resolve config without it so the SDK client keeps its
    // default request timeout (mirrors `inbox sync-chat`'s own fix for the
    // identical flag-name collision).
    const cfg = await resolveEffectiveConfig({
      apiKey: flags["api-key"],
      baseUrl: flags["base-url"],
      profile: flags.profile,
    });
    if (!cfg.apiKey) {
      process.stderr.write("error: no API key, run `curviate login` or pass --api-key.\n");
      process.exit(3);
    }
    const client = createClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, timeout: cfg.timeout });
    const out = buildOutputStreams();
    await runAccountCheckpointPoll(client, flags, out);
  },
});

const accountCheckpointRequestCommand = defineCommand({
  meta: {
    name: "request",
    description:
      "Re-request the challenge notification for a pending checkpoint (e.g. re-send an OTP email, SMS " +
      "code, or mobile-app approval push). Not every challenge type supports it; an authenticator- " +
      "app code has nothing to re-send. The response's `resent` boolean tells you honestly whether a new " +
      "notification actually went out; the command still exits 0 either way.",
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    "account-id": {
      type: "positional",
      description: "The provisional account_id (acc_…) from the 202 checkpoint_required response.",
    },
  },
  async run({ args }) {
    const flags = args as AccountFlags;
    const cfg = await resolveEffectiveConfig({
      apiKey: flags["api-key"],
      baseUrl: flags["base-url"],
      timeout: flags.timeout,
      profile: flags.profile,
    });
    if (!cfg.apiKey) {
      process.stderr.write("error: no API key, run `curviate login` or pass --api-key.\n");
      process.exit(3);
    }
    const client = createClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, timeout: cfg.timeout });
    const out = buildOutputStreams();
    await runAccountCheckpointRequest(client, flags, out);
  },
});

const accountCheckpointCommand = defineCommand({
  meta: {
    name: "checkpoint",
    description: "Checkpoint challenge operations (solve with an OTP, poll mobile-app approval, or re-request the challenge notification).",
  },
  subCommands: {
    solve: accountCheckpointSolveCommand,
    poll: accountCheckpointPollCommand,
    request: accountCheckpointRequestCommand,
  },
  async run() {
    process.stderr.write("Usage: curviate account checkpoint solve <account_id> --code <code> | poll <account_id> | request <account_id>\n");
  },
});

export const accountCommand = defineCommand({
  meta: { name: "account", description: "LinkedIn account connection management." },
  subCommands: {
    list: accountListCommand,
    get: accountGetCommand,
    link: accountLinkCommand,
    "connect-session": accountConnectSessionCommand,
    update: accountUpdateCommand,
    disconnect: accountDisconnectCommand,
    checkpoint: accountCheckpointCommand,
  },
  async run() {
    process.stderr.write(
      "Usage: curviate account <subcommand>\n" +
      "  list | get | link | connect-session poll | update | disconnect | checkpoint\n",
    );
  },
});
