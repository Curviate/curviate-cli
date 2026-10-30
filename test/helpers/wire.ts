/**
 * Drive the CLI in-process against a recording fetch: the real dispatcher,
 * the real SDK and the CLI's transport, with `fetch` stubbed at the global the
 * transport calls. Every request is recorded as method, path, query (repeated
 * keys joined by commas) and parsed JSON body.
 */
import { vi } from "vitest";
import { runCli, type RunOpts, type RunResult } from "./run-inproc.js";

export type Sent = { method: string; path: string; query: Record<string, string>; body: unknown; headers: Headers };
export type Answer = { status?: number; body?: unknown; type?: string };

export const BASE = "https://wire.curviate.test";

/** `answer` decides each response (default: an empty page). */
export async function wire(args: string[], answer: (req: Sent, n: number) => Answer = () => ({}), opts: RunOpts = {}): Promise<RunResult & { sent: Sent[] }> {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const query: Record<string, string> = {};
    for (const k of new Set(url.searchParams.keys())) query[k] = url.searchParams.getAll(k).join(",");
    const raw = typeof init?.body === "string" ? init.body : undefined;
    const req: Sent = { method: (init?.method ?? "GET").toUpperCase(), path: url.pathname, query, body: raw === undefined ? undefined : JSON.parse(raw), headers: new Headers(init?.headers) };
    sent.push(req);
    const a = answer(req, sent.length - 1);
    const body = a.body ?? { object: "list", items: [], cursor: null };
    return new Response(typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body), {
      status: a.status ?? 200,
      headers: { "content-type": a.type ?? "application/json" },
    });
  });
  try {
    const r = await runCli(args, { ...opts, env: { CURVIATE_API_KEY: "cvt_live_wire", CURVIATE_BASE_URL: BASE, ...opts.env } });
    return { ...r, sent };
  } finally {
    vi.unstubAllGlobals();
  }
}

/** The request lines only, for table rows: `GET /v1/x?a=1` plus the body. */
export const lines = (sent: Sent[]) => sent.map((s) => ({ call: `${s.method} ${s.path}`, query: s.query, body: s.body }));
