/**
 * The pre-router (`src/dispatch.ts`): which leaf a token list resolves to, what
 * survives the descent, and what is refused (exit 2) instead of silently
 * swallowed. `resolveLeaf` is asserted directly where the decision itself is
 * the subject, and through the CLI entry point (against a recording sink) where
 * the wire is. Usage errors never echo a user-supplied token.
 */
import { describe, it, expect, vi } from "vitest";
import type { CommandDef } from "citty";
import { firstSentenceHint, resolveLeaf } from "../src/dispatch.js";
import { guardBareMessageForm } from "../src/commands/message.js";
import { guardBareConnectForm } from "../src/commands/connect.js";
import { main } from "../src/main.js";
import { exitCode } from "./helpers/exit-code.js";
import { runCli } from "./helpers/run-inproc.js";
import { useSink, line } from "./helpers/sink.js";
import { allNodes } from "./helpers/tree.js";

/** A group by its path under the root (`account`, `core profile`). */
const group = async (path: string) => {
  let cmd = main as CommandDef;
  for (const name of path.split(" ")) cmd = (await (cmd.subCommands as Record<string, () => Promise<CommandDef>>)[name]!()) as CommandDef;
  return cmd;
};
const nameOf = async (c: CommandDef) => ((typeof c.meta === "function" ? await (c.meta as () => Promise<unknown>)() : c.meta) as { name?: string }).name;
const resolve = async (g: string, args: string[]) => {
  const r = await resolveLeaf(await group(g), args, { path: ["curviate", ...g.split(" ")] });
  return { leaf: await nameOf(r.leaf), args: r.leafArgs };
};
/** resolveLeaf must exit 2; returns what it wrote to stderr. */
async function usage(g: string, args: string[]): Promise<string> {
  const written: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => (written.push(String(s)), true));
  try {
    expect(await exitCode(async () => resolveLeaf(await group(g), args, { path: ["curviate", ...g.split(" ")] })), `${g} ${args.join(" ")}`).toBe(2);
  } finally {
    spy.mockRestore();
  }
  return written.join("");
}

describe("id-first reroute and the bare form", () => {
  it.each([
    ["core company", ["1035", "employees"], "employees", ["1035"]],
    ["core company", ["t-systems", "posts"], "posts", ["t-systems"]],
    ["core company", ["1035", "jobs"], "jobs", ["1035"]],
    ["core company", ["1035", "employees", "--keywords", "eng"], "employees", ["1035", "--keywords", "eng"]],
    ["core company", ["1035", "employees", "--account", "acc_x"], "employees", ["1035", "--account", "acc_x"]],
    ["core profile", ["jdoe", "followers"], "followers", ["jdoe"]],
    ["core company", ["--api-key", "X", "1035", "employees"], "employees", ["--api-key", "X", "1035"]],
  ])("%s %j reroutes to the named subcommand, id and leading flags kept", async (g, args, leaf, got) => {
    expect(await resolve(g, args)).toEqual({ leaf, args: got });
  });

  it.each([
    ["core company", ["1035"], "company"],
    ["core company", ["1035", "--account", "acc_x"], "company"],
    ["core message", ["chat_9", "hello world"], "message"],
    ["core connect", ["john-doe"], "connect"],
    ["core connect", ["--", "-not-a-flag"], "connect"],
    ["core connect", ["--note", "-foo", "jdoe"], "connect"],
  ])("%s %j with no extra stays the bare node, args intact", async (g, args, leaf) => {
    expect(await resolve(g, args)).toEqual({ leaf, args });
  });

  it.each([
    ["core company", ["1035", "bogus"]],
    ["core connect", ["jdoe", "bogus"]],
    ["core message", ["chat_9", "hi", "bogus"]],
    ["core profile", ["jdoe", "bogus"]],
    ["core connect", ["--api-key", "X", "jdoe", "bogus"]],
    ["account", ["--api-key", "X", "bogus-sub"]],
    ...["constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf"].map((t): [string, string[]] => ["account", [t]]),
  ])("%s %j is refused (exit 2), never swallowed", async (g, args) => {
    await usage(g, args);
  });
});

