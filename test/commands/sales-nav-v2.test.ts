/**
 * Tests for the `sales-nav` v2 list-surface cascade (5 net-new subcommands).
 *
 * Coverage:
 *   sales-nav account-lists --account <id>                                            → salesNavigator.accountLists
 *   sales-nav lead-lists --account <id>                                                → salesNavigator.leadLists
 *   sales-nav browse-account-list <list_id> --account <id> [--filter --sort-by --sort-order] → salesNavigator.browseAccountList
 *   sales-nav browse-lead-list <list_id> --account <id> [--spotlight --sort-by --sort-order] → salesNavigator.browseLeadList
 *   sales-nav save-account --list <id> <company_id> --account <id>                     → salesNavigator.saveAccount
 *
 * Each run function calls the stubbed SDK method (no re-implementation of the
 * HTTP call — SDK-before-CLI ordering) and prints the fixture. `save-account
 * --help` excludes pagination flags (write, WRITE_FLAGS); `browse-account-list
 * --help` retains them (paginated browse, not a single-read).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";

// ─── Mock client factory ───────────────────────────────────────────────────

function makeSalesNavNs() {
  return {
    salesNavigator: {
      accountLists: vi.fn(),
      leadLists: vi.fn(),
      browseAccountList: vi.fn(),
      browseLeadList: vi.fn(),
      saveAccount: vi.fn(),
    },
  };
}

function makeClient(ns: ReturnType<typeof makeSalesNavNs>) {
  return {
    account: vi.fn().mockReturnValue(ns),
  };
}

function makeOut() {
  return {
    stdout: { write: vi.fn() },
    stderr: { write: vi.fn() },
  };
}

type ArgsRecord = Record<string, unknown>;
type CommandLike = { args?: ArgsRecord; subCommands?: Record<string, CommandLike> };

// ─── sales-nav account-lists ────────────────────────────────────────────────

describe("sales-nav account-lists", () => {
  let ns: ReturnType<typeof makeSalesNavNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeSalesNavNs();
    client = makeClient(ns);
    (ns.salesNavigator.accountLists as Mock).mockResolvedValue({
      object: "sn_account_list_result",
      items: [{ object: "sn_account_list", id: "L1", name: "Targets" }],
      cursor: null,
    });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls salesNavigator.accountLists and prints the fixture", async () => {
    const { runSalesNavAccountLists } = await import("../../src/commands/sales-nav.js");
    const out = makeOut();

    await runSalesNavAccountLists(client as never, { account: "acc_a", json: true }, out);

    expect(client.account).toHaveBeenCalledWith("acc_a");
    expect(ns.salesNavigator.accountLists).toHaveBeenCalled();
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.object).toBe("sn_account_list_result");
  });
});

// ─── sales-nav lead-lists ───────────────────────────────────────────────────

describe("sales-nav lead-lists", () => {
  let ns: ReturnType<typeof makeSalesNavNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeSalesNavNs();
    client = makeClient(ns);
    (ns.salesNavigator.leadLists as Mock).mockResolvedValue({
      object: "sn_lead_list_result",
      items: [{ object: "sn_lead_list", id: "L2", name: "Warm leads" }],
      cursor: null,
    });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls salesNavigator.leadLists and prints the fixture", async () => {
    const { runSalesNavLeadLists } = await import("../../src/commands/sales-nav.js");
    const out = makeOut();

    await runSalesNavLeadLists(client as never, { account: "acc_a", json: true }, out);

    expect(client.account).toHaveBeenCalledWith("acc_a");
    expect(ns.salesNavigator.leadLists).toHaveBeenCalled();
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.object).toBe("sn_lead_list_result");
  });
});

// ─── sales-nav browse-account-list ──────────────────────────────────────────

describe("sales-nav browse-account-list", () => {
  let ns: ReturnType<typeof makeSalesNavNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeSalesNavNs();
    client = makeClient(ns);
    (ns.salesNavigator.browseAccountList as Mock).mockResolvedValue({
      object: "sn_saved_account_result",
      items: [{ object: "sn_saved_account", id: "co_1", display_name: "T-Systems" }],
      cursor: null,
    });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("browse-account-list L1 --account acc_a --filter STARRED calls browseAccountList with parsed args", async () => {
    const { runSalesNavBrowseAccountList } = await import("../../src/commands/sales-nav.js");
    const out = makeOut();

    await runSalesNavBrowseAccountList(client as never, {
      account: "acc_a",
      listId: "L1",
      filter: "STARRED",
      json: true,
    }, out);

    expect(ns.salesNavigator.browseAccountList).toHaveBeenCalledWith(
      "L1",
      expect.objectContaining({ filter: "STARRED" }),
      undefined,
    );
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.object).toBe("sn_saved_account_result");
  });
});

// ─── sales-nav browse-lead-list ─────────────────────────────────────────────

describe("sales-nav browse-lead-list", () => {
  let ns: ReturnType<typeof makeSalesNavNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeSalesNavNs();
    client = makeClient(ns);
    (ns.salesNavigator.browseLeadList as Mock).mockResolvedValue({
      object: "sn_saved_lead_result",
      items: [{ object: "sn_saved_lead", id: "ACwABC", display_name: "Alice" }],
      cursor: null,
    });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("browse-lead-list L2 --account acc_a --spotlight RECENT_POSITION_CHANGE calls browseLeadList with parsed args", async () => {
    const { runSalesNavBrowseLeadList } = await import("../../src/commands/sales-nav.js");
    const out = makeOut();

    await runSalesNavBrowseLeadList(client as never, {
      account: "acc_a",
      listId: "L2",
      spotlight: "RECENT_POSITION_CHANGE",
      json: true,
    }, out);

    expect(ns.salesNavigator.browseLeadList).toHaveBeenCalledWith(
      "L2",
      expect.objectContaining({ spotlight: "RECENT_POSITION_CHANGE" }),
      undefined,
    );
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.object).toBe("sn_saved_lead_result");
  });
});

// ─── sales-nav save-account ─────────────────────────────────────────────────

describe("sales-nav save-account", () => {
  let ns: ReturnType<typeof makeSalesNavNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeSalesNavNs();
    client = makeClient(ns);
    (ns.salesNavigator.saveAccount as Mock).mockResolvedValue({
      object: "sn_account_saved",
      list_id: "L1",
      company_id: "123",
    });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("save-account --list L1 123 --account acc_a calls saveAccount and prints the confirmation", async () => {
    const { runSalesNavSaveAccount } = await import("../../src/commands/sales-nav.js");
    const out = makeOut();

    await runSalesNavSaveAccount(client as never, {
      account: "acc_a",
      list: "L1",
      companyId: "123",
      json: true,
    }, out);

    expect(ns.salesNavigator.saveAccount).toHaveBeenCalledWith({ list_id: "L1", company_id: "123" });
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.object).toBe("sn_account_saved");
  });

  it("--preview renders request, does not call saveAccount", async () => {
    const { runSalesNavSaveAccount } = await import("../../src/commands/sales-nav.js");
    const out = makeOut();

    await runSalesNavSaveAccount(client as never, {
      account: "acc_a",
      list: "L1",
      companyId: "123",
      preview: true,
    }, out);

    expect(ns.salesNavigator.saveAccount).not.toHaveBeenCalled();
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.method).toBe("salesNavigator.saveAccount");
  });
});

// ─── flag hygiene: save-account (write, WRITE_FLAGS) vs. browse-account-list (paginated) ──

describe("sales-nav v2 flag hygiene", () => {
  it("save-account --help excludes pagination flags (write, WRITE_FLAGS)", async () => {
    const { salesNavCommand } = await import("../../src/commands/sales-nav.js");
    const cmd = (salesNavCommand as unknown as CommandLike).subCommands?.["save-account"];
    const args = cmd?.args ?? {};

    for (const flag of ["limit", "cursor", "all", "max-pages"]) {
      expect(args, `save-account args must NOT include --${flag}`).not.toHaveProperty(flag);
    }
  });

  it("browse-account-list --help includes pagination flags (paginated browse, not a single-read)", async () => {
    const { salesNavCommand } = await import("../../src/commands/sales-nav.js");
    const cmd = (salesNavCommand as unknown as CommandLike).subCommands?.["browse-account-list"];
    const args = cmd?.args ?? {};

    expect(args, "browse-account-list must have --limit").toHaveProperty("limit");
    expect(args, "browse-account-list must have --cursor").toHaveProperty("cursor");
    expect(args, "browse-account-list must have --all").toHaveProperty("all");
    expect(args, "browse-account-list must have --max-pages").toHaveProperty("max-pages");
  });
});
