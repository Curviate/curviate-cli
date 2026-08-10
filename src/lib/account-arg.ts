/**
 * `--account` resolution: the one place the CLI turns a caller-supplied
 * account selector into the id it interpolates into a request path.
 *
 * ## Why validation and name resolution are one function
 *
 * They are the two halves of a single decision, and splitting them is what
 * makes the feature dangerous. `--account` selects **which live LinkedIn
 * persona an action runs as**. A value is therefore either:
 *
 *   1. not usable as a path segment at all      -> usage error, nothing sent
 *   2. already a well-formed account id         -> used as-is, no lookup
 *   3. a name resolving to exactly one account  -> that account's id
 *   4. a name resolving to several accounts     -> ambiguity error, nothing sent
 *   5. a name resolving to none                 -> not-found error, nothing sent
 *
 * Nothing unresolved ever reaches a URL. Case 4 is the reason the guard cannot
 * be added later: resolving names *without* it would silently pick a
 * candidate, and a wrong pick lands a reputation-affecting write (a message, an
 * invitation) on the wrong live persona. That is unrecoverable in a way a 404
 * is not, so the resolver and its ambiguity guard ship together or not at all.
 *
 * ## The two error codes are deliberately distinct
 *
 * "no such account" and "say which one" call for different caller behaviour,
 * so they carry different codes and different exit statuses. Folding either
 * into the API's own `ACCOUNT_NOT_FOUND` would erase that difference.
 *
 * ## Cost
 *
 * An id-shaped value costs nothing: it is used directly and no lookup is
 * issued, so every existing scripted invocation runs exactly as many requests
 * as before. Only a name pays, and it pays for the whole `accounts.list` walk:
 * one read for a tenant that fits on a page, and up to `MAX_LOOKUP_PAGES`
 * cursor reads for one that does not, because the ambiguity guard below is only
 * as good as the set it decides against. The walk is memoized per client, so a
 * command that asks twice still resolves once.
 */

import type { Curviate, CurviateError } from "@curviate/sdk";
import {
  pathSegmentErrorMessage,
  pathSegmentViolation,
  redirectingViolation,
} from "./path-safety.js";
import { assertNoStdinPlaceholder } from "./stdin.js";
import { getExitCode } from "./exit-codes.js";

/**
 * A Curviate account id. Deliberately loose after the `acc_` prefix: the id is
 * the platform's to shape, and this test only has to be tight enough to
 * separate "the caller passed an id" from "the caller passed a name". A value
 * that looks like an id is never resolved, so a shape this pattern does not
 * recognize costs one lookup, not a failure.
 */
export const ACCOUNT_ID_RE = /^acc_[A-Za-z0-9_-]+$/;

/** The output surface the resolver writes diagnostics to. */
export interface AccountArgStreams {
  stdout: { write: (s: string) => void };
  stderr: { write: (s: string) => void };
}

/**
 * The parts of a command's flags this resolver reads.
 *
 * The whole flags object is passed rather than `flags.account` alone because
 * resolution is no longer a pure function of the selector: whether a lookup may
 * be issued at all depends on `--preview`. Taking the object means every call
 * site carries that answer by construction, instead of 131 handlers each having
 * to remember to forward it.
 */
export interface AccountSelectorFlags {
  /** The merged account value (flag > env > profile). */
  account?: string | undefined;
  /** Set when the caller asked for a client-side render instead of a call. */
  preview?: boolean | undefined;
}

/** The fields of a connected account this resolver matches on. */
interface ConnectedAccount {
  accountId: string;
  fullName: string | null;
}

/**
 * The account set a match is decided against, and whether it is all of them.
 *
 * `complete` is what makes the ambiguity guard trustworthy. A guard that
 * reports "exactly one match" over a set that silently lost members is not a
 * guard at all: losing the duplicate looks identical to there never having been
 * one, and the caller gets a confident answer that is wrong in the one
 * direction that matters (acting as an account they did not name). So the walk
 * reports how it ended, and a walk that ended at the page cap rather than at
 * the end of the cursor refuses to answer.
 */
interface AccountSet {
  accounts: ConnectedAccount[];
  /** False when the walk stopped at `MAX_LOOKUP_PAGES` with a cursor still open. */
  complete: boolean;
}

/**
 * One `accounts.list` result per client, so several `requireAccount` calls in
 * a single command run cannot multiply into several lookups.
 */
