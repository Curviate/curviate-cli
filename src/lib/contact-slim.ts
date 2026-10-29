/**
 * Slim-default projections for Contacts: what an agent reads to pick the next
 * step. The free-text fields (`about`, `extra`) and the provenance (`sources`)
 * are verbose-only: they are untrusted data, and the largest part of a page.
 */

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v !== null && typeof v === "object" ? (v as Rec) : {});

export function slimContact(data: unknown): Rec {
  const c = rec(data);
  return {
    id: c["id"] ?? null,
    linkedin_url: c["linkedin_url"] ?? null,
    full_name: c["full_name"] ?? null,
    headline: c["headline"] ?? null,
    job_title: c["job_title"] ?? null,
    company: c["company"] ?? null,
    email: c["email"] ?? null,
    tags: c["tags"] ?? [],
    list_ids: c["list_ids"] ?? [],
    connected_account_ids: c["connected_account_ids"] ?? [],
    enrichment_status: rec(c["enrichment"])["status"] ?? null,
    // an upsert says what it did
    ...(c["outcome"] !== undefined ? { outcome: c["outcome"] } : {}),
  };
}

export function slimContactPage(data: unknown): Rec {
  const d = rec(data);
  return {
    object: d["object"] ?? null,
    items: Array.isArray(d["items"]) ? d["items"].map(slimContact) : [],
    cursor: d["cursor"] ?? null,
    ...(d["total"] !== undefined ? { total: d["total"] } : {}),
  };
}
