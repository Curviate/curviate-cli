/**
 * search command help-string assertions.
 *
 * Strategy: inspect the `description` field of each named arg in the citty
 * command definitions. Tests fail early if the public help text diverges from
 * the spec requirements. (citty renders --help directly from these
 * meta.description/description strings — help-clean.test.ts documents why
 * this is equivalent to spawning the binary for pure string content.)
 *
 * The help-text-only correction block below additionally spawns the
 * BUILT bin (dist/cli.js) and captures the real `--help` output, since those
 * assertions are about what a caller actually sees on the terminal, not just
 * the source-level description string.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Helper: extract args from a subcommand of searchCommand.
async function getSearchSubArgs(sub: string): Promise<Record<string, { description?: string }>> {
  const { searchCommand } = await import("../../src/commands/search.js");
  const subCmds = (searchCommand as Record<string, unknown>).subCommands as Record<
    string,
    { args?: Record<string, { description?: string }> }
  >;
  return subCmds[sub]?.args ?? {};
}

const __dirname = dirname(fileURLToPath(import.meta.url));
// Test lives in test/commands/ — two levels above the package root.
const pkgRoot = resolve(__dirname, "../..");
const cliPath = resolve(pkgRoot, "dist", "cli.js");

function runHelp(args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args, "--help"], {
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, NODE_ENV: "production", TEST: "false", CI: "false", CURVIATE_API_KEY: "rdc_live_help_test_stub" },
  });
}

/** Combined stdout+stderr — citty/consola may write help to either stream. */
function helpText(args: string[]): string {
  const r = runHelp(args);
  return (r.stdout ?? "") + (r.stderr ?? "");
}

// ---------------------------------------------------------------------------
// search jobs --date-posted help
// ---------------------------------------------------------------------------

describe("search jobs --date-posted help text", () => {
  it("flag exists on the jobs subcommand", async () => {
    const args = await getSearchSubArgs("jobs");
    expect(args["date-posted"]).toBeDefined();
  });

  it("description mentions 'days' and examples like 7, 14, 30", async () => {
    const args = await getSearchSubArgs("jobs");
    const desc = args["date-posted"]?.description ?? "";
    expect(desc).toContain("days");
    // must mention that it's a number, not an enum string
    expect(desc.toLowerCase()).toContain("number");
  });

  it("description clarifies it is NOT an enum string", async () => {
    const args = await getSearchSubArgs("jobs");
    const desc = args["date-posted"]?.description ?? "";
    // spec: "not an enum string"
    expect(desc).toContain("not an enum string");
  });
});

// ---------------------------------------------------------------------------
// search posts --date-posted help
// ---------------------------------------------------------------------------

describe("search posts --date-posted help text", () => {
  it("description names all three underscore-form windows", async () => {
    const args = await getSearchSubArgs("posts");
    const desc = args["date-posted"]?.description ?? "";
    expect(desc).toContain("past_day");
    expect(desc).toContain("past_week");
    expect(desc).toContain("past_month");
  });

  it("description mentions that hyphens are also accepted", async () => {
    const args = await getSearchSubArgs("posts");
    const desc = args["date-posted"]?.description ?? "";
    expect(desc).toContain("past-day");
    expect(desc).toContain("past-week");
    expect(desc).toContain("past-month");
  });
});

// ---------------------------------------------------------------------------
// search jobs --location / --region help
// ---------------------------------------------------------------------------

describe("search jobs --location help text", () => {
  it("description contains 'geo region id' and 'single id'", async () => {
    const args = await getSearchSubArgs("jobs");
    const desc = args["location"]?.description ?? "";
    expect(desc).toContain("geo region id");
    expect(desc).toContain("single id");
  });

  it("description mentions search parameters resolution", async () => {
    const args = await getSearchSubArgs("jobs");
    const desc = args["location"]?.description ?? "";
    expect(desc).toContain("search parameters");
  });

  it("description mentions 'region filter' (the body field)", async () => {
    const args = await getSearchSubArgs("jobs");
    const desc = args["location"]?.description ?? "";
    expect(desc).toContain("region filter");
  });
});

describe("search jobs --region help text", () => {
  it("description identifies it as alias for --location", async () => {
    const args = await getSearchSubArgs("jobs");
    const desc = args["region"]?.description ?? "";
    expect(desc.toLowerCase()).toContain("alias");
    expect(desc).toContain("--location");
  });

  it("description names the shared body field: region", async () => {
    const args = await getSearchSubArgs("jobs");
    const desc = args["region"]?.description ?? "";
    // spec: "same body field: region"
    expect(desc).toContain("region");
  });
});

// ---------------------------------------------------------------------------
// search --filters help (precedence + strip note)
// ---------------------------------------------------------------------------