const listCache = new WeakMap<object, Promise<AccountSet>>();

/**
 * Cursor pages to walk before giving up, 250 accounts each.
 *
 * A bound is needed (a broken cursor that never clears would otherwise page
 * forever), but the bound is not a silent one: hitting it makes the result
 * incomplete, and an incomplete result refuses to resolve rather than matching
 * against a partial list.
 */
const MAX_LOOKUP_PAGES = 10;

function toConnectedAccount(item: unknown): ConnectedAccount | null {
  if (item === null || typeof item !== "object") return null;
  const row = item as Record<string, unknown>;
  const accountId = row["account_id"];
  if (typeof accountId !== "string" || accountId.length === 0) return null;
  const fullName = row["full_name"];
  return {
    accountId,
    fullName: typeof fullName === "string" && fullName.length > 0 ? fullName : null,
  };
}

/** Read every connected account, following cursors, memoized per client. */
function listConnectedAccounts(client: Curviate): Promise<AccountSet> {
  const cached = listCache.get(client);
  if (cached) return cached;

  const pending = (async (): Promise<AccountSet> => {
    const accounts: ConnectedAccount[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LOOKUP_PAGES; page++) {
      const params: Record<string, unknown> = { limit: 250 };
      if (cursor) params["cursor"] = cursor;
      const result = (await client.accounts.list(
        params as Parameters<typeof client.accounts.list>[0],
      )) as { items?: unknown[]; cursor?: string | null };
      for (const item of result.items ?? []) {
        const account = toConnectedAccount(item);
        if (account) accounts.push(account);
      }
      // The cursor running out is the only ending that means "that was all of
      // them". Reaching the last page with one still open means the opposite,
      // and the two must not be reported the same way.
      if (!result.cursor) return { accounts, complete: true };
      cursor = result.cursor;
    }
    return { accounts, complete: false };
  })();

  listCache.set(client, pending);
  return pending;
}

/** `"Ralf Fischer" (acc_01RALF)`, the form both error messages use. */
function describeAccount(account: ConnectedAccount): string {
  return account.fullName === null
    ? account.accountId
    : `"${account.fullName}" (${account.accountId})`;
}

function describeAll(accounts: ConnectedAccount[]): string {
  return accounts.map(describeAccount).join(", ");
}

/**
 * The accounts `selector` could mean, and how it matched.
 *
 * An exact name match wins outright over a prefix match, so "Ralf" resolves
 * cleanly when one account is named exactly "Ralf" even though it also
 * prefixes "Ralf Fischer". Without that precedence an exact name would be
 * unusable the moment a longer name started with it.
 */
function matchAccounts(
  accounts: ConnectedAccount[],
  selector: string,
): ConnectedAccount[] {
  const needle = selector.toLowerCase();

  const byId = accounts.filter((a) => a.accountId === selector);
  if (byId.length > 0) return byId;

  const exactName = accounts.filter((a) => a.fullName?.toLowerCase() === needle);
  if (exactName.length > 0) return exactName;

  return accounts.filter((a) => a.fullName?.toLowerCase().startsWith(needle));
}

/**
 * Resolve the effective `--account` value to an account id, or exit.
 *
 * @param client the SDK client, used only when a lookup is actually needed
 * @param flags  the command's flags; `account` is the merged value
 *               (flag > env > profile) and `preview` decides whether a lookup
 *               may be issued at all
 */