describe("a leading global flag and a dash-prefixed value", () => {
  it.each([
    ["account", ["--api-key", "X", "list"], "list", ["--api-key", "X"]],
    ["webhook", ["--api-key", "X", "list"], "list", ["--api-key", "X"]],
    ["account", ["--api-key", "X", "--account", "acc_1", "list"], "list", ["--api-key", "X", "--account", "acc_1"]],
    ["account", ["checkpoint", "--api-key", "X", "solve", "acc_1", "--code", "123456"], "solve", ["--api-key", "X", "acc_1", "--code", "123456"]],
    ["core connect", ["--api-key", "X", "accept", "123"], "accept", ["--api-key", "X", "123"]],
    ["account", ["--json", "list"], "list", ["--json"]],
    ["account", ["--api-key", "-something", "list"], "list", ["--api-key", "-something"]],
    ["account", ["--api-key=X", "list"], "list", ["--api-key=X"]],
    ["account", ["--api-key", "X", "--api-key", "Y", "list"], "list", ["--api-key", "X", "--api-key", "Y"]],
    ["account", ["--api-key", "-", "list"], "list", ["--api-key", "-"]],
    ["account", ["--", "list"], "list", ["--"]],
    ["core connect", ["--note", "--json", "jdoe"], "connect", ["--note", "--json", "jdoe"]],
  ])("%s %j routes to %s with %j", async (g, args, leaf, got) => {
    expect(await resolve(g, args)).toEqual({ leaf, args: got });
  });
});

describe("a resolved leaf never discards an unconsumed positional", () => {
  it("`profile me relations` (the reported case) names the replacement; flags do not launder the extra", async () => {
    const err = await usage("core profile", ["me", "relations"]);
    for (const s of ["relations", "curviate core profile me", "curviate core profile relations"]) expect(err).toContain(s);
    expect(await usage("core profile", ["me", "relations", "--limit", "3", "--json"])).toContain("relations");
    expect(await usage("core profile", ["me", "relations", "extra1", "extra2"])).toContain("relations");
    const any = await usage("core profile", ["me", "zzzz-not-a-command"]);
    expect(any).not.toContain("zzzz-not-a-command");
    expect(any).toMatch(/unexpected argument 1 after `curviate core profile me`/);
    expect(any).not.toContain("Did you mean");
  });

  it.each([
    ["login", ["zzz-extra"], "curviate login"],
    ["core profile", ["me", "zzz-extra"], "curviate core profile me"],
    ["core search", ["parameters", "zzz-extra"], "curviate core search parameters"],
    ["webhook", ["list", "zzz-extra"], "curviate webhook list"],
    ["core feed", ["home", "zzz-extra"], "curviate core feed home"],
    ["account", ["checkpoint", "solve", "acc_1", "zzz-extra"], "curviate account checkpoint solve"],
    ["core job", ["applicant", "get", "job_1", "app_1", "zzz-extra"], "curviate core job applicant get"],
    ["core recruiter", ["project-job", "budget", "proj_1", "job_1", "zzz-extra"], "curviate core recruiter project-job budget"],
    ["core sales-nav", ["search", "people", "zzz-extra"], "curviate core sales-nav search people"],
    ["core profile", ["followers", "jdoe", "zzz-extra"], "curviate core profile followers"],
    ["core comment", ["reply", "p1", "c1", "text", "zzz-extra"], "curviate core comment reply"],
    ["core message", ["send", "chat_1", "hello", "zzz-extra"], "curviate core message send"],
    ["core company", ["1035", "managed"], "curviate core company managed"],
    ["core profile", ["jdoe", "subscription"], "curviate core profile subscription"],
    ["core search", ["some-url", "parameters"], "curviate core search parameters"],
    ["core company", ["1035", "zzz-bogus"], "curviate core company"],
  ])("%s %j: exit 2 naming the position and the resolved form, never the token", async (g, args, path) => {
    const err = await usage(g, args);
    expect(err).not.toContain(args.find((a) => a.startsWith("zzz") || a === "1035" || a === "jdoe" || a === "some-url")!);
    expect(err).toMatch(/unexpected argument \d+ after/);
    expect(err).toContain(path);
  });

  it.each([
    ["core profile", ["me"], "me", []], ["core profile", ["me", "--posts"], "me", ["--posts"]],
    ["core profile", ["me", "--sections", "skills"], "me", ["--sections", "skills"]],
    ["core profile", ["relations", "--limit", "3"], "relations", ["--limit", "3"]], ["core profile", ["followers", "jdoe"], "followers", ["jdoe"]],
    ["core profile", ["followers", "jdoe", "--account", "relations"], "followers", ["jdoe", "--account", "relations"]],
    ["core company", ["employees", "1035", "--keywords", "eng"], "employees", ["1035", "--keywords", "eng"]],
    ["core message", ["send", "chat_1", "hello world"], "send", ["chat_1", "hello world"]],
    ["core message", ["react", "c1", "m1", "thumb"], "react", ["c1", "m1", "thumb"]],
    ["core message", ["send", "chat_1", "-"], "send", ["chat_1", "-"]],
    ["config", ["rename", "old", "new"], "rename", ["old", "new"]],
    ["core recruiter", ["project-job", "budget", "p1", "j1"], "budget", ["p1", "j1"]],
    ["account", ["checkpoint", "solve", "acc_1"], "solve", ["acc_1"]], ["core inbox", ["messages", "chat_1"], "messages", ["chat_1"]],
    ["core inboxes", ["chats", "in_1"], "chats", ["in_1"]], ["core group", ["members", "g1"], "members", ["g1"]],
    ["core notification", ["list"], "list", []], ["core post", ["user-posts", "me"], "user-posts", ["me"]], ["core connect", ["accept", "inv_1"], "accept", ["inv_1"]],
    ["core feed", ["home", "--limit", "5"], "home", ["--limit", "5"]],
    ["webhook", ["verify", "--file", "-", "--secret", "s"], "verify", ["--file", "-", "--secret", "s"]],
  ])("legitimate form %s %j still resolves, args intact", async (g, args, leaf, got) => {
    expect(await resolve(g, args)).toEqual({ leaf, args: got });
  });
});

