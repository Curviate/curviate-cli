/**
 * Rules that hold for every command of a shape, swept over the live command
 * registry (`helpers/tree.ts`) through the CLI entry point against a recording
 * sink. Every refusal is paired with a same-path control that does send, so
 * "exit 2 / zero requests" cannot be satisfied by a command that never gets as
 * far as sending anything. A failure lists the offending commands.
 */
import { describe, it, expect } from "vitest";
import { useSink, type Reply, type ReplyFn } from "./helpers/sink.js";
import { argvFor, discoverCursorNodes, discoverStreamingNodes, discoverSweepVariants, type Node } from "./helpers/tree.js";

const PAGE: Reply = { body: { object: "list", id: "ACoAAB1234", items: [], cursor: null } };
const JSON_RAW = (body: string, status = 200): Reply => ({ status, type: "application/json", body });
const sink = useSink(PAGE);
const COMMON = ["--json", "--beta", "--account", "acc_1"];
const run = (argv: string[], reply: Reply | ReplyFn = PAGE) => {
  sink.reply = reply;
  return sink.run([...argv, ...COMMON]);
};
const SLOW = 180_000;

/** Run `check` per node; it returns a problem string or nothing. Fails with the list. */
async function sweep(nodes: Node[], check: (n: Node, argv: string[]) => Promise<string | void>) {
  expect(nodes.length, "the sweep covers a real surface").toBeGreaterThan(50);
  const bad: string[] = [];
  for (const n of nodes) {
    const problem = await check(n, argvFor(n));
    if (problem) bad.push(`${n.path.join(" ")}: ${problem}`);
  }
  expect(bad).toEqual([]);
}

describe("every streaming command (declares --all)", () => {
  it("a plain read of a null body is a platform fault, exit 7; a real page exits 0", { timeout: SLOW }, async () => {
    await sweep(await discoverStreamingNodes(), async (_n, argv) => {
      const bad = await run(argv, JSON_RAW("null"));
      const good = await run(argv);
      if (bad.status !== 7) return `null body exited ${bad.status}`;
      if (good.status !== 0) return `real page exited ${good.status}`;
    });
  });

  it("--max-pages must be a positive integer (exit 2); --max-pages=2 still streams", { timeout: SLOW }, async () => {
    await sweep(await discoverStreamingNodes(), async (_n, argv) => {
      for (const v of ["abc", "0", "-1", "2.5", ""]) {
        const r = await run([...argv, "--all", `--max-pages=${v}`, "--page-delay", "0"]);
        if (r.status !== 2 || !r.stderr.includes("--max-pages")) return `--max-pages=${JSON.stringify(v)} exited ${r.status}`;
      }
      const ok = await run([...argv, "--all", "--max-pages=2", "--page-delay", "0"]);
      if (ok.status !== 0 || ok.requests.length === 0) return `--max-pages=2 exited ${ok.status} after ${ok.requests.length} requests`;
    });
  });

  it("--max-pages / --page-delay without --all: exit 2, zero requests; with --all, or neither, they send", { timeout: SLOW }, async () => {
    await sweep(await discoverStreamingNodes(), async (_n, argv) => {
      for (const flag of [["--max-pages", "2"], ["--page-delay", "0"]]) {
        const r = await run([...argv, ...flag]);
        if (r.status !== 2 || r.requests.length || !r.stderr.includes(flag[0]!)) return `${flag[0]} without --all: exit ${r.status}, ${r.requests.length} requests`;
      }
      for (const extra of [["--all", "--max-pages", "2", "--page-delay", "0"], []]) {
        const r = await run([...argv, ...extra]);
        if (r.status !== 0 || r.requests.length === 0) return `${extra.join(" ") || "plain"} exited ${r.status}`;
      }
    });
  });
});

describe("every paginated command (declares --cursor)", () => {
  it('--cursor "" and "   " are a lost cursor: exit 2 naming the flag; a real value reaches the request', { timeout: SLOW }, async () => {
    const PROBE = "c_probe_9f3a2b";
    await sweep(await discoverCursorNodes(), async (_n, argv) => {
      for (const empty of ["", "   "]) {
        const r = await run([...argv, "--cursor", empty]);
        if (r.status !== 2 || !r.stderr.includes("--cursor")) return `--cursor ${JSON.stringify(empty)} exited ${r.status}`;
      }
      const ok = await run([...argv, "--cursor", PROBE]);
      if (ok.status !== 0 || !ok.requests.some((q) => (q.url + q.body).includes(PROBE))) return `a real cursor exited ${ok.status} and no request carried it`;
    });
  });
});

