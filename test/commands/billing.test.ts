/** `billing invoices`: the list and the PDF download, as the requests they send and the file they leave. */
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useSink, line, type Hit } from "../helpers/sink.js";

const PAGE = { object: "invoice_list", items: [{ object: "invoice", number: "INV-0001", created_at: "2026-10-01T00:00:00Z", period_start: null, period_end: null, total: 4900, currency: "eur", status: "paid" }], cursor: null };
const PDF = "%PDF-1.4 fixture\n";
const sink = useSink((h: Hit) =>
  h.url.includes("INV-9999")
    ? { status: 403, body: { code: "BILLING_OWNER_REQUIRED", message: "Owners only", user_fixable: true, retry_likely_to_succeed: false } }
    : h.url.endsWith("/pdf") ? { type: "application/pdf", body: PDF } : { body: PAGE });
const dir = mkdtempSync(join(tmpdir(), "billing-"));

describe("billing invoices", () => {
  it("lists with GET /v1/billing/invoices, JSON verbatim; --all streams one invoice per line", async () => {
    const r = await sink.run(["billing", "invoices", "--json", "--limit", "12"]);
    expect([r.status, r.requests.map((h) => h.method + " " + h.url), JSON.parse(r.stdout)]).toEqual([0, ["GET /v1/billing/invoices?limit=12"], PAGE]);
    const all = await sink.run(["billing", "invoices", "--all"]);
    expect(all.stdout.trim().split("\n").map((l) => JSON.parse(l).number)).toEqual(["INV-0001"]);
  });

  it("pdf INV-0001 -o file writes the bytes (0600); no -o exits 2; an Owner-only refusal exits 5 and leaves no file", async () => {
    const out = join(dir, "inv.pdf");
    const r = await sink.run(["billing", "invoices", "pdf", "INV-0001", "-o", out]);
    expect([r.status, line(r.requests[0]!), readFileSync(out, "utf8"), (statSync(out).mode & 0o777).toString(8)]).toEqual([0, "GET /v1/billing/invoices/INV-0001/pdf", PDF, "600"]);
    const none = await sink.run(["billing", "invoices", "pdf", "INV-0001"]);
    expect(none.status).toBe(2);
    const bad = join(dir, "bad.pdf");
    const denied = await sink.run(["billing", "invoices", "pdf", "INV-9999", "-o", bad]);
    expect([denied.status, existsSync(bad)]).toEqual([5, false]);
  });
});
