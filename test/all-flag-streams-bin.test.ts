/**
 * `--all` is declared only where it streams. Every command that declares it is
 * run with it against a stub page and must announce the NDJSON stream; every
 * command that does not stream refuses `--all` as an unknown flag (exit 2)
 * with zero requests. The streaming set is derived here, at run time, from
 * the command tree and the built bin, never from a hand list.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandDef } from "citty";
import { cliPath } from "./helpers/built-cli.js";

let server: Server;
let baseUrl: string;
let requests = 0;
const xdg = mkdtempSync(join(tmpdir(), "curviate-all-streams-"));

function run(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: xdg, NODE_ENV: "production" };
    delete env["CURVIATE_API_KEY"];
    delete env["CURVIATE_ACCOUNT"];
    delete env["CURVIATE_BASE_URL"];
    const child = spawn(process.execPath, [cliPath, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (status) => done({ status, stdout, stderr }));
    child.stdin.end("");
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    requests++;
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", id: "ACoAAB1234", items: [], cursor: null }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const asCmd = (c: unknown): CommandDef => c as CommandDef;
async function resolveValue<T>(input: T | (() => T) | (() => Promise<T>)): Promise<T> {
  return typeof input === "function" ? (input as () => T | Promise<T>)() : input;
}
type ArgDef = { type?: string; required?: boolean };
type Node = { path: string[]; defs: Record<string, ArgDef>; hasSubs: boolean };
async function walk(cmd: CommandDef, path: string[], out: Node[]) {
  const subs = (await resolveValue(cmd.subCommands ?? {})) as Record<string, unknown>;
  if (cmd.run) out.push({ path, defs: (await resolveValue(cmd.args ?? {})) as Record<string, ArgDef>, hasSubs: Object.keys(subs).length > 0 });
  for (const [name, sub] of Object.entries(subs)) await walk(asCmd(await resolveValue(sub as CommandDef)), [...path, name], out);
}

/** Values for required flags whose value is validated before any request. */
const FLAG_VALUES: Record<string, string> = {
  state: "OPEN", source: "messaging", type: "LOCATION", keywords: "xyz", "channel-id": "c1",
  "request-url": "https://h.test/x", "account-ids": "acc_1", "endorsement-id": "e1",
};
/** Where the default argv would not reach the stream: a URL-only form, a query minimum, a flag that selects the list. */
const OVERRIDES: Record<string, string[]> = {
  search: ["search", "https://www.linkedin.com/search/results/people/?keywords=x"],
  "recruiter search": ["recruiter", "search", "https://www.linkedin.com/talent/search?searchContextId=1"],
  "sales-nav search": ["sales-nav", "search", "https://www.linkedin.com/sales/search/people?query=x"],
  "inbox search": ["inbox", "search", "hello"],
  "search groups": ["search", "groups", "hello"],
  "company search-chats": ["company", "search-chats", "x1", "hello"],
  profile: ["profile", "x1", "--posts"],
  "profile me": ["profile", "me", "--posts"],
};

function argvFor(node: Node): string[] {
  const key = node.path.join(" ");
  if (OVERRIDES[key]) return OVERRIDES[key]!;
  const positionals = Object.values(node.defs).filter((d) => d.type === "positional" && d.required !== false).map(() => "x1");
  const required = Object.entries(node.defs)
    .filter(([, d]) => d.type !== "positional" && d.required)
    .flatMap(([name]) => [`--${name}`, FLAG_VALUES[name] ?? "x"]);
  return [...node.path, ...positionals, ...required];
}

const common = () => ["--json", "--page-delay", "0", "--beta", "--api-key", "cvt_test_x", "--account", "acc_1", "--base-url", baseUrl];