describe("the command tree", () => {
  it("no registry maps two keys to one command, and no group names a default subcommand", async () => {
    const problems: string[] = [];
    const seen = new Map<string, Map<unknown, string>>();
    for (const n of await allNodes(true)) {
      const node = n.cmd as unknown as Record<string, unknown>;
      if (node["defaultSubCommand"] !== undefined || node["default"] !== undefined) problems.push(`${n.path.join(" ")} names a default`);
      const subs = (await (typeof n.cmd.subCommands === "function" ? (n.cmd.subCommands as () => unknown)() : n.cmd.subCommands)) as Record<string, unknown> | undefined;
      const byCmd = new Map<unknown, string>();
      seen.set(n.path.join(" "), byCmd);
      for (const [key, v] of Object.entries(subs ?? {})) {
        const resolved = typeof v === "function" ? await (v as () => unknown)() : v;
        if (byCmd.has(resolved)) problems.push(`${n.path.join(" ")}: ${byCmd.get(resolved)} and ${key}`);
        byCmd.set(resolved, key);
      }
    }
    expect(problems).toEqual([]);
  });

  it("the bare forms reachable by an unregistered first token are exactly the audited ones; the two that write are guarded", async () => {
    const reachable = (await allNodes(true))
      .filter((n) => n.hasSubs && n.run && Object.values(n.defs).some((d) => d.type === "positional"))
      .map((n) => n.path.join(" "))
      .sort();
    // reads: a typo costs a round trip. writes (message, connect): guarded, see bare-form-guard.ts.
    expect(reachable).toEqual(["core company", "core connect", "core message", "core profile", "core recruiter applicant", "core recruiter project", "core recruiter project-job", "core recruiter search", "core sales-nav search", "core search"]);
    expect([typeof guardBareMessageForm, typeof guardBareConnectForm]).toEqual(["function", "function"]);
  });

  it("the missing-argument hint is the first complete sentence of the description", async () => {
    const balanced = (s: string) => {
      let d = 0;
      for (const ch of s) {
        if (ch === "(") d++;
        if (ch === ")" && --d < 0) return false;
      }
      return d === 0;
    };
    expect([
      firstSentenceHint("A (e.g. x. y) thing. Second."), firstSentenceHint("Use it, incl. this one. Then more."),
      firstSentenceHint("Filter by state (required): A|B. More."), firstSentenceHint("No terminal period"), firstSentenceHint("Ends with vs. other. Next."),
    ]).toEqual(["A (e.g. x. y) thing.", "Use it, incl. this one.", "Filter by state: A|B.", "No terminal period", "Ends with vs. other."]);
    const required = (await allNodes(true)).flatMap((n) => Object.values(n.defs).filter((d) => d.required && d.type !== "positional" && d.description).map((d) => d.description!));
    expect(required.length).toBeGreaterThan(30);
    expect(required.map(firstSentenceHint).filter((h) => !balanced(h))).toEqual([]);
    for (const [args, flag] of [[["core", "message", "new"], "--to"], [["core", "search", "service-parameters"], "--keywords"], [["core", "recruiter", "search", "parameters", "--source", "SEARCH"], "--type"]] as const) {
      const r = await runCli([...args]);
      const hint = r.stderr.split("\n").find((l) => l.startsWith(`hint: ${flag}: `));
      expect([r.status, hint !== undefined && balanced(hint) && /[.!?)]$/.test(hint)]).toEqual([2, true]);
    }
  });
});

