/**
 * Bare-group-invocation exit-code contract (the `connect` M3 finding,
 * generalized across every top-level group).
 *
 * `curviate connect` (zero args — no id, no subcommand) printed its usage
 * block to stderr and exited 0. Per the CLI's error-to-exit-code contract
 * (usage/invalid-input → exit 2), a missing REQUIRED positional is a usage
 * error.
 * `connect`'s own `id` positional is declared `required: false` on the citty
 * arg def (so citty's native enforcement doesn't fire before the group's own
 * richer, subcommand-listing usage message can run) — but the group's `run()`
 * handler forgot to call `process.exit(2)` after printing that message,
 * silently falling through to Node's default exit code 0.
 *
 * Two classes of top-level group, confirmed directly from each command's own
 * `defineCommand({...})` (not inferred from prose):
 *
 * - Class A — declares an intent-shaped bare positional that is functionally
 *   required for the bare form to do anything (`connect <id>`, `profile
 *   <id>`, `message <chat_id> "<text>"`, `search <url>`). A bare invocation
 *   with that positional missing is a missing-required-positional usage
 *   error → exit 2. `connect`, `profile`, `message`, `search` all shared the
 *   identical bug shape (`if (!flags.x) { print usage; return; }`, no exit
 *   call) — this fixes all four.
 * - Class B — a PURE noun group: every action lives behind a named
 *   subcommand keyword (`job get`, `account list`, `webhook create`, …) and
 *   the group itself declares NO bare positional at all. There is no
 *   "missing positional" here — none was ever expected — so `curviate
 *   <group>` alone is the group showing its menu, same as many CLIs for a
 *   bare noun with no default action. This stays exit 0 BY DESIGN, not by
 *   omission, and is asserted here as a regression lock, not "fixed".
 *
 * `company` is neither: its `id` positional has no explicit `required` key,
 * so citty's OWN default (positionals are required unless `required:
 * false` is explicit — confirmed in citty's source) enforces it natively,
 * with zero hand-rolled code. It was already correct before this fix and is
 * asserted here only as the reference shape the fix generalizes toward.
 *
 * These tests call citty's `runCommand` directly on each root command node
 * with `rawArgs: []` — the same final execution step `src/dispatch.ts` takes
 * for a truly bare invocation (no token at all never triggers citty's own
 * misroute/double-run bugs, so this is faithful without needing a subprocess
 * spawn). Two representative cases (`connect`, `account`) are also verified
 * end-to-end against the built binary in test/routing.test.ts.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { CommandDef } from "citty";
import { runCommand } from "citty";
import { connectCommand } from "../src/commands/connect.js";
import { profileCommand } from "../src/commands/profile.js";
import { messageCommand } from "../src/commands/message.js";
import { searchCommand } from "../src/commands/search.js";
import { jobCommand } from "../src/commands/job.js";
import { inboxCommand } from "../src/commands/inbox.js";
import { postCommand } from "../src/commands/post.js";
import { commentCommand } from "../src/commands/comment.js";
import { accountCommand } from "../src/commands/account.js";
import { webhookCommand } from "../src/commands/webhook.js";
import { salesNavCommand } from "../src/commands/sales-nav.js";
import { recruiterCommand } from "../src/commands/recruiter.js";
import { companyCommand } from "../src/commands/company.js";
import { groupCommand } from "../src/commands/group.js";
import { feedCommand } from "../src/commands/feed.js";
import { notificationCommand } from "../src/commands/notification.js";

const asCmd = (c: unknown): CommandDef => c as CommandDef;

/** Run a root command's own handler with zero args, subCommands stripped — mirrors dispatch.ts's final execution step for a truly bare invocation. */
function runBare(cmd: CommandDef): Promise<unknown> {
  return runCommand({ ...cmd, subCommands: undefined }, { rawArgs: [] });
}

function mockExit() {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
}

describe("bare group invocation — Class A: intent-shaped bare positional, missing → exit 2", () => {
  afterEach(() => vi.restoreAllMocks());

  const cases: Array<[string, CommandDef]> = [
    ["connect", asCmd(connectCommand)],
    ["profile", asCmd(profileCommand)],
    ["message", asCmd(messageCommand)],
    ["search", asCmd(searchCommand)],
  ];

  it.each(cases)("bare `%s` (positional missing) calls process.exit(2), usage block on stderr", async (_name, cmd) => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const exitSpy = mockExit();

    await expect(runBare(cmd)).rejects.toThrow("process.exit(2)");

    expect(exitSpy).toHaveBeenCalledWith(2);
    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(written).toMatch(/^Usage: curviate/m);
  });
});

describe("bare group invocation — Class B: pure groups (no bare positional declared) stay exit 0", () => {
  afterEach(() => vi.restoreAllMocks());

  const cases: Array<[string, CommandDef]> = [
    ["job", asCmd(jobCommand)],
    ["inbox", asCmd(inboxCommand)],
    ["post", asCmd(postCommand)],
    ["comment", asCmd(commentCommand)],
    ["account", asCmd(accountCommand)],
    ["webhook", asCmd(webhookCommand)],
    ["sales-nav", asCmd(salesNavCommand)],
    ["recruiter", asCmd(recruiterCommand)],
    ["group", asCmd(groupCommand)],
    ["feed", asCmd(feedCommand)],
    ["notification", asCmd(notificationCommand)],
  ];

  it.each(cases)("bare `%s` (pure group) does NOT call process.exit, prints its subcommand menu to stderr", async (_name, cmd) => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const exitSpy = mockExit();

    await runBare(cmd); // must resolve, not throw/reject

    expect(exitSpy).not.toHaveBeenCalled();
    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(written).toMatch(/^Usage: curviate/m);
  });
});

describe("bare group invocation — company: already-correct reference shape (unchanged by this fix)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("bare `company` (positional has no explicit `required: false`) — citty enforces it natively, no hand-rolled exit call needed", async () => {
    // No `required: false` override → citty's own default kicks in and throws
    // BEFORE company's run() ever executes — no process.exit call to observe
    // here (src/dispatch.ts's outer catch is what maps this to exit 2 in
    // production; that mapping is covered end-to-end in test/routing.test.ts).
    await expect(runBare(asCmd(companyCommand))).rejects.toThrow(/Missing required positional argument/i);
  });
});