describe("search --filters help text: precedence and strip note", () => {
  it("--filters on people command mentions named flags win on conflict", async () => {
    const args = await getSearchSubArgs("people");
    const desc = args["filters"]?.description ?? "";
    // Must state that named flags take precedence / win on conflict
    const lower = desc.toLowerCase();
    expect(lower.includes("named flags") || lower.includes("flag") || lower.includes("win") || lower.includes("override") || lower.includes("precedence")).toBe(true);
  });

  it("--filters on people command accurately warns the body is strict (rejects unknown fields, doesn't strip them)", async () => {
    const args = await getSearchSubArgs("people");
    const desc = args["filters"]?.description ?? "";
    const lower = desc.toLowerCase();
    // Must mention unknown fields are rejected (400), and must NOT claim the
    // server silently strips them — that claim is false (the body schema is
    // `.strict()`) and was shipped as customer-facing help text.
    expect(lower.includes("unknown")).toBe(true);
    expect(lower.includes("reject") || lower.includes("400") || lower.includes("strict")).toBe(true);
    expect(lower.includes("strips")).toBe(false);
  });

  it("--filters on jobs command mentions named flags win on conflict", async () => {
    const args = await getSearchSubArgs("jobs");
    const desc = args["filters"]?.description ?? "";
    const lower = desc.toLowerCase();
    expect(lower.includes("named flags") || lower.includes("flag") || lower.includes("win") || lower.includes("override") || lower.includes("precedence")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// search companies --has-job-offers / --headcount help
// ---------------------------------------------------------------------------

describe("search companies --has-job-offers / --headcount help text", () => {
  it("both flags exist on the companies subcommand", async () => {
    const args = await getSearchSubArgs("companies");
    expect(args["has-job-offers"]).toBeDefined();
    expect(args["headcount"]).toBeDefined();
  });

  it("--headcount description lists all 8 bucket names, with 10001+ flagged unsupported", async () => {
    const args = await getSearchSubArgs("companies");
    const desc = args["headcount"]?.description ?? "";
    for (const bucket of ["1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5001-10000", "10001+"]) {
      expect(desc).toContain(bucket);
    }
    expect(desc.toLowerCase()).toContain("not yet supported");
  });
});

// ---------------------------------------------------------------------------
// search jobs --title help
// ---------------------------------------------------------------------------

describe("search jobs --title help text", () => {
  it("flag exists on the jobs subcommand", async () => {
    const args = await getSearchSubArgs("jobs");
    expect(args["title"]).toBeDefined();
  });

  it("description references the JOB_TITLE resolve path and distinguishes from people --title", async () => {
    const args = await getSearchSubArgs("jobs");
    const desc = args["title"]?.description ?? "";
    expect(desc).toContain("search parameters --type JOB_TITLE");
    expect(desc.toLowerCase()).toContain("free-text");
  });
});

// ---------------------------------------------------------------------------
// search jobs additional named flags exist; --location-within-area
// present now that this WP implements it — help notes the --location requirement
// ---------------------------------------------------------------------------

describe("search jobs additional named flags help text", () => {
  it("presence/benefits/commitments/has-verifications/under-10-applicants/in-your-network/fair-chance-employer flags exist", async () => {
    const args = await getSearchSubArgs("jobs");
    for (const flag of [
      "presence",
      "benefits",
      "commitments",
      "has-verifications",
      "under-10-applicants",
      "in-your-network",
      "fair-chance-employer",
    ]) {
      expect(args[flag], `expected --${flag} to be defined`).toBeDefined();
    }
  });

  it("--location-within-area exists and notes it requires --location", async () => {
    const args = await getSearchSubArgs("jobs");
    expect(args["location-within-area"]).toBeDefined();
    const desc = args["location-within-area"]?.description ?? "";
    expect(desc).toContain("--location");
  });
});

// ---------------------------------------------------------------------------
// search people --connections-of / --followers-of resolve hints
// ---------------------------------------------------------------------------

describe("search people --connections-of / --followers-of help text", () => {
  it("--connections-of mentions --type CONNECTIONS", async () => {
    const args = await getSearchSubArgs("people");
    const desc = args["connections-of"]?.description ?? "";
    expect(desc).toContain("--type CONNECTIONS");
  });

  it("--followers-of mentions --type PEOPLE", async () => {
    const args = await getSearchSubArgs("people");
    const desc = args["followers-of"]?.description ?? "";
    expect(desc).toContain("--type PEOPLE");
  });
});

// ---------------------------------------------------------------------------
// search posts nested filter flags exist
// ---------------------------------------------------------------------------

describe("search posts nested filter flags help text", () => {
  it("all 8 flags exist on the posts subcommand", async () => {
    const args = await getSearchSubArgs("posts");
    for (const flag of [
      "posted-by-member",
      "posted-by-company",
      "posted-by-me",
      "mentioning-member",
      "mentioning-company",
      "author-industry",
      "author-company",
      "author-keywords",
    ]) {
      expect(args[flag], `expected --${flag} to be defined`).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Help-text-only corrections — spawn the built bin so the
// assertion covers the actual rendered --help output, not just the source.
// ---------------------------------------------------------------------------

describe("help-text-only corrections: --type / --seniority / --job-type / --content-type (built bin)", () => {
  beforeAll(() => {
    if (!existsSync(cliPath)) {
      execSync("node_modules/.bin/tsup", { cwd: pkgRoot, stdio: "ignore" });
    }
  });

  it("search parameters --help enumerates all 11 --type values", () => {
    const text = helpText(["search", "parameters"]);
    for (const token of [
      "LOCATION",
      "PEOPLE",
      "CONNECTIONS",
      "COMPANY",
      "SCHOOL",
      "INDUSTRY",
      "SERVICE",
      "JOB_FUNCTION",
      "JOB_TITLE",
      "EMPLOYMENT_TYPE",
      "SKILL",
    ]) {
      expect(text, `expected --type help to mention ${token}`).toContain(token);
    }
  });

  it("search jobs --help states the closed --seniority enum and never says 'ids'", () => {
    const text = helpText(["search", "jobs"]);
    for (const level of ["executive", "director", "mid_senior", "associate", "entry", "intern"]) {
      expect(text).toContain(level);
    }
    // Isolate the --seniority line so a stray "ids" on an unrelated flag doesn't false-positive.
    const seniorityLine = text.split("\n").find((l) => l.includes("--seniority")) ?? "";
    expect(seniorityLine.toLowerCase()).not.toContain("ids");
  });

  it("search jobs --help states the independent 7-value --job-type enum, no EMPLOYMENT_TYPE reference", () => {
    const text = helpText(["search", "jobs"]);
    for (const jobType of ["full_time", "part_time", "contract", "temporary", "volunteer", "internship", "other"]) {
      expect(text).toContain(jobType);
    }
    const jobTypeLine = text.split("\n").find((l) => l.includes("--job-type")) ?? "";
    expect(jobTypeLine).not.toContain("EMPLOYMENT_TYPE");
  });

  it("search posts --help lists the correct --content-type enum, not 'jobs'", () => {
    const text = helpText(["search", "posts"]);
    for (const contentType of ["videos", "images", "live_videos", "collaborative_articles", "documents"]) {
      expect(text).toContain(contentType);
    }
    const contentTypeLine = text.split("\n").find((l) => l.includes("--content-type")) ?? "";
    expect(contentTypeLine).not.toContain("jobs");
  });

  it("branding rename: search --help group description drops 'LinkedIn'", () => {
    const text = helpText(["search"]);
    expect(text).toContain("Search people, companies, posts, and jobs.");
  });

  it("branding rename: none of the 4 subcommand one-liners contain 'LinkedIn'", () => {
    for (const sub of ["people", "companies", "posts", "jobs"]) {
      const text = helpText(["search", sub]);
      // Isolate the one-line description (the first non-blank line under the
      // command usage banner) so an unrelated flag description elsewhere in
      // the same --help output can't false-positive this assertion.
      const oneLiner = text.split("\n").find((l) => l.trim().length > 0) ?? "";
      expect(oneLiner, `search ${sub} --help one-liner must not mention LinkedIn`).not.toMatch(/LinkedIn/i);
    }
  });

  // Scoped to the group + 4 subcommand one-line descriptions (the actual
  // branding-rename surface), not the full flag-by-flag --help dump: the dump
  // legitimately still carries "pasted LinkedIn search URL" on the group's bare
  // `search <url>` positional, which is untouched by design — only titles/
  // one-liners are in scope, not flag prose.
  it("branding rename: concat of the group + 4 subcommand one-liners has zero 'LinkedIn' matches", () => {
    const oneLiner = (text: string) => text.split("\n").find((l) => l.trim().length > 0) ?? "";
    const combined = [
      oneLiner(helpText(["search"])),
      oneLiner(helpText(["search", "people"])),
      oneLiner(helpText(["search", "companies"])),
      oneLiner(helpText(["search", "posts"])),
      oneLiner(helpText(["search", "jobs"])),
    ].join("\n");
    expect(combined).not.toMatch(/LinkedIn/i);
  });

  it("regression guard: search jobs --seniority ceo is still a client-side no-op passthrough (help-text-only change)", () => {
    // The CLI does not validate --seniority values client-side — it splits on
    // comma and passes the value through; the server rejects an invalid enum
    // value. Point at an unroutable host so the command fails on the network
    // call (not on any new client-side validation this FR might have
    // accidentally introduced), confirming behavior is unchanged.
    const r = spawnSync(
      process.execPath,
      [cliPath, "search", "jobs", "--seniority", "ceo", "--account", "acc_x", "--base-url", "http://127.0.0.1:1", "--json"],
      {
        encoding: "utf8",
        timeout: 15_000,
        env: { ...process.env, NODE_ENV: "production", TEST: "false", CI: "false", CURVIATE_API_KEY: "rdc_live_help_test_stub" },
      },
    );
    expect(r.status).not.toBe(2);
    expect(r.stdout + r.stderr).not.toMatch(/Unknown command/i);
  });
});
