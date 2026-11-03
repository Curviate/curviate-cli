/**
 * `curviate network`: each command's request on the wire, the explicit-only
 * `--accounts` filter, resync's one-or-all choice, and the export contract
 * (every page at limit 1000, data-only stream, 0600 file, the coverage warning).
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lines, wire } from "../helpers/wire.js";

describe("network: the request each command sends", () => {
  it.each([
    [["network", "list", "--accounts", "acc_a,acc_b", "--query", "founder", "--include-removed", "--limit", "5"],
      { call: "GET /v1/network/connections", query: { account_id: "acc_a,acc_b", q: "founder", include_removed: "true", limit: "5" }, body: undefined }],
    [["network", "status", "--accounts", "acc_a"], { call: "GET /v1/network/sync-status", query: { account_id: "acc_a" }, body: undefined }],
    [["network", "resync", "acc_a"], { call: "POST /v1/network/resync", query: {}, body: { account_id: "acc_a" } }],
    [["network", "resync", "--all"], { call: "POST /v1/network/resync", query: {}, body: {} }],
  ])("%j", async (args, expected) => {
    const r = await wire(args, () => ({ body: { object: "x", items: [], cursor: null } }));
    expect([r.status, lines(r.sent)]).toEqual([0, [expected]]);
  });

  it("a default Account in the profile never narrows the list (no account_id sent)", async () => {
    const r = await wire(["network", "list"], undefined, { env: { CURVIATE_ACCOUNT: "acc_default" } });
    expect(lines(r.sent)).toEqual([{ call: "GET /v1/network/connections", query: {}, body: undefined }]);
  });

  it.each([[["network", "resync"]], [["network", "resync", "acc_a", "--all"]]])("resync needs exactly one of <account_id> or --all: %j exits 2, no request", async (args) => {
    const r = await wire(args);
    expect([r.status, r.sent.length]).toEqual([2, 0]);
  });
});

const person = (n: number) => ({ object: "connection", account_id: "acc_a", member_id: `m${n}`, first_name: n === 1 ? "=cmd" : "Jane", last_name: "Doe", headline: "VP, Sales", connected_at: "2026-10-01T00:00:00Z" });

describe("network export", () => {
  const twoPages = (complete: boolean) => (_: unknown, n: number) => ({
    body: n === 0
      ? { object: "connection_list", items: [person(1)], cursor: "c1", coverage: { complete, accounts: 2, accounts_incomplete: complete ? 0 : 1 } }
      : { object: "connection_list", items: [person(2)], cursor: null, coverage: { complete, accounts: 2, accounts_incomplete: complete ? 0 : 1 } },
  });

  it("walks every page at limit 1000; stdout carries only ndjson; an incomplete scope warns on stderr and still exits 0", async () => {
    const r = await wire(["network", "export", "--accounts", "acc_a"], twoPages(false));
    expect(r.sent.map((s) => s.query)).toEqual([{ account_id: "acc_a", limit: "1000" }, { account_id: "acc_a", limit: "1000", cursor: "c1" }]);
    expect(r.stdout.trim().split("\n").map((l) => JSON.parse(l).member_id)).toEqual(["m1", "m2"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/1 Account\(s\).*not finished/);
    const control = await wire(["network", "export"], twoPages(true));
    expect(control.stderr).not.toMatch(/not finished/);
  });

  it("csv to -o: a 0600 file replacing a 0644 one, BOM, header in field order, formula-guarded cells", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "cv-net-")), "c.csv");
    writeFileSync(file, "old", { mode: 0o644 });
    const r = await wire(["network", "export", "--format", "csv", "-o", file, "--fields", "member_id,first_name,headline"], twoPages(true));
    expect([r.status, r.stdout]).toEqual([0, ""]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toBe("﻿member_id,first_name,headline\r\nm1,'=cmd,\"VP, Sales\"\r\nm2,Jane,\"VP, Sales\"\r\n");
  });

  it("--json exits 2 naming --format json, before any request", async () => {
    const r = await wire(["network", "export", "--json"]);
    expect([r.status, r.sent.length, r.stderr]).toEqual([2, 0, expect.stringContaining("--format json")]);
  });
});