describe("through the entry point", () => {
  const sink = useSink({ body: { object: "list", items: [], cursor: null, id: "x1", provider_id: "p" } });
  const A = ["--account", "acc_x", "--json"];

  it.each([
    [["core", "profile", "jdoe"], "GET /v1/acc_x/users/jdoe"],
    [["core", "profile", "jdoe", "--posts"], "GET /v1/acc_x/users/jdoe/posts"],
    [["core", "profile", "https://www.linkedin.com/in/jdoe/", "--posts"], "GET /v1/acc_x/users/jdoe/posts"],
    [["core", "profile", "me"], "GET /v1/acc_x/users/me"],
    [["core", "profile", "relations", "--limit", "3"], "GET /v1/acc_x/profiles/relations"],
    [["core", "company", "t-systems"], "GET /v1/acc_x/companies/t-systems"],
    [["core", "company", "employees", "112013061"], "GET /v1/acc_x/companies/112013061/employees"],
    [["core", "company", "112013061", "employees"], "GET /v1/acc_x/companies/112013061/employees"],
    [["core", "company", "112013061", "posts"], "GET /v1/acc_x/companies/112013061/posts"],
    [["core", "company", "112013061", "jobs"], "GET /v1/acc_x/companies/112013061/jobs"],
    [["core", "connect", "sent"], "GET /v1/acc_x/invites/sent"],
    [["core", "job", "get", "https://www.linkedin.com/jobs/view/4428113858"], "GET /v1/acc_x/jobs/4428113858"],
    [["core", "recruiter", "job", "get", "4428113858"], "GET /v1/acc_x/recruiter/jobs/4428113858"],
    [["core", "recruiter", "applicants", "proj_99", "--channel-id", "ch_1"], "POST /v1/acc_x/recruiter/projects/proj_99/talent-pool/applicants"],
    [["account", "list"], "GET /v1/accounts"],
  ])("%j reaches %s", async (args, request) => {
    const r = await sink.run([...args, ...A]);
    expect([r.status, r.requests.map(line)], r.stderr).toEqual([0, [request]]);
  });

  it.each([
    [["core", "connect", "jdoe", "--note", "hi"], "invites.send"],
    [["core", "message", "chat_9", "hi"], "messaging.sendMessage"],
    [["core", "message", "new", "--to", "ACo123", "hello"], "messaging.startChat"],
    [["webhook", "create", "--source", "messaging", "--request-url", "https://example.com/hook", "--account-ids", "acc_1"], "create"],
  ])("%j --preview renders only %s, one line, nothing on stderr", async (args, method) => {
    const r = await sink.run([...args, "--preview", "--account", "acc_x"]);
    expect([r.status, r.requests, r.stderr.trim()]).toEqual([0, [], ""]);
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    expect(r.stdout).toContain(method);
  });

  it("flags that look like negation: a literally declared --no-interactive and citty's --no-json fallback are accepted", async () => {
    const link = await sink.run(["account", "link", "--seat-id", "seat_1", "--auth-method", "credentials", "--country", "US", "--email", "otp@example.com", "--password", "test-password", "--no-interactive", "--preview"]);
    expect([link.status, link.stderr.includes("unknown flag")]).toEqual([0, false]);
    expect(link.stdout).toContain("auth.intent");
    const neg = await sink.run(["core", "connect", "jdoe", "--note", "hi", "--preview", "--account", "acc_x", "--no-json"]);
    expect([neg.status, neg.stdout.includes("invites.send")]).toEqual([0, true]);
  });

  it.each([
    [["bogus-command"], ""],
    [["account", "bogus-sub"], ""],
    [["core", "profile", "me", "--no-such-flag", "--account", "acc_x"], ""],
    [["webhook", "create"], ""],
    [["core", "company", "1035", "bogus", "--account", "acc_x"], "unexpected argument 2 after"],
    [["core", "profile", "jdoe", "bogus", "--account", "acc_x"], ""],
    [["core", "connect"], "Usage: curviate core connect"],
    [["core", "profile", "me", "--fields", "", "--account", "acc_x"], ""],
    [["core", "profile", "me", "relations"], "curviate core profile relations"],
    [["core", "profile", "me", "relations", "--limit", "3", "--json"], "curviate core profile relations"],
    [["account", "list", "zzz-extra"], "curviate account list"],
  ])("%j exits 2 with no request and nothing on stdout", async (args, message) => {
    const r = await sink.run(args);
    expect([r.status, r.requests, r.stdout]).toEqual([2, [], ""]);
    expect(r.stderr).toContain(message);
  });

  it("a bare pure group prints its menu and exits 0; a bare intent-shaped command is exit 2 with usage on stderr", async () => {
    for (const g of ["job", "inbox", "post", "comment", "sales-nav", "recruiter", "group", "feed", "notification"]) {
      const r = await sink.run(["core", g]);
      expect([g, r.status, /^Usage: curviate core /m.test(r.stderr)]).toEqual([g, 0, true]);
    }
    for (const g of ["account", "webhook"]) expect((await sink.run([g])).status).toBe(0);
    for (const g of ["connect", "profile", "message", "search"]) {
      const r = await sink.run(["core", g]);
      expect([g, r.status, /^Usage: curviate core /m.test(r.stderr)]).toEqual([g, 2, true]);
    }
    expect((await sink.run(["core", "company"])).status).toBe(2);
  });

  it("the correct forms still work: exactly one request, exit 0", async () => {
    for (const args of [["core", "profile", "relations", "--limit", "3"], ["core", "profile", "me"], ["account", "list"], ["core", "company", "employees", "1035"], ["core", "company", "1035", "employees"]]) {
      const r = await sink.run([...args, ...A]);
      expect([r.status, r.requests.length, r.stderr.includes("unexpected argument")]).toEqual([0, 1, false]);
    }
  });

  it("a global flag before the subcommand is identical on the wire to the same flag after it", async () => {
    const wire = async (args: string[]) => {
      const r = await sink.run(args);
      return r.requests.map((q) => [q.method, q.url, q.headers.authorization]);
    };
    const solve = ["account", "checkpoint", "solve", "acc_1", "--code", "123456"];
    expect(await wire(["--api-key", "cvt_fixture", "account", "list"])).toEqual(await wire(["account", "list", "--api-key", "cvt_fixture"]));
    expect(await wire(["--api-key", "cvt_fixture", ...solve])).toEqual(await wire([...solve, "--api-key", "cvt_fixture"]));
    expect(await wire(["account", "list", "--api-key", "cvt_fixture"])).toEqual([["GET", "/v1/accounts", "Bearer cvt_fixture"]]);
  });

  it("a value beginning with '-' is a value, verbatim on the wire; a declared flag name after a flag stays its own flag", async () => {
    expect((await sink.run(["account", "list", "--api-key", "-fixture-dash-value"])).requests[0]!.headers.authorization).toBe("Bearer -fixture-dash-value");
    expect((await sink.run(["--api-key", "-fixture-dash-value", "account", "list"])).requests[0]!.headers.authorization).toBe("Bearer -fixture-dash-value");
    expect((await sink.run(["account", "list", "--cursor", "-c5"])).requests[0]!.url).toBe("/v1/accounts?cursor=-c5");
    // `--json` is not swallowed as --limit's value; --limit is then left without one: refused, nothing sent.
    const bare = await sink.run(["account", "list", "--limit", "--json"]);
    expect([bare.status, bare.requests.length, bare.stderr]).toEqual([2, 0, expect.stringContaining("--limit must be a whole number")]);
  });
});
