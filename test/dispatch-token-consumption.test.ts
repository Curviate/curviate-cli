/**
 * Pre-router unit tests — the consumed-token-blindness class.
 *
 * The dispatcher's flag scan did not track which tokens were already
 * consumed as another flag's VALUE, so it re-inspected a value token as if it
 * were fresh input. Two named symptoms shared this one root cause:
 *
 *   1. `curviate --api-key <key> account list` exited 2 "unknown command":
 *      the routing scan that hunts for the subcommand keyword just skipped
 *      anything starting with "-" and stopped at the first token that
 *      didn't, landing on the KEY's VALUE instead of `account`.
 *   2. A flag value beginning with "-" (`--api-key -something`) exited 2
 *      "unknown flag": the value was re-scanned as if it were its own,
 *      undeclared flag.
 *
 * A THIRD, more severe defect surfaced only once (1) was fixed: the
 * subcommand-descent step dropped every token BEFORE the matched keyword
 * (`rawArgs.slice(idx + 1)`), so once routing correctly found `account` past
 * a leading `--api-key X`, the descent silently threw `--api-key` and its
 * value away. That is not a routing error, it is a SILENT WRONG CREDENTIAL:
 * the command still ran (exit 0), just against whatever profile/env fallback
 * sat underneath the flag the caller actually typed. Covered here as its own
 * assertions (not folded into the routing cases above) because a fix that
 * only restores routing without restoring the dropped tokens would pass every
 * exit-code-shaped test in this file while still shipping that regression.
 *
 * These tests call `resolveLeaf` directly (no subprocess, no build), so the
 * routing DECISION is assertable on its own: which leaf, with which args,
 * exactly the two things a black-box exit-code test cannot distinguish (see
 * dispatch.test.ts's header for the same rationale on the D4a class).
 *
 * The captured-outbound-request proof for the two ACs verbatim as filed
 * (`curviate --api-key <key> account list` behaves IDENTICALLY to
 * `curviate account list --api-key <key>`, and a dash-prefixed value reaches
 * the wire byte for byte) lives in
 * test/dispatch-global-flag-placement.test.ts, against the built binary and a
 * real HTTP stub, per the AC's own "not on stdout" requirement.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { CommandDef } from "citty";
import { resolveLeaf } from "../src/dispatch.js";
import { accountCommand } from "../src/commands/account.js";
import { webhookCommand } from "../src/commands/webhook.js";
import { connectCommand } from "../src/commands/connect.js";
import { companyCommand } from "../src/commands/company.js";

const asCmd = (c: unknown): CommandDef => c as CommandDef;

async function nameOf(cmd: CommandDef): Promise<string | undefined> {
  const meta = typeof cmd.meta === "function" ? await (cmd.meta as () => Promise<{ name?: string }>)() : cmd.meta;
  return (meta as { name?: string } | undefined)?.name;
}

function mockExit() {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
}

describe("routing — a global flag before the subcommand keyword resolves (symptom 1)", () => {
  afterEach(() => vi.restoreAllMocks());

  // [label, tree, rawArgs, expected leaf name]
  const cases: Array<[string, CommandDef, string[], string]> = [
    ["pure group: account --api-key X list", asCmd(accountCommand), ["--api-key", "X", "list"], "list"],
    ["pure group: webhook --api-key X list", asCmd(webhookCommand), ["--api-key", "X", "list"], "list"],
    [
      "pure group: two global flags before the keyword",
      asCmd(accountCommand),
      ["--api-key", "X", "--account", "acc_1", "list"],
      "list",
    ],
    [
      "global flag between the group and a deeper subcommand: account checkpoint --api-key X solve",
      asCmd(accountCommand),
      ["checkpoint", "--api-key", "X", "solve", "acc_1", "--code", "123456"],
      "solve",
    ],
    [
      "bare-positional group's OWN subcommand, global flag first: connect --api-key X accept 123",
      asCmd(connectCommand),
      ["--api-key", "X", "accept", "123"],
      "accept",
    ],
    [
      "boolean global flag before the keyword (never broken, regression lock): account --json list",
      asCmd(accountCommand),
      ["--json", "list"],
      "list",
    ],
  ];

  it.each(cases)("%s", async (_label, tree, rawArgs, leafName) => {
    const { leaf } = await resolveLeaf(tree, rawArgs);
    expect(await nameOf(leaf)).toBe(leafName);
  });
});

describe("routing — tokens before the matched subcommand keyword survive the descent, not just the routing decision", () => {
  afterEach(() => vi.restoreAllMocks());

  it("account --api-key X list -> leafArgs keeps --api-key X (the silent-drop regression)", async () => {
    const { leafArgs } = await resolveLeaf(asCmd(accountCommand), ["--api-key", "X", "list"]);
    expect(leafArgs).toEqual(["--api-key", "X"]);
  });

  it("account --api-key X --account acc_1 list -> both leading global flags survive, in order", async () => {
    const { leafArgs } = await resolveLeaf(asCmd(accountCommand), [
      "--api-key",
      "X",
      "--account",
      "acc_1",
      "list",
    ]);
    expect(leafArgs).toEqual(["--api-key", "X", "--account", "acc_1"]);
  });

  it("connect --api-key X accept 123 -> --api-key X survives past TWO descent steps, id positional intact", async () => {
    const { leafArgs } = await resolveLeaf(asCmd(connectCommand), ["--api-key", "X", "accept", "123"]);
    expect(leafArgs).toEqual(["--api-key", "X", "123"]);
  });

  it("company --api-key X 1035 employees -> the id-first reroute ALSO keeps the leading global flag", async () => {
    const { leaf, leafArgs } = await resolveLeaf(asCmd(companyCommand), ["--api-key", "X", "1035", "employees"]);
    expect(await nameOf(leaf)).toBe("employees");
    expect(leafArgs).toEqual(["--api-key", "X", "1035"]);
  });
});

describe("routing — a flag value beginning with \"-\" no longer misroutes or gets mis-swallowed as extra (symptom 2, routing half)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("account --api-key -something list -> still routes to list, value intact in leafArgs", async () => {
    const { leaf, leafArgs } = await resolveLeaf(asCmd(accountCommand), ["--api-key", "-something", "list"]);
    expect(await nameOf(leaf)).toBe("list");
    expect(leafArgs).toEqual(["--api-key", "-something"]);
  });

  it("connect --note -foo jdoe -> the dash-prefixed note value does not eat the id positional", async () => {
    const { leaf, leafArgs } = await resolveLeaf(asCmd(connectCommand), ["--note", "-foo", "jdoe"]);
    expect(await nameOf(leaf)).toBe("connect");
    expect(leafArgs).toEqual(["--note", "-foo", "jdoe"]);
  });
});

describe("routing — polarity: shapes that were already correctly rejected stay rejected", () => {
  afterEach(() => vi.restoreAllMocks());

  it("account --api-key X bogus-sub -> still an unknown command, not silently accepted", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const exit = mockExit();
    await expect(resolveLeaf(asCmd(accountCommand), ["--api-key", "X", "bogus-sub"])).rejects.toThrow(
      "process.exit(2)",
    );
    exit.mockRestore();
  });

  it("connect --api-key X jdoe bogus -> a genuine extra positional past a leading global flag still exits 2", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const exit = mockExit();
    await expect(
      resolveLeaf(asCmd(connectCommand), ["--api-key", "X", "jdoe", "bogus"]),
    ).rejects.toThrow("process.exit(2)");
    exit.mockRestore();
  });

  it("connect --note --json jdoe -> --json still wins as its own boolean flag, never swallowed as note's literal value", async () => {
    const { leafArgs } = await resolveLeaf(asCmd(connectCommand), ["--note", "--json", "jdoe"]);
    // Unconsumed: --note has no bound value, --json stands alone, jdoe is the id.
    expect(leafArgs).toEqual(["--note", "--json", "jdoe"]);
  });
});
