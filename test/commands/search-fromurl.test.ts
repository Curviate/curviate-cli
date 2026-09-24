/**
 * Tests for `search <url>` — the from-URL variant over search.fromUrl.
 * Assert the SDK method + exact args (the wire contract).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { noConnectedAccounts } from "../helpers/no-connected-accounts.js";

function makeAccountNs() {
  return {
    search: {
      fromUrl: vi.fn(),
    },
  };
}

function makeClient(accountNs: ReturnType<typeof makeAccountNs>) {
  return { account: vi.fn().mockReturnValue(accountNs) };
}

function makeOut() {
  return { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
}

function mockExit() {
  return vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
    throw new Error(`process.exit(${code})`);
  });
}

type Args = Record<string, unknown>;
const URL = "https://www.linkedin.com/search/results/people/?keywords=founder";

describe("search <url> -> search.fromUrl", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;
  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.search.fromUrl as Mock).mockResolvedValue({ object: "search_result_list", items: [], cursor: null });
  });
  afterEach(() => vi.restoreAllMocks());

  it("calls search.fromUrl with the url in the body", async () => {
    const { runSearchFromUrl } = await import("../../src/commands/search.js");
    await runSearchFromUrl(client as never, { url: URL, account: "acc_1", json: true } as Args, makeOut());
    expect(accountNs.search.fromUrl).toHaveBeenCalledWith({ url: URL });
  });

  it("forwards --limit and --cursor alongside the url", async () => {
    const { runSearchFromUrl } = await import("../../src/commands/search.js");
    await runSearchFromUrl(client as never, { url: URL, limit: "20", cursor: "c1", account: "acc_1", json: true } as Args, makeOut());
    expect(accountNs.search.fromUrl).toHaveBeenCalledWith({ url: URL, limit: 20, cursor: "c1" });
  });

  it("without --account exits 2 before any SDK call", async () => {
    const { runSearchFromUrl } = await import("../../src/commands/search.js");
    const exitSpy = mockExit();
    try {
      await runSearchFromUrl(noConnectedAccounts(client) as never, { url: URL } as Args, makeOut());
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(accountNs.search.fromUrl).not.toHaveBeenCalled();
  });
});

describe("search command surface", () => {
  type CommandLike = { args?: Record<string, { type?: string }>; subCommands?: Record<string, unknown> };

  it("the search group declares a bare url positional and keeps its structured subcommands", async () => {
    const { searchCommand } = await import("../../src/commands/search.js");
    const cmd = searchCommand as unknown as CommandLike;
    expect(cmd.args?.url?.type).toBe("positional");
    for (const name of ["people", "companies", "posts", "jobs", "parameters"]) {
      expect(cmd.subCommands, `search ${name} still registered`).toHaveProperty(name);
    }
  });
});