export async function requireAccount(
  client: Curviate,
  flags: AccountSelectorFlags,
  out: AccountArgStreams,
): Promise<string> {
  const account = flags.account;
  if (!account) {
    out.stderr.write(
      "error: --account is required for this command. Set it via --account, CURVIATE_ACCOUNT, or `curviate config set-account`.\n",
    );
    process.exit(2);
  }

  // Surrounding whitespace is a copy/paste artifact, not intent.
  const selector = account.trim();

  // The stdin placeholder, first, because this resolver is the one place a
  // caller-supplied value can cause a request to be SENT without ever appearing
  // in it. The egress backstop in `client.ts` scans the outbound URL, headers
  // and body, so it catches a placeholder that is interpolated into a path; it
  // cannot catch one that is merely *looked up*, because the lookup carries the
  // caller's bearer token to `/v1/accounts` with the placeholder nowhere in the
  // request. Without this line, an unsubstituted placeholder arriving through
  // CURVIATE_ACCOUNT is neither id-shaped nor redirecting, falls through to the
  // name lookup, and transmits, breaking the backstop's whole guarantee that
  // nothing is sent.
  assertNoStdinPlaceholder("the --account value", [selector]);

  // Before anything else, and before any request can be built: a value that
  // could move the request to a different endpoint is rejected outright,
  // whichever of the three sources it arrived from. Nothing is sent, not even
  // the resolution lookup, because a value shaped like this is not a name
  // anybody holds.
  const redirecting = redirectingViolation(selector);
  if (redirecting !== null) {
    out.stderr.write(pathSegmentErrorMessage("--account", selector, redirecting));
    process.exit(2);
  }

  if (ACCOUNT_ID_RE.test(selector)) return selector;

  // `--preview` is published as "Render the request that would be sent without
  // calling the API", so the lookup is not available here: a preview is reached
  // for precisely when the caller is not ready to touch the wire, and an agent
  // that previews before every write would otherwise double its request count
  // and stop working offline. The selector is echoed as supplied, which is byte
  // for byte what 0.22.0 rendered, and the note keeps that from being read as
  // the literal path the real request would carry.
  //
  // Safety is unaffected: the redirecting check above has already run, so a
  // value that could move a request is refused under `--preview` too, and the
  // worst a previewed selector can do if a handler ignored `--preview` is
  // produce the same 404 that 0.22.0 produced.
  if (flags.preview === true) {
    out.stderr.write(
      `note: --preview does not call the API, so --account "${selector}" is shown as you typed it. ` +
        `A real run resolves it to an account id first, and fails if it matches no connected account or more than one.\n`,
    );
    return selector;
  }

  let listed: AccountSet;
  try {
    listed = await listConnectedAccounts(client);
  } catch (err: unknown) {
    const { CurviateError } = await import("@curviate/sdk");
    if (err instanceof CurviateError) {
      const e = err as CurviateError;
      out.stderr.write(
        `error: [${e.code}] could not look up connected accounts to resolve --account "${selector}": ${e.message}\n`,
      );
      process.exit(getExitCode(e.code));
    }
    throw err;
  }

  // Before any matching, because every answer below is only as good as the set
  // it was decided against. A unique match on a truncated list is exactly the
  // failure this refuses: it is indistinguishable from a genuine unique match,
  // and picking it acts as an account the caller never named. "Matched nothing"
  // would be just as wrong, since the account may sit on a page never read.
  if (!listed.complete) {
    out.stderr.write(
      `error: [ACCOUNT_LIST_TRUNCATED] --account "${selector}" cannot be resolved by name: ` +
        `this API key has more connected accounts than the resolver reads (it stops after ` +
        `${MAX_LOOKUP_PAGES} pages of 250), so the name would be matched against an incomplete list ` +
        `and a single match would not prove there is only one. ` +
        `Pass the account id instead; an id is used as given and needs no lookup.\n`,
    );
    process.exit(2);
  }

  const accounts = listed.accounts;
  const matches = matchAccounts(accounts, selector);

  if (matches.length === 1) {
    const resolved = matches[0]!.accountId;
    // The id came off the wire, so it is not trusted either: it is about to
    // become a path segment, and this is the last point at which that can be
    // stopped. Checked with the strict rule, spaces included.
    const bad = pathSegmentViolation(resolved);
    if (bad !== null) {
      out.stderr.write(
        pathSegmentErrorMessage(`the account id resolved from "${selector}"`, resolved, bad),
      );
      process.exit(2);
    }
    return resolved;
  }

  if (matches.length > 1) {
    out.stderr.write(
      `error: [ACCOUNT_AMBIGUOUS] --account "${selector}" matches ${matches.length} connected accounts: ` +
        `${describeAll(matches)}. ` +
        `Pass the account id of the one you mean; this is not resolved by guessing, because acting as the wrong account cannot be undone.\n`,
    );
    process.exit(2);
  }

  const known =
    accounts.length === 0
      ? "No accounts are connected on this API key."
      : `Connected accounts: ${describeAll(accounts)}.`;
  out.stderr.write(
    `error: [ACCOUNT_NAME_NOT_FOUND] --account "${selector}" matched no connected account. ${known}\n`,
  );
  process.exit(4);
}
