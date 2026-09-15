/**
 * Recruiter + Sales Navigator flag-hygiene tests.
 *
 * Write commands and single-object read commands must NOT expose pagination
 * flags (--limit, --cursor, --all, --max-pages) in their help. List commands
 * (search people, list projects, list jobs, list applicants, search companies)
 * MUST retain all pagination flags.
 *
 * Strategy: inspect the `args` object on each subcommand definition directly.
 * `defineCommand` is an identity function in citty, so `.subCommands.foo.args`
 * is the raw args object whose keys ARE the registered flags. Mirrors
 * test/commands/post-write-flags.test.ts.
 */

import { describe, it, expect } from "vitest";

/** Flags that must NEVER appear on write commands or single-object non-list reads. */
const PAGINATION_ONLY_FLAGS = ["limit", "cursor", "all", "max-pages"] as const;

type ArgsRecord = Record<string, unknown>;
type CommandLike = { args?: ArgsRecord; subCommands?: Record<string, CommandLike> };

describe("recruiter write commands — no pagination flags in help", () => {
  it.each([
    ["message.new (start-chat)", ["message", "new"]],
    ["save-candidate", ["save-candidate"]],
    ["job.create", ["job", "create"]],
    ["job.publish", ["job", "publish"]],
    ["job.close", ["job", "close"]],
    ["project.update", ["project", "update"]],
    ["project-job.create", ["project-job", "create"]],
    ["project-job.update", ["project-job", "update"]],
  ])("recruiter %s — args definition has no pagination flags", async (_label, path) => {
    const { recruiterCommand } = await import("../../src/commands/recruiter.js");
    let cmd = recruiterCommand as unknown as CommandLike;
    for (const seg of path) {
      cmd = (cmd.subCommands ?? {})[seg] as CommandLike;
    }
    const args = cmd?.args ?? {};

    for (const flag of PAGINATION_ONLY_FLAGS) {
      expect(args, `recruiter ${path.join(" ")} args must NOT include --${flag}`).not.toHaveProperty(flag);
    }
  });
});

describe("recruiter single-object read commands — no pagination flags in help (fields allowed)", () => {
  it.each([
    ["profile", ["profile"]],
    ["project", ["project"]],
    ["applicant (get)", ["applicant"]],
    ["applicant.resume", ["applicant", "resume"]],
    ["job.get", ["job", "get"]],
    ["project-job.get", ["project-job", "get"]],
    ["project-job.budget", ["project-job", "budget"]],
  ])("recruiter %s — no pagination-only flags", async (_label, path) => {
    const { recruiterCommand } = await import("../../src/commands/recruiter.js");
    let cmd = recruiterCommand as unknown as CommandLike;
    for (const seg of path) {
      cmd = (cmd.subCommands ?? {})[seg] as CommandLike;
    }
    const args = cmd?.args ?? {};

    for (const flag of PAGINATION_ONLY_FLAGS) {
      expect(args, `recruiter ${path.join(" ")} args must NOT include --${flag}`).not.toHaveProperty(flag);
    }
    expect(args, `recruiter ${path.join(" ")} must keep --fields (single-object read)`).toHaveProperty("fields");
  });
});

