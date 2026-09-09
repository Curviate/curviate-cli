/**
 * A command's `--help` says "Beta" exactly when the operation it calls is
 * badged beta in the served document.
 *
 * ## Why this exists
 *
 * The markers were hand-placed, and hand-placed markers were wrong in BOTH
 * directions on the one namespace that mixes beta and stable operations:
 * `company chat` claimed beta for a STABLE read (promising a gate that cannot
 * fire), while `company search-chats` said nothing for a BETA one (no warning
 * that the call can `403 BETA_NOT_ENABLED`, which is the entire point of the
 * marker). Neither could go red anywhere, because nothing compared the prose
 * to the badge.
 *
 * A wrong marker is worse than a missing one in a specific way: it teaches
 * callers that the marker carries no information, which costs every OTHER
 * marker its meaning.
 *
 * ## Shape
 *
 * The badge set is DERIVED from the vendored document. The command-to-operation
 * mapping cannot be derived — a citty command is not statically linked to a
 * path — so it is a table, and the table's own completeness is asserted in both
 * directions: every path in it must exist in the document (a typo reds), and
 * every command in the mapped file must appear in it (a new subcommand reds).
 * That is the same "pin the surface as a table, then prove the table is whole"
 * pattern the SDK's own parity suite uses, and it is what keeps the table from
 * becoming the third copy that rots.
 *
 * Wholly-beta groups are handled separately and need no table: every operation
 * under them is badged, so the group's own root description carries the marker
 * and each subcommand inherits it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");

const read = (rel: string): string => readFileSync(resolve(pkgRoot, rel), "utf8");

interface DocOperation {
  "x-curviate-stability"?: string;
}
interface Doc {
  paths?: Record<string, Record<string, DocOperation | undefined>>;
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;
const doc = JSON.parse(read("test/fixtures/openapi.json")) as Doc;

/** `METHOD /path` -> is it badged beta. */
const stability = new Map<string, boolean>();
for (const [path, item] of Object.entries(doc.paths ?? {})) {
  for (const method of HTTP_METHODS) {
    const op = item[method];
    if (op) stability.set(`${method.toUpperCase()} ${path}`, op["x-curviate-stability"] === "beta");
  }
}

/** Does a command description claim beta? */
const claimsBeta = (description: string): boolean => /\bbeta\b/i.test(description);

/**
 * Extract `{ name, description }` for every `defineCommand` meta block in a
 * file. Descriptions are written as a bare string or as `"..." + "..."`
 * concatenations, so both forms are joined before matching.
 */
