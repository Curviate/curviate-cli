/**
 * The Cookie-Editor export (`account link --cookies-file`): parsed in this
 * process, locally, and only `li_at` / `li_a` leave it. Pure: no I/O, no
 * clock (the caller passes `now`). No message here quotes any part of the
 * input, and a raw JSON parse error is never surfaced (it quotes the text).
 *
 * The export's time zone is not read: no zone is ever sent for a connect.
 */

export type CookieExportReason =
  | "empty"
  | "not_json"
  | "not_array"
  | "no_li_at"
  | "expired"
  | "too_large"
  | "header_string"
  | "netscape"
  | "other_site";

export type CookieExportResult =
  | { ok: true; liAt: string; liA?: string; liAtExpiresAt: number | null; notes: string[] }
  | { ok: false; reason: CookieExportReason; expiredAt?: number };

/** The export may be at most this many UTF-8 bytes. */
export const COOKIE_EXPORT_MAX_BYTES = 1024 * 1024;

export const LI_A_EXPIRED_NOTE =
  "Your Sales Navigator or Recruiter session in this export has expired, so the account connects without it.";

/** What to tell the person, per reason. `expired` names the date. */
export function cookieExportMessage(r: Extract<CookieExportResult, { ok: false }>): string {
  switch (r.reason) {
    case "empty": return "Paste the export from Cookie-Editor.";
    case "not_json": return "This isn't a JSON export. In Cookie-Editor, click Export, choose JSON, and paste the result.";
    case "not_array": return "This JSON isn't a Cookie-Editor export. On linkedin.com, click Export in Cookie-Editor and choose JSON.";
    case "no_li_at": return "No LinkedIn session cookie (li_at) found. Sign in to linkedin.com in this browser, then export again.";
    case "expired": return `The LinkedIn session in this export expired on ${new Date(r.expiredAt ?? 0).toISOString().slice(0, 10)}. Sign in to linkedin.com again, then export again.`;
    case "too_large": return "This export is too large. Export from a linkedin.com tab only.";
    case "header_string": return "This is the Header String export. In Cookie-Editor, click Export and choose JSON instead.";
    case "netscape": return "This is the Netscape export. In Cookie-Editor, click Export and choose JSON instead.";
    case "other_site": return "These cookies are from another website. Open a linkedin.com tab, then export from Cookie-Editor there.";
  }
}

type Candidate = { value: string; expires: number | null };

const fail = (reason: CookieExportReason, extra: { expiredAt?: number } = {}): CookieExportResult => ({ ok: false, reason, ...extra });

/** Seconds since epoch when it is a finite number and not a session cookie; else unknown. */
function expiryOf(c: Record<string, unknown>): number | null {
  const e = c["expirationDate"];
  return c["session"] === true || typeof e !== "number" || !Number.isFinite(e) ? null : e;
}

/** Unexpired first, latest expiry wins, unknown last; or the latest expired one. */
function pick(cands: Candidate[], nowSec: number): { live?: Candidate; expired?: Candidate } {
  const live = cands.filter((c) => c.expires === null || c.expires > nowSec);
  const gone = cands.filter((c) => c.expires !== null && c.expires <= nowSec);
  const rank = (c: Candidate) => c.expires ?? -Infinity;
  const latest = (xs: Candidate[]) => xs.reduce<Candidate | undefined>((a, b) => (a === undefined || rank(b) > rank(a) ? b : a), undefined);
  return { live: latest(live), expired: latest(gone) };
}

export function parseCookieExport(raw: string, nowMs: number): CookieExportResult {
  const text = raw.replace(/^\uFEFF/, "").trim();
  if (text === "") return fail("empty");
  if (/^#\s?Netscape HTTP Cookie File/i.test(text) || /^[^\t\n]*\t(TRUE|FALSE)\t/m.test(text)) return fail("netscape");
  if (Buffer.byteLength(text, "utf8") > COOKIE_EXPORT_MAX_BYTES) return fail("too_large");

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    const pairs = text.split(";").map((s) => s.trim()).filter(Boolean);
    return fail(pairs.length >= 2 && pairs.every((p) => /^[^=\s]+=/.test(p)) ? "header_string" : "not_json");
  }
  if (!Array.isArray(json)) return fail("not_array");

  const nowSec = nowMs / 1000;
  const linkedin = json.filter((e): e is Record<string, unknown> => {
    if (e === null || typeof e !== "object" || typeof (e as Record<string, unknown>)["name"] !== "string") return false;
    const d = (e as Record<string, unknown>)["domain"];
    if (typeof d !== "string") return false;
    const host = d.toLowerCase().replace(/^\./, "");
    return host === "linkedin.com" || host === "www.linkedin.com";
  });
  if (json.length > 0 && linkedin.length === 0) return fail("other_site");

  const named = (name: string): Candidate[] =>
    linkedin
      .filter((c) => c["name"] === name)
      .flatMap((c) => {
        const raw = c["value"];
        if (typeof raw !== "string") return [];
        const v = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
        return v === "" ? [] : [{ value: v, expires: expiryOf(c) }];
      });

  const at = pick(named("li_at"), nowSec);
  if (!at.live) return at.expired ? fail("expired", { expiredAt: at.expired.expires! * 1000 }) : fail("no_li_at");
  const a = pick(named("li_a"), nowSec);
  return {
    ok: true,
    liAt: at.live.value,
    ...(a.live ? { liA: a.live.value } : {}),
    liAtExpiresAt: at.live.expires === null ? null : at.live.expires * 1000,
    notes: !a.live && a.expired ? [LI_A_EXPIRED_NOTE] : [],
  };
}