describe("--cursor / --limit are refused where the endpoint takes neither", () => {
  const url = "https://h.test/x";
  it.each([
    ["core", "company", "1"],
    ["core", "company", "chat", "1", "c1"],
    ["core", "company", "message", "1", "c1", "m1"],
    ["core", "post", "get", "p1"],
    ["core", "profile", "endorse", "x1", "--endorsement-id", "e1"],
    ["webhook", "get", "w1"],
    ["webhook", "delete", "w1"],
    ["webhook", "update", "w1"],
    ["webhook", "create", "--source", "messaging", "--request-url", url, "--account-ids", "acc_1"],
    ["webhook", "events"],
  ])("%s: unknown flag, exit 2, zero requests; the command itself works", async (...argv) => {
    for (const flag of [["--cursor", "c_1"], ["--limit", "5"]]) {
      const r = await run([...argv, ...flag]);
      expect([r.status, r.requests.length]).toEqual([2, 0]);
      expect(r.stderr).toContain(`unknown flag \`${flag[0]}\``);
    }
    const ok = await run(argv);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.requests.length).toBeGreaterThan(0);
  });

  it("recruiter search parameters takes --limit but not --cursor; recruiter applicants takes both", async () => {
    const params = ["core", "recruiter", "search", "parameters", "--source", "SEARCH", "--type", "LOCATION"];
    const bad = await run([...params, "--cursor", "c_1"]);
    expect([bad.status, bad.requests.length]).toEqual([2, 0]);
    expect(bad.stderr).toContain("unknown flag `--cursor`");
    expect((await run([...params, "--limit", "5"])).status).toBe(0);
    const applicants = ["core", "recruiter", "applicants", "x1", "--channel-id", "c1"];
    for (const flag of [["--cursor", "c_1"], ["--limit", "5"]]) {
      const r = await run([...applicants, ...flag]);
      expect([r.status, r.requests.length > 0]).toEqual([0, true]);
    }
  });
});

describe("a single-object read's 2xx must be a readable object", () => {
  const EMPTY = [JSON_RAW(""), JSON_RAW("", 204), JSON_RAW("{}")];
  const bodyless = (r: Reply) => ({ ...r, body: r.status === 204 ? undefined : r.body });

  it("every read-only leaf exits 7 on a null, empty or {} body", { timeout: SLOW }, async () => {
    const downloads = new Set(["core job applicant resume", "core message attachment", "core recruiter applicant resume"]);
    const variants = await discoverSweepVariants();
    expect(variants.length).toBeGreaterThanOrEqual(150);
    const bad: string[] = [];
    let reads = 0;
    let writes = 0;
    for (const v of variants) {
      const key = `${v.path.join(" ")} ${v.variant}`;
      const first = await run(v.argv, JSON_RAW("null"));
      const methods = first.requests.map((q) => q.method);
      if (!methods.length || downloads.has(v.path.join(" "))) continue;
      if (methods.some((m) => m !== "GET")) {
        writes++;
        continue;
      }
      reads++;
      if (first.status !== 7) bad.push(`${key}: null body exited ${first.status}`);
      for (const body of EMPTY) {
        const r = await run(v.argv, bodyless(body));
        if (r.status !== 7) bad.push(`${key}: ${body.status ?? 200} ${JSON.stringify(body.body)} exited ${r.status}`);
      }
    }
    expect(bad).toEqual([]);
    expect(reads, "control: the classifier finds the reads").toBeGreaterThan(80);
    expect(writes, "control: the classifier finds the writes").toBeGreaterThan(0);
  });

  it.each([
    ["core", "recruiter", "search", "parameters", "--source", "messaging", "--type", "LOCATION"],
  ])("%s: a POST-shaped read exits 7 on a null, empty, {} or non-JSON body", async (...argv) => {
    const first = await run(argv, JSON_RAW("null"));
    expect(first.requests.some((q) => q.method !== "GET")).toBe(true);
    expect(first.status).toBe(7);
    for (const body of [...EMPTY, { status: 200, type: "text/html", body: "<html>" }]) expect((await run(argv, bodyless(body))).status).toBe(7);
  });

  // The four commands whose answer carries the next step (STATE_WRITES): an unreadable 2xx stays exit 7,
  // but the request may have been applied, so the fault says how to check and never invites a retry.
  it.each([
    [["account", "checkpoint", "poll", "1"], "curviate account checkpoint poll <account_id>"],
    [["account", "checkpoint", "poll", "1", "--wait"], "curviate account checkpoint poll <account_id>"],
    [["account", "checkpoint", "solve", "1", "--code", "x"], "curviate account checkpoint poll <account_id>"],
    [["account", "checkpoint", "request", "1"], "curviate account checkpoint poll <account_id>"],
    [["account", "connect-session", "poll", "--session", "1"], "curviate account connect-session poll --session <session_id>"],
  ])("%j: exit 7 on a null, empty, {} or non-JSON 2xx, retryLikelyToSucceed false, check with %s", { timeout: 60_000 }, async (argv, recheck) => {
    for (const body of [JSON_RAW("null"), ...EMPTY, { status: 200, type: "text/html", body: "<html>" }]) {
      const r = await run(argv, bodyless(body));
      expect([r.status, r.requests.length > 0], `${body.status ?? 200} ${JSON.stringify(body.body)}`).toEqual([7, true]);
      expect(JSON.parse(r.stdout).error).toMatchObject({ code: "PLATFORM_ERROR", retryLikelyToSucceed: false, message: expect.stringContaining(`may have been applied: check with \`${recheck}\``) });
      expect(r.stderr).not.toContain("do not retry");
    }
  });

  it("a genuine write still renders a null, empty or {} response (exit 0)", async () => {
    for (const body of [JSON_RAW("null"), ...EMPTY]) {
      const r = await run(["core", "comment", "delete", "1", "1", "--verbose"], bodyless(body));
      expect(r.status, `${body.status ?? 200} ${JSON.stringify(body.body)}`).toBe(0);
    }
  });

  it("control: a valid object body exits 0", async () => {
    expect((await run(["core", "company", "1", "--verbose"], { body: { id: "ok_1", name: "ok" } })).status).toBe(0);
  });
});