describe("recruiter list commands — DOES have pagination flags (negative control)", () => {
  it.each([
    ["search.people", ["search", "people"]],
    ["projects", ["projects"]],
    ["jobs", ["jobs"]],
    // `applicants` takes --limit/--cursor but does not stream, so it declares no --all.
    ["pipeline", ["pipeline"]],
    ["talent-search", ["talent-search"]],
  ])("recruiter %s — args definition retains pagination flags", async (_label, path) => {
    const { recruiterCommand } = await import("../../src/commands/recruiter.js");
    let cmd = recruiterCommand as unknown as CommandLike;
    for (const seg of path) {
      cmd = (cmd.subCommands ?? {})[seg] as CommandLike;
    }
    const args = cmd?.args ?? {};

    expect(args, `recruiter ${path.join(" ")} must have --limit`).toHaveProperty("limit");
    expect(args, `recruiter ${path.join(" ")} must have --cursor`).toHaveProperty("cursor");
    expect(args, `recruiter ${path.join(" ")} must have --all`).toHaveProperty("all");
  });

  it("recruiter search (the group itself, bare <url> form) — retains pagination flags", async () => {
    const { recruiterCommand } = await import("../../src/commands/recruiter.js");
    const subCmds = (recruiterCommand as unknown as CommandLike).subCommands ?? {};
    const args = subCmds["search"]?.args ?? {};

    expect(args, "recruiter search must have --limit").toHaveProperty("limit");
    expect(args, "recruiter search must have --cursor").toHaveProperty("cursor");
    expect(args, "recruiter search must have --all").toHaveProperty("all");
  });
});

describe("sales-nav write commands — no pagination flags in help", () => {
  it.each([
    ["message.new (start-chat)", ["message", "new"]],
    ["save-lead", ["save-lead"]],
    ["save-account", ["save-account"]],
  ])("sales-nav %s — args definition has no pagination flags", async (_label, path) => {
    const { salesNavCommand } = await import("../../src/commands/sales-nav.js");
    let cmd = salesNavCommand as unknown as CommandLike;
    for (const seg of path) {
      cmd = (cmd.subCommands ?? {})[seg] as CommandLike;
    }
    const args = cmd?.args ?? {};

    for (const flag of PAGINATION_ONLY_FLAGS) {
      expect(args, `sales-nav ${path.join(" ")} args must NOT include --${flag}`).not.toHaveProperty(flag);
    }
  });
});

describe("sales-nav single-object read commands — no pagination flags in help (fields allowed)", () => {
  it("sales-nav profile — no pagination-only flags", async () => {
    const { salesNavCommand } = await import("../../src/commands/sales-nav.js");
    const subCmds = (salesNavCommand as unknown as CommandLike).subCommands ?? {};
    const args = subCmds["profile"]?.args ?? {};

    for (const flag of PAGINATION_ONLY_FLAGS) {
      expect(args, `sales-nav profile args must NOT include --${flag}`).not.toHaveProperty(flag);
    }
    expect(args, "sales-nav profile must keep --fields (single-object read)").toHaveProperty("fields");
  });
});

describe("sales-nav list commands — DOES have pagination flags (negative control)", () => {
  it.each([
    ["search.people", ["search", "people"]],
    ["search.companies", ["search", "companies"]],
    ["account-lists", ["account-lists"]],
    ["lead-lists", ["lead-lists"]],
    ["browse-account-list", ["browse-account-list"]],
    ["browse-lead-list", ["browse-lead-list"]],
  ])("sales-nav %s — args definition retains pagination flags", async (_label, path) => {
    const { salesNavCommand } = await import("../../src/commands/sales-nav.js");
    let cmd = salesNavCommand as unknown as CommandLike;
    for (const seg of path) {
      cmd = (cmd.subCommands ?? {})[seg] as CommandLike;
    }
    const args = cmd?.args ?? {};

    expect(args, `sales-nav ${path.join(" ")} must have --limit`).toHaveProperty("limit");
    expect(args, `sales-nav ${path.join(" ")} must have --cursor`).toHaveProperty("cursor");
    expect(args, `sales-nav ${path.join(" ")} must have --all`).toHaveProperty("all");
  });

  it("sales-nav search (the group itself, bare <url> form) — retains pagination flags", async () => {
    const { salesNavCommand } = await import("../../src/commands/sales-nav.js");
    const subCmds = (salesNavCommand as unknown as CommandLike).subCommands ?? {};
    const args = subCmds["search"]?.args ?? {};

    expect(args, "sales-nav search must have --limit").toHaveProperty("limit");
    expect(args, "sales-nav search must have --cursor").toHaveProperty("cursor");
    expect(args, "sales-nav search must have --all").toHaveProperty("all");
  });
});