describe("--all is declared exactly where it streams", async () => {
  const groups: Array<[string, CommandDef]> = [
    ["account", asCmd((await import("../src/commands/account.js")).accountCommand)],
    ["comment", asCmd((await import("../src/commands/comment.js")).commentCommand)],
    ["company", asCmd((await import("../src/commands/company.js")).companyCommand)],
    ["connect", asCmd((await import("../src/commands/connect.js")).connectCommand)],
    ["feed", asCmd((await import("../src/commands/feed.js")).feedCommand)],
    ["group", asCmd((await import("../src/commands/group.js")).groupCommand)],
    ["inbox", asCmd((await import("../src/commands/inbox.js")).inboxCommand)],
    ["inboxes", asCmd((await import("../src/commands/inboxes.js")).inboxesCommand)],
    ["job", asCmd((await import("../src/commands/job.js")).jobCommand)],
    ["message", asCmd((await import("../src/commands/message.js")).messageCommand)],
    ["notification", asCmd((await import("../src/commands/notification.js")).notificationCommand)],
    ["post", asCmd((await import("../src/commands/post.js")).postCommand)],
    ["profile", asCmd((await import("../src/commands/profile.js")).profileCommand)],
    ["recruiter", asCmd((await import("../src/commands/recruiter.js")).recruiterCommand)],
    ["sales-nav", asCmd((await import("../src/commands/sales-nav.js")).salesNavCommand)],
    ["search", asCmd((await import("../src/commands/search.js")).searchCommand)],
    ["webhook", asCmd((await import("../src/commands/webhook.js")).webhookCommand)],
  ];
  const nodes: Node[] = [];
  for (const [name, cmd] of groups) await walk(cmd, [name], nodes);
  // A group that only prints its usage (no positional of its own) sends nothing either way.
  const usageOnly = (n: Node) => n.hasSubs && !Object.values(n.defs).some((d) => d.type === "positional") && !OVERRIDES[n.path.join(" ")];
  const declaring = nodes.filter((n) => "all" in n.defs && !usageOnly(n));

  it("the sweep covers the streaming surface", () => {
    expect(declaring.length).toBeGreaterThan(50);
  });

  for (const node of declaring) {
    it(`${node.path.join(" ")} --all streams NDJSON`, async () => {
      const r = await run([...argvFor(node), "--all", ...common()]);
      expect(r.stderr, `exit ${r.status}: ${r.stdout}`).toContain("--all streams NDJSON");
      expect(r.status, r.stderr).toBe(0);
    });
  }

  const REFUSED: string[][] = [
    ["recruiter", "applicants", "x1", "--channel-id", "c1"],
    ["recruiter", "search", "parameters", "--source", "messaging", "--type", "LOCATION"],
    ["sales-nav", "search", "parameters", "--type", "LOCATION"],
    ["search", "parameters", "--type", "LOCATION", "--keywords", "xyz"],
    ["search", "service-parameters", "--keywords", "xyz"],
    ["webhook", "get", "w1"],
    ["webhook", "delete", "w1"],
    ["webhook", "update", "w1"],
    ["webhook", "create", "--source", "messaging", "--request-url", "https://h.test/x", "--account-ids", "acc_1"],
    ["webhook", "events"],
    ["profile", "endorse", "x1", "--endorsement-id", "e1"],
    ["company", "x1"],
    ["company", "chat", "x1", "c1"],
    ["company", "message", "x1", "c1", "m1"],
    ["post", "get", "p1"],
  ];
  for (const argv of REFUSED) {
    it(`${argv.slice(0, 3).join(" ")} --all is an unknown flag: exit 2, zero requests; --max-pages and --page-delay too`, async () => {
      for (const flag of [["--all"], ["--max-pages", "2"], ["--page-delay", "0"]]) {
        requests = 0;
        const r = await run([...argv, ...flag, "--json", "--beta", "--api-key", "cvt_test_x", "--account", "acc_1", "--base-url", baseUrl]);
        expect(r.status, r.stdout + r.stderr).toBe(2);
        expect(r.stderr).toContain(`unknown flag \`${flag[0]}\``);
        expect(requests).toBe(0);
      }
      requests = 0;
      const control = await run([...argv, "--json", "--beta", "--api-key", "cvt_test_x", "--account", "acc_1", "--base-url", baseUrl]);
      expect(control.status, control.stdout + control.stderr).toBe(0);
      expect(requests).toBeGreaterThan(0);
    });
  }
});
