import { vi } from "vitest";

/**
 * A client stub whose workspace has no connected account. A command run with
 * no account from flag, env or profile looks the connected accounts up; with
 * none it exits 2 before any command call, which is what a "missing account"
 * test asserts.
 */
export function noConnectedAccounts<T extends object>(client: T): T {
  return {
    ...client,
    accounts: { list: vi.fn().mockResolvedValue({ object: "account_list", items: [], cursor: null }) },
  };
}