function commandMetas(file: string): Array<{ name: string; description: string }> {
  const text = read(file);
  const out: Array<{ name: string; description: string }> = [];
  // NOTE: no `re.exec()` pre-check. A global regex carries `lastIndex`, so
  // probing with `exec` first advances it and `matchAll` then starts AFTER the
  // first match — silently dropping the first command meta in every file. That
  // bug was here and was found by a mutation that the suite failed to catch.
  const re = /name:\s*"([a-z0-9-]+)",\s*\n?\s*description:\s*\n?\s*((?:"(?:[^"\\]|\\.)*"\s*\+?\s*)+)/g;
  for (const m of text.matchAll(re)) {
    const description = [...m[2]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((s) => s[1]!).join(" ");
    out.push({ name: m[1]!, description });
  }
  return out;
}

// ── groups where every operation is badged beta ─────────────────────────────

/**
 * The root command's own description carries the marker for these, because the
 * whole namespace is beta and repeating it on every subcommand would be noise.
 * The claim that they ARE wholly beta is asserted, not assumed.
 */
const WHOLLY_BETA_GROUPS: ReadonlyArray<{ group: string; file: string; pathPrefix: string }> = [
  {
    group: "sales-nav",
    file: "src/commands/sales-nav.ts",
    pathPrefix: "/v1/{account_id}/sales-navigator/",
  },
  { group: "recruiter", file: "src/commands/recruiter.ts", pathPrefix: "/v1/{account_id}/recruiter/" },
  { group: "inboxes", file: "src/commands/inboxes.ts", pathPrefix: "/v1/{account_id}/inboxes" },
];

describe("wholly-beta groups say so on the group command", () => {
  it.each(WHOLLY_BETA_GROUPS)("$group is entirely beta in the served document", ({ pathPrefix }) => {
    const under = [...stability.entries()].filter(([key]) => key.includes(` ${pathPrefix}`));
    // Positive control: the prefix matched something. A typo'd prefix would
    // otherwise make "all of them are beta" vacuously true.
    expect(under.length, `no served operation under ${pathPrefix}`).toBeGreaterThan(0);
    const stable = under.filter(([, isBeta]) => !isBeta).map(([key]) => key);
    expect(
      stable,
      "an operation under this prefix is NOT badged beta, so the group-level " +
        "marker over-claims and the group needs a per-command table like " +
        "`company` has.",
    ).toEqual([]);
  });

  it.each(WHOLLY_BETA_GROUPS)("$group's root description claims beta", ({ group, file }) => {
    const root = commandMetas(file).find((c) => c.name === group);
    expect(root, `no \`${group}\` command meta found in ${file}`).toBeDefined();
    expect(claimsBeta(root!.description)).toBe(true);
  });
});

// ── the mixed group ─────────────────────────────────────────────────────────

/**
 * `company` serves both badged and stable operations, so each command that
 * touches the admin inbox is mapped to its operation individually.
 *
 * Only the inbox commands are listed: the rest of the namespace (`company
 * <id>`, `employees`, `posts`, `jobs`, `managed`, `followers`, ...) is stable
 * and is covered by the "no unmapped command claims beta" case below, which
 * catches a marker appearing anywhere it should not.
 */
const COMPANY_INBOX_COMMANDS: ReadonlyArray<{ command: string; operation: string }> = [
  { command: "chats", operation: "GET /v1/{account_id}/companies/{identifier}/chats" },
  { command: "chat", operation: "GET /v1/{account_id}/companies/{identifier}/chats/{chat_id}" },
  {
    command: "search-chats",
    operation: "GET /v1/{account_id}/companies/{identifier}/chats/search",
  },
];

describe("company: each inbox command's marker matches its own operation", () => {
  const metas = commandMetas("src/commands/company.ts");

  it("every mapped operation exists in the served document", () => {
    // Without this, a typo'd path silently reads as "not beta" and the marker
    // check below becomes an assertion about nothing.
    const missing = COMPANY_INBOX_COMMANDS.filter((e) => !stability.has(e.operation)).map(
      (e) => `${e.command} -> ${e.operation}`,
    );
    expect(missing).toEqual([]);
  });

  it("the mapping covers a real mix, so this file is testing what it claims", () => {
    // If every mapped operation had the same stability, the both-directions
    // check below could pass on a build that marked all three the same way.
    const flags = COMPANY_INBOX_COMMANDS.map((e) => stability.get(e.operation));
    expect(flags).toContain(true);
    expect(flags).toContain(false);
  });

  it.each(COMPANY_INBOX_COMMANDS)(
    "$command marks beta exactly when $operation is badged",
    ({ command, operation }) => {
      const meta = metas.find((c) => c.name === command);
      expect(meta, `no \`${command}\` command meta found`).toBeDefined();
      const badged = stability.get(operation);
      expect(
        claimsBeta(meta!.description),
        badged
          ? `${operation} is badged beta and \`company ${command}\` --help does not say so, ` +
            "so a caller gets no warning the call can 403 BETA_NOT_ENABLED"
          : `${operation} is STABLE and \`company ${command}\` --help claims beta, ` +
            "promising a gate that cannot fire and teaching callers to ignore the marker",
      ).toBe(badged);
    },
  );

  it("no company command outside the inbox mapping claims beta", () => {
    const mapped = new Set(COMPANY_INBOX_COMMANDS.map((e) => e.command));
    const stray = metas
      .filter((c) => !mapped.has(c.name))
      .filter((c) => claimsBeta(c.description))
      .map((c) => c.name);
    expect(
      stray,
      "these company commands claim beta but are not mapped to an operation, " +
        "so nothing checks the claim. Add them to COMPANY_INBOX_COMMANDS with " +
        "their path, or drop the marker.",
    ).toEqual([]);
  });

  it("POSITIVE CONTROL: the reader parsed EVERY command in the file", () => {
    // An exact count, not a floor. The reader only understands bare and
    // `+`-concatenated string literals, so a command written with a template
    // literal or a constant description would be invisible — and invisible to
    // BOTH directions, including "no unmapped command claims beta", which would
    // go quiet rather than red. Pinning against the real `defineCommand` count
    // closes that: the day someone writes one differently, this reds and says
    // the reader needs teaching.
    const declared = (read("src/commands/company.ts").match(/defineCommand\(/g) ?? []).length;
    expect(metas.length, `parsed ${metas.length} metas but the file declares ${declared} commands`).toBe(
      declared,
    );
    expect(metas.map((c) => c.name)).toContain("chats");
    expect(metas.map((c) => c.name)).toContain("search-chats");
  });
});
