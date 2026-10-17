/**
 * `--all` truncation contract: the three-key JSON sentinel (last stdout line)
 * and the prose note on stderr are identical on every --all command. The text
 * lives only in lib/paginate.ts (source guard), and one representative command
 * per command file is driven through a real page-cap truncation. `search` is
 * covered in search.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runAccountList } from "../../src/commands/account.js";
import { runCommentList } from "../../src/commands/comment.js";
import { runCompanyEmployees } from "../../src/commands/company.js";
import { runConnectSent } from "../../src/commands/connect.js";
import { runInboxList } from "../../src/commands/inbox.js";
import { runJobList } from "../../src/commands/job.js";
import { runPostUserPosts } from "../../src/commands/post.js";
import { runProfileMe } from "../../src/commands/profile.js";
import { runRecruiterListProjects } from "../../src/commands/recruiter.js";
import { runSalesNavAccountLists } from "../../src/commands/sales-nav.js";
import { runWebhookList } from "../../src/commands/webhook.js";
import { jsonLines, mkOut, written } from "../helpers/f4-unit.js";

const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/commands");
const sources = readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => [f, readFileSync(join(dir, f), "utf8")] as const);

describe("--all truncation contract: source", () => {
  it("the sentinel and the prose note are written only by lib/paginate.ts; every streamAll call passes `out` and `pageDelayMs`", () => {
    expect(sources.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const [file, src] of sources) {
      if (src.includes("stream_truncated") || src.includes("Streaming truncated at")) offenders.push(`${file}: hand-rolled truncation output`);
      for (const m of src.matchAll(/streamAll\(/g)) {
        const w = src.slice(m.index, m.index! + 220);
        if (!/union-aggregate-no-out/.test(w) && !/\bout\b/.test(w)) offenders.push(`${file}@${m.index}: streamAll without out`);
        if (!/pageDelayMs\b/.test(w)) offenders.push(`${file}@${m.index}: streamAll without pageDelayMs`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("--all --max-pages 1 truncates with sentinel + stderr note", () => {
  // [label, run fn, SDK namespace path to the paged method, flags]
  const CASES: Array<[string, unknown, string[], Record<string, unknown>]> = [
    ["account list", runAccountList, ["accounts", "list"], {}],
    ["comment list", runCommentList, ["posts", "listComments"], { postId: "p1" }],
    ["company employees (numeric id: no slug lookup)", runCompanyEmployees, ["companies", "employees"], { id: "112013061" }],
    ["connect sent", runConnectSent, ["invites", "listSent"], {}],
    ["inbox list", runInboxList, ["messaging", "listChats"], {}],
    ["job list --state OPEN", runJobList, ["jobs", "list"], { state: "OPEN" }],
    ["post user-posts me", runPostUserPosts, ["posts", "listUserPosts"], { userId: "me" }],
    ["profile me --posts", runProfileMe, ["posts", "listUserPosts"], { posts: true }],
    ["recruiter projects", runRecruiterListProjects, ["recruiter", "listProjects"], {}],
    ["sales-nav account-lists", runSalesNavAccountLists, ["salesNavigator", "accountLists"], {}],
    ["webhook list", runWebhookList, ["webhooks", "list"], {}],
  ];

  it.each(CASES)("%s", async (_n, fn, path, extra) => {
    const spy = vi.fn().mockResolvedValueOnce({ items: [{ id: "x1" }], cursor: "c1" });
    const leaf = path.reduceRight<unknown>((inner, key) => ({ [key]: inner }), spy);
    const rooted = ["accounts", "webhooks"].includes(path[0]!);
    const client = rooted ? leaf : { account: vi.fn().mockReturnValue(leaf) };
    const out = mkOut();
    await (fn as (...a: unknown[]) => Promise<void>)(client, { account: "acc_1", all: true, "max-pages": "1", ...extra }, out);
    const lines = jsonLines(out);
    expect(lines.at(-1)).toEqual({ object: "stream_truncated", pages_fetched: 1, has_more: true });
    expect(written(out.stderr)).toMatch(/truncat/i);
  });
});
