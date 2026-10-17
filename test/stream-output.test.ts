/**
 * --all and the output envelope through the CLI entry point: `--all` is
 * declared exactly where it streams (derived from the live command tree),
 * `--fields` projects each NDJSON item while keeping the preserved keys, and a
 * page notice survives a command's slim projector.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { argvFor, discoverStreamingNodes } from "./helpers/streaming-nodes.js";
import { useSink } from "./helpers/sink.js";

const sink = useSink({ body: { object: "list", id: "ACoAAB1234", items: [], cursor: null } });
const lines = (stdout: string) => stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
const declaring = await discoverStreamingNodes();
const COMMON = ["--json", "--page-delay", "0", "--beta", "--account", "acc_1"];

describe("--all is declared exactly where it streams", () => {
  it("the sweep covers the streaming surface", () => {
    expect(declaring.length).toBeGreaterThan(50);
  });

  it.each(declaring.map((n) => [n.path.join(" "), n] as const))("%s --all announces the NDJSON stream", async (_p, node) => {
    const r = await sink.run([...argvFor(node), "--all", ...COMMON]);
    expect(r.stderr, `exit ${r.status}: ${r.stdout}`).toContain("--all streams NDJSON");
    expect(r.status, r.stderr).toBe(0);
  });

  it.each([
    ["recruiter", "applicants", "x1", "--channel-id", "c1"],
    ["recruiter", "search", "parameters", "--source", "messaging", "--type", "LOCATION"],
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
  ])("%j refuses --all, --max-pages and --page-delay as unknown flags with zero requests; the bare call sends", async (...argv) => {
    for (const flag of [["--all"], ["--max-pages", "2"], ["--page-delay", "0"]]) {
      const r = await sink.run([...argv, ...flag, "--json", "--beta", "--account", "acc_1"]);
      expect([r.status, r.requests]).toEqual([2, []]);
      expect(r.stderr).toContain(`unknown flag \`${flag[0]}\``);
    }
    const control = await sink.run([...argv, "--json", "--beta", "--account", "acc_1"]);
    expect(control.status, control.stdout + control.stderr).toBe(0);
    expect(control.requests.length).toBeGreaterThan(0);
  });

  it("every streamAll loop in src/commands writes through the projecting helper", () => {
    const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../src/commands");
    let loops = 0;
    let helper = 0;
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), "utf8");
      loops += src.match(/of streamAll\(/g)?.length ?? 0;
      helper += src.match(/writeNdjsonItem\(/g)?.length ?? 0;
    }
    expect(loops).toBeGreaterThan(0);
    expect(helper).toBe(loops);
  });
});

describe("--all --fields projects each streamed item", () => {
  const ITEM = {
    account_id: "acc_1", id: "wh_1", status: "active", auth_method: "credentials", full_name: "Test Person",
    url: "https://example.test/hook", extra: 1, notices: [{ code: "SOME_RESULTS_HIDDEN", message: "hidden" }],
    safety_warning: { row: "invites" }, source: "store", observed_at: "2026-09-01T00:00:00Z", withdrawn: false,
  };
  const PRESERVED = ["notices", "safety_warning", "source", "observed_at", "withdrawn"];

  it.each([[["account", "list"], "account_id"], [["webhook", "list"], "id"]] as const)(
    "%j --all --fields %s keeps only the field plus preserved keys; without --fields the stream is unchanged",
    async (cmd, key) => {
      sink.reply = { body: { items: [ITEM, { ...ITEM, account_id: "acc_2", id: "wh_2" }], cursor: null } };
      const narrowed = await sink.run([...cmd, "--all", "--json", "--fields", key]);
      expect(narrowed.status, narrowed.stderr).toBe(0);
      const items = lines(narrowed.stdout);
      expect(items).toHaveLength(2);
      for (const item of items) expect(Object.keys(item).sort()).toEqual([key, ...PRESERVED].sort());
      const full = lines((await sink.run([...cmd, "--all", "--json"])).stdout);
      expect(full).toHaveLength(2);
      expect(Object.keys(full[0]!)).toContain("status");
    },
  );
});

describe("a notice survives a command's slim projector", () => {
  const NOTICE = { code: "SOME_RESULTS_HIDDEN", message: "some entries on this page were not disclosed to the connected account" };
  const page = (notices?: unknown[]) => ({ body: { object: "account_list", items: [{ account_id: "acc_1", status: "active", full_name: "Test Person" }], cursor: null, ...(notices ? { notices } : {}) } });

  it("account list keeps notices[] beside its items, also under --fields; without notices there is no notices key", async () => {
    sink.reply = page([NOTICE]);
    const plain = JSON.parse((await sink.run(["account", "list", "--json"])).stdout) as Record<string, unknown>;
    expect(plain["notices"]).toEqual([NOTICE]);
    expect(Array.isArray(plain["items"])).toBe(true);
    const narrowed = JSON.parse((await sink.run(["account", "list", "--fields", "account_id", "--json"])).stdout) as Record<string, unknown>;
    expect([narrowed["notices"], narrowed["items"]]).toEqual([[NOTICE], [{ account_id: "acc_1" }]]);
    sink.reply = page();
    const none = await sink.run(["account", "list", "--json"]);
    expect(none.stdout).not.toContain("notices");
    expect(none.stderr).not.toContain("notice [");
  });
});
