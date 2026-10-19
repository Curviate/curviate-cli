/**
 * A local HTTP sink standing in for the API, plus `run()`: the CLI in-process
 * (`runCli`) pointed at it with a stub key. Every outbound request is recorded,
 * so a test can assert on what reached the wire (`requests`) rather than on
 * stdout, and "sent nothing" needs a same-path control that does send.
 *
 *   const sink = useSink();                      // registers its own hooks
 *   sink.reply = (hit) => ({ status: 404, body: {...} });   // reset after each test
 *   const r = await sink.run(["core", "profile", "me", "--json", "--account", "acc_1"]);
 *   r.status / r.stdout / r.stderr / r.requests
 */

import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { afterAll, afterEach, beforeAll } from "vitest";
import { runCli, type RunOpts, type RunResult } from "./run-inproc.js";

export interface Hit {
  method: string;
  /** path + query, as sent */
  url: string;
  body: string;
  headers: IncomingHttpHeaders;
}
/** A non-string `body` is sent as JSON. */
export interface Reply {
  status?: number;
  type?: string;
  body?: unknown;
}
export type ReplyFn = (hit: Hit) => Reply;

export const OK_PAGE: Reply = { body: { object: "list", items: [], cursor: null } };

/** `useSink(pathOf)`: the recorded request, as `METHOD /path` (query dropped). */
export const line = (h: Hit) => `${h.method} ${h.url.split("?")[0]}`;

export interface Sink {
  url: string;
  /** Every request received since the last `run()` (or since start). */
  readonly hits: Hit[];
  reply: Reply | ReplyFn;
  run(args: string[], opts?: RunOpts): Promise<RunResult & { requests: Hit[] }>;
}

export function useSink(initial: Reply | ReplyFn = OK_PAGE): Sink {
  let server: Server;
  let hits: Hit[] = [];
  const sink: Sink = {
    url: "",
    get hits() {
      return hits;
    },
    reply: initial,
    async run(args, opts = {}) {
      hits = [];
      const r = await runCli(args, {
        ...opts,
        env: { CURVIATE_API_KEY: "cvt_test_sink", CURVIATE_BASE_URL: sink.url, ...opts.env },
      });
      return { ...r, requests: hits };
    },
  };
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (c: string) => (body += c));
      req.on("end", () => {
        const hit: Hit = { method: req.method ?? "", url: req.url ?? "", body, headers: req.headers };
        hits.push(hit);
        const r = typeof sink.reply === "function" ? sink.reply(hit) : sink.reply;
        const raw = typeof r.body === "string";
        res.writeHead(r.status ?? 200, { "content-type": r.type ?? (raw ? "text/plain" : "application/json"), "retry-after": "0" });
        res.end(raw ? (r.body as string) : JSON.stringify(r.body ?? {}));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    sink.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => {
    server.close(() => r());
    server.closeAllConnections();
  }));
  afterEach(() => {
    sink.reply = initial;
  });
  return sink;
}
