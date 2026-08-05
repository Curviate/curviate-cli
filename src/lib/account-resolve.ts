/**
 * Account-id resolution for account-scoped commands.
 *
 * Every v1 REST route takes `account_id` as a path segment, so the CLI has
 * always required `--account`. That made the very first thing a new user does
 * fail: `curviate login` prints "Run `curviate profile me` to verify", and on a
 * fresh config `profile me` exited 2 with "--account is required" before making
 * any network call.
 *
 * With exactly one connected account there is nothing to disambiguate, so we
 * resolve it instead of asking. This mirrors the contract the MCP surface
 * already ships, where `account_id` may be omitted whenever only one account
 * is connected.
 *
 * An explicit `--account` / `CURVIATE_ACCOUNT` / configured profile account
 * always wins and costs no network call; the lookup happens only when nothing
 * was configured at all.
 */

import type { Curviate } from "@curviate/sdk";
import type { OutputStreams } from "./output.js";

/** Shape of the one field we need off `accounts.list()`. */
interface AccountListItem {
  account_id?: unknown;
  full_name?: unknown;
  status?: unknown;
}

function describe(item: AccountListItem): string {
  const id = typeof item.account_id === "string" ? item.account_id : "(unknown id)";
  const name = typeof item.full_name === "string" && item.full_name ? item.full_name : null;
  const status = typeof item.status === "string" && item.status ? item.status : null;
  const suffix = [name, status].filter(Boolean).join(", ");
  return suffix ? `${id} (${suffix})` : id;
}

/**
 * Resolve the account id for an account-scoped command.
 *
 * Returns the configured id when there is one. Otherwise looks up the connected
 * accounts and uses the sole one. Exits 2 with an actionable message when the
 * tenant has none, has more than one, or the lookup itself fails.
 */
export async function resolveAccountIdOrExit(
  client: Curviate,
  account: string | undefined,
  out: OutputStreams,
): Promise<string> {
  if (account) return account;

  let items: AccountListItem[];
  try {
    const result = (await client.accounts.list({})) as { items?: unknown };
    items = Array.isArray(result.items) ? (result.items as AccountListItem[]) : [];
  } catch {
    // The lookup is a convenience, so a failure must not masquerade as a
    // connectivity bug in the command the user actually asked for.
    out.stderr.write(
      "error: --account is required, and the connected accounts could not be listed to infer it. Pass --account, set CURVIATE_ACCOUNT, or run `curviate config set-account`.\n",
    );
    process.exit(2);
  }

  if (items.length === 1) {
    const id = items[0]?.account_id;
    if (typeof id === "string" && id) return id;
  }

  if (items.length === 0) {
    out.stderr.write(
      "error: no LinkedIn account is connected to this workspace yet. Connect one, then retry. Run `curviate account list` to check.\n",
    );
    process.exit(2);
  }

  // Deliberately not "N accounts are connected": `items` is the first page, so
  // its length is not a verified total. State only what was observed.
  const listing = items.map((i) => `  ${describe(i)}`).join("\n");
  out.stderr.write(
    `error: more than one account is connected, so --account is required to pick one. Pass --account, set CURVIATE_ACCOUNT, or run \`curviate config set-account\`.\nConnected accounts:\n${listing}\n`,
  );
  process.exit(2);
}
