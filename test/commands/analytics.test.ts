/**
 * `curviate analytics`, `curviate export`, `curviate account overview|metrics`:
 * each command's request on the wire, the refusals made before any request,
 * the export file contract, and the paths footer in the human table.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lines, wire } from "../helpers/wire.js";

const q = (call: string, query: Record<string, string>, body?: unknown) => ({ call, query, body });

describe("analytics: the request each command sends", () => {
  it.each([
    [["analytics", "get", "--range", "30d", "--accounts", "acc_a", "--motions", "mot_1,mot_2", "--origin", "unibox,api", "--include", "motions", "--sort", "-reply.rate", "--limit", "5", "--compare", "previous_period"],
      q("GET /v1/analytics/motions", { range: "30d", account_id: "acc_a", motion_id: "mot_1,mot_2", origin: "unibox,api", include: "motions", sort: "-reply.rate", limit: "5", compare: "previous_period" })],
    [["analytics", "get", "--motion", "mot_1", "--from", "2024-01-01", "--to", "2026-10-01", "--timezone", "Europe/Berlin", "--version", "2"],
      q("GET /v1/analytics/motions/mot_1", { from: "2024-01-01", to: "2026-10-01", timezone: "Europe/Berlin", version: "2" })],
    [["analytics", "get", "--view", "activity", "--range", "7d", "--accounts", "acc_a"], q("GET /v1/analytics/activity", { range: "7d", account_id: "acc_a" })],
    [["analytics", "events", "list", "--motion", "mot_1", "--step", "opener"], q("GET /v1/analytics/events", { motion_id: "mot_1", step_id: "opener" })],
    [["analytics", "events", "list", "--contact", "con_1", "--origin", "direct", "--kind", "step.executed,message.replied"],
      q("GET /v1/analytics/events", { contact_id: "con_1", origin: "direct", kind: "step.executed,message.replied" })],
    [["analytics", "export", "--table", "daily,motions", "--range", "90d", "--job"],
      q("POST /v1/exports", {}, { entity: "analytics", tables: ["daily", "motions"], format: "csv", filters: { range: "90d" } })],
    [["analytics", "export", "--table", "motion_activity", "--format", "ndjson", "--motions", "mot_1", "--job"],
      q("POST /v1/exports", {}, { entity: "motion_activity", tables: ["motion_activity"], format: "ndjson", filters: { motion_id: ["mot_1"] } })],
    [["export", "get", "exp_1"], q("GET /v1/exports/exp_1", {})],
    [["account", "overview", "acc_a", "--range", "30d", "--include", "performance,limits", "--origin", "motion"],
      q("GET /v1/accounts/acc_a/overview", { range: "30d", include: "performance,limits", origin: "motion" })],
    [["account", "metrics", "acc_a", "--from", "2026-10-01", "--to", "2026-10-28"], q("GET /v1/accounts/acc_a/metrics", { from: "2026-10-01", to: "2026-10-28" })],
  ])("%j", async (args, expected) => {
    const r = await wire(args, () => ({ body: { object: "x", id: "exp_1", status: "queued", items: [], cursor: null } }));
    expect([r.status, lines(r.sent)]).toEqual([0, [expected]]);
  });

  it.each([
    [["analytics", "get", "--view", "activity", "--motion", "mot_x"]],
    [["analytics", "events", "list", "--step", "opener"]],
    [["analytics", "export", "--table", "motion_activity"]],
    [["analytics", "export", "--json"]],
  ])("%j exits 2 with no request", async (args) => {
    const r = await wire(args);
    expect([r.status, r.sent.length]).toEqual([2, 0]);
  });

  it("events list --all follows cursors to the end, one NDJSON line per event", async () => {
    const r = await wire(["analytics", "events", "list", "--all", "--page-delay", "0"], (_, n) => ({
      body: { object: "analytics_event_list", items: [{ id: `ane_${n}` }], cursor: n === 0 ? "c1" : null },
    }));
    expect(r.sent.map((s) => s.query["cursor"] ?? null)).toEqual([null, "c1"]);
    expect(r.stdout.trim().split("\n").map((l) => JSON.parse(l).id)).toEqual(["ane_0", "ane_1"]);
  });
});

describe("export files", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "cv-exp-"));

  it("analytics export streams the table's bytes verbatim into a 0600 file", async () => {
    const file = join(dir(), "e.csv");
    const r = await wire(["analytics", "export", "--table", "enrollments", "--format", "csv", "--range", "30d", "-o", file], () => ({ body: "﻿enrollment_id\r\nenr_1\r\n", type: "text/csv" }));
    expect(lines(r.sent)).toEqual([q("GET /v1/analytics/export", { range: "30d", format: "csv", table: "enrollments" }, undefined)]);
    expect([r.status, readFileSync(file, "utf8"), statSync(file).mode & 0o777]).toEqual([0, "﻿enrollment_id\r\nenr_1\r\n", 0o600]);
  });

  it("export download writes the file; a job not ready yet exits 7 and writes nothing", async () => {
    const file = join(dir(), "a.zip");
    const ok = await wire(["export", "download", "exp_1", "-o", file], () => ({ body: "PK-bytes", type: "application/zip" }));
    expect([ok.status, lines(ok.sent)[0]!.call, readFileSync(file, "utf8")]).toEqual([0, "GET /v1/exports/exp_1/file", "PK-bytes"]);
    const other = join(dir(), "b.zip");
    const busy = await wire(["export", "download", "exp_1", "-o", other], () => ({ status: 409, body: { code: "EXPORT_NOT_READY", message: "Not ready.", user_fixable: false, retry_likely_to_succeed: true } }));
    expect(busy.status).toBe(7);
    expect(() => statSync(other)).toThrow();
  });
});

describe("analytics: human output", () => {
  const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  afterEach(() => (tty ? Object.defineProperty(process.stdout, "isTTY", tty) : delete (process.stdout as { isTTY?: boolean }).isTTY));
  const motion = (paths_through: string | null) => ({
    object: "analytics_motion",
    window: { from: "2025-01-01", to: "2026-10-28", timezone: "UTC", counts_only_through: paths_through, paths_through },
    totals: { acceptance: { accepted: 9, sent: 16, rate: 0.5625 } },
    steps: [{ step_id: "invite", action: "invite.send", executed: 16, skipped: 2, failed: 1, acceptance: { accepted: 9, sent: 16, rate: 0.5625 }, reasons: { skipped: { already_connected: 2 }, failed: {} } }],
    paths: [{ path: "connected", totals: { acceptance: { accepted: 9, sent: 16, rate: 0.5625 } } }],
  });

  it("--motion renders the step and paths tables, with the footer only when paths_through is set", async () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    const r = await wire(["analytics", "get", "--motion", "mot_1"], () => ({ body: motion("2025-10-28") }));
    expect(r.stdout).toMatch(/invite\s+invite\.send\s+16\s+2\s+1\s+9\/16 56%/);
    expect(r.stdout).toContain("invite: skipped already_connected 2");
    expect(r.stdout).toContain("paths cover days after 2025-10-28");
    const control = await wire(["analytics", "get", "--motion", "mot_1"], () => ({ body: motion(null) }));
    expect(control.stdout).toMatch(/connected\s+9\/16 56%/);
    expect(control.stdout).not.toContain("paths cover");
  });
});
