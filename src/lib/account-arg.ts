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
 * as before. Only a name pays for one `accounts.list` read, and the result is
 * memoized per client so a command that asks twice still resolves once.
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

/** The fields of a connected account this resolver matches on. */
interface ConnectedAccount {
  accountId: string;
  fullName: string | null;
}

/**
 * One `accounts.list` result per client, so several `requireAccount` calls in
 * a single command run cannot multiply into several lookups.
 */
const listCache = new WeakMap<object, Promise<ConnectedAccount[]>>();

/** Cursor pages to walk before giving up. 250 per page covers any real tenant. */
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
function listConnectedAccounts(client: Curviate): Promise<ConnectedAccount[]> {
  const cached = listCache.get(client);
  if (cached) return cached;

  const pending = (async (): Promise<ConnectedAccount[]> => {
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
      if (!result.cursor) break;
      cursor = result.cursor;
    }
    return accounts;
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
 * @param client  the SDK client, used only when a lookup is actually needed
 * @param account the merged value (flag > env > profile), or undefined
 */
export async function requireAccount(
  client: Curviate,
  account: string | undefined,
  out: AccountArgStreams,
): Promise<string> {
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

  let accounts: ConnectedAccount[];
  try {
    accounts = await listConnectedAccounts(client);
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
