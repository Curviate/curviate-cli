/**
 * Orphan-command removal guard (v2 parity).
 *
 * The v2 API surface dropped a set of endpoints; the CLI commands that wrapped
 * them are removed. This suite is the mechanical regression guard that each
 * removed command is absent from its group's `subCommands` map (so it resolves
 * to an unknown-command usage error and never renders in `--help`), while the
 * exempt/retained commands stay present.
 *
 * `defineCommand` is an identity function in citty, so `.subCommands` is the
 * raw registry whose keys ARE the resolvable subcommand names.
 */

import { describe, it, expect } from "vitest";

type CommandLike = { subCommands?: Record<string, CommandLike> };

async function subCommandsOf(mod: string, exportName: string): Promise<Record<string, CommandLike>> {
  const imported = (await import(mod)) as Record<string, unknown>;
  const cmd = imported[exportName] as CommandLike;
  return cmd.subCommands ?? {};
}

describe("orphan commands are removed from their group", () => {
  it("account no longer registers connect-link / reconnect-link / reconnect (link + connect-session poll kept)", async () => {
    const subs = await subCommandsOf("../src/commands/account.js", "accountCommand");
    expect(subs).not.toHaveProperty("connect-link");
    expect(subs).not.toHaveProperty("reconnect-link");
    expect(subs).not.toHaveProperty("reconnect");
    expect(subs).toHaveProperty("link");
    expect(subs).toHaveProperty("connect-session");
  });

  // `company followers` was removed in the v2 migration (see below) and
  // re-added once the SDK shipped a new v2 companies.followers method (#521,
  // SDK-parity gap closure) — see test/commands/company.test.ts for its
  // current coverage.

  it("inbox no longer registers sync / sync-chat (mark-read kept)", async () => {
    const subs = await subCommandsOf("../src/commands/inbox.js", "inboxCommand");
    expect(subs).not.toHaveProperty("sync");
    expect(subs).not.toHaveProperty("sync-chat");
    expect(subs).toHaveProperty("mark-read");
  });

  it("post no longer registers list / comment / comments (moved to the comment group)", async () => {
    const subs = await subCommandsOf("../src/commands/post.js", "postCommand");
    expect(subs).not.toHaveProperty("list");
    expect(subs).not.toHaveProperty("comment");
    expect(subs).not.toHaveProperty("comments");
    expect(subs).toHaveProperty("delete");
    expect(subs).toHaveProperty("user-posts");
  });

  it("recruiter no longer registers sync / add-applicant / reject-applicant", async () => {
    const subs = await subCommandsOf("../src/commands/recruiter.js", "recruiterCommand");
    expect(subs).not.toHaveProperty("sync");
    expect(subs).not.toHaveProperty("add-applicant");
    expect(subs).not.toHaveProperty("reject-applicant");
  });

  it("recruiter job no longer registers the checkpoint verb", async () => {
    const subs = await subCommandsOf("../src/commands/recruiter.js", "recruiterCommand");
    const jobSubs = subs["job"]?.subCommands ?? {};
    expect(jobSubs).not.toHaveProperty("checkpoint");
    expect(jobSubs).toHaveProperty("publish");
  });

  it("sales-nav no longer registers sync", async () => {
    const subs = await subCommandsOf("../src/commands/sales-nav.js", "salesNavCommand");
    expect(subs).not.toHaveProperty("sync");
    expect(subs).toHaveProperty("search");
  });

  it("webhook no longer registers state-diff (verify kept, exempt)", async () => {
    const subs = await subCommandsOf("../src/commands/webhook.js", "webhookCommand");
    expect(subs).not.toHaveProperty("state-diff");
    expect(subs).toHaveProperty("verify");
  });
});
