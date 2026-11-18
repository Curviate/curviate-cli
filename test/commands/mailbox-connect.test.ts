/**
 * `mailbox discover|connect|reconnect` and `--password-stdin`: ONE table of command lines. Every row is run twice, plain and
 * with `--verbose` plus the debug environment, and holds the same four facts: the exit code, the calls made (one per connect,
 * none when refused client-side), the request body (the password in it, and in nothing else), and a canary password found
 * nowhere else: stdout, stderr, the request line and headers, the files the CLI keeps. The control row proves the grep can
 * find the canary where it is meant to be.
 */
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { useSink, line, type Hit, type Reply } from "../helpers/sink.js";
import { configHome } from "../helpers/run-inproc.js";
import { requestLines } from "../../src/commands/mailbox.js";

/** `+`, `/` and `=` make its base64 and its URL encoding differ from it: three needles. */
const CANARY = "Cn+ry/9xK2mPq=";
const NEEDLES = [CANARY, Buffer.from(CANARY).toString("base64"), encodeURIComponent(CANARY)];

const CREATE = "POST /v1/auth/connect-requests";
const REQ = { object: "connect_request", id: "creq_1", kind: "mailbox_connect", status: "pending", account_id: null, mailbox_id: null, error_code: null, url: "https://app.example/accounts/connect/creq_1", expires_at: "2026-11-17T10:15:00Z", created_at: "2026-11-17T10:00:00Z", completed_at: null, admin_consent_url: null };
const DONE = { ...REQ, status: "completed", mailbox_id: "mbx_1", completed_at: "2026-11-17T10:00:01Z" };
const REFUSED = (error_code: string): Reply => ({ status: 201, body: { ...REQ, error_code } });
const API_ERROR = (status: number, code: string): Reply => ({ status, body: { code, message: `refused: ${code}`, user_fixable: true, retry_likely_to_succeed: status >= 500 } });
const GMAIL = ["mailbox", "connect", "anna@gmail.com", "--connection", "google_app_password", "--password-stdin"];
const IMAP = ["--imap-host", "imap.acme.example", "--imap-port", "993", "--imap-security", "tls", "--smtp-host", "smtp.acme.example", "--smtp-port", "465", "--smtp-security", "starttls"];
const IMAP_BODY = { imap: { host: "imap.acme.example", port: 993, security: "tls" }, smtp: { host: "smtp.acme.example", port: 465, security: "starttls" } };
const PW = { credentials: { password: CANARY } };

interface Row {
  name: string;
  args: string[];
  /** Piped to stdin (default: the canary and a newline). */
  stdin?: string;
  tty?: boolean;
  reply?: Reply;
  env?: Record<string, string>;
  exit: number;
  /** The one call made, and its body; no call when absent. */
  call?: string;
  body?: unknown;
  /** Text stdout+stderr must hold. */
  says?: string;
}

const ROWS: Row[] = [
  // connect: the password, success and each failure
  { name: "google_app_password: checked and connected", args: GMAIL, reply: { status: 201, body: DONE }, exit: 0, call: CREATE, body: { mailbox: { connection: "google_app_password", address: "anna@gmail.com" }, ...PW }, says: '"mailbox_id":"mbx_1"' },
  { name: "google_app_password, --json", args: [...GMAIL, "--json"], reply: { status: 201, body: DONE }, exit: 0, call: CREATE, body: { mailbox: { connection: "google_app_password", address: "anna@gmail.com" }, ...PW }, says: '"mailbox_id":"mbx_1"' },
  { name: "imap_smtp: six server flags, connected", args: ["mailbox", "connect", "anna@acme.example", "--connection", "imap_smtp", ...IMAP, "--password-stdin"], reply: { status: 201, body: DONE }, exit: 0, call: CREATE, body: { mailbox: { connection: "imap_smtp", address: "anna@acme.example", ...IMAP_BODY }, ...PW } },
  { name: "typed on a terminal: one line, no echo", args: GMAIL, tty: true, reply: { status: 201, body: DONE }, exit: 0, call: CREATE, body: { mailbox: { connection: "google_app_password", address: "anna@gmail.com" }, ...PW }, says: "Reading secret from stdin" },
  { name: "password refused by the host: 8, the request stays open", args: GMAIL, reply: REFUSED("MAILBOX_CREDENTIAL_REJECTED"), exit: 8, call: CREATE, body: { mailbox: { connection: "google_app_password", address: "anna@gmail.com" }, ...PW }, says: "MAILBOX_CREDENTIAL_REJECTED" },
  { name: "Google's own password: 2", args: GMAIL, reply: REFUSED("MAILBOX_APP_PASSWORD_REQUIRED"), exit: 2, call: CREATE, body: { mailbox: { connection: "google_app_password", address: "anna@gmail.com" }, ...PW } },
  { name: "TLS failed: 8", args: GMAIL, reply: REFUSED("MAILBOX_TLS_FAILED"), exit: 8, call: CREATE, body: { mailbox: { connection: "google_app_password", address: "anna@gmail.com" }, ...PW } },
  { name: "temporary refusal: 7, never read as a wrong password", args: GMAIL, reply: REFUSED("PLATFORM_ERROR"), exit: 7, call: CREATE, body: { mailbox: { connection: "google_app_password", address: "anna@gmail.com" }, ...PW } },
  { name: "refused refusal, --json: the envelope names the code", args: [...GMAIL, "--json"], reply: REFUSED("MAILBOX_CREDENTIAL_REJECTED"), exit: 8, call: CREATE, body: { mailbox: { connection: "google_app_password", address: "anna@gmail.com" }, ...PW }, says: "MAILBOX_CREDENTIAL_REJECTED" },
  { name: "HTTP 400 from the API: 2", args: GMAIL, reply: API_ERROR(400, "INVALID_REQUEST"), exit: 2, call: CREATE, body: { mailbox: { connection: "google_app_password", address: "anna@gmail.com" }, ...PW }, says: "INVALID_REQUEST" },
  { name: "HTTP 409 already connected: 8", args: GMAIL, reply: API_ERROR(409, "MAILBOX_ALREADY_CONNECTED"), exit: 8, call: CREATE, body: { mailbox: { connection: "google_app_password", address: "anna@gmail.com" }, ...PW } },
  { name: "HTTP 401: 3", args: GMAIL, reply: API_ERROR(401, "UNAUTHORIZED"), exit: 3, call: CREATE, body: { mailbox: { connection: "google_app_password", address: "anna@gmail.com" }, ...PW } },
  { name: "HTTP 503: 7", args: GMAIL, reply: API_ERROR(503, "PLATFORM_ERROR"), exit: 7, call: CREATE, body: { mailbox: { connection: "google_app_password", address: "anna@gmail.com" }, ...PW } },
  { name: "an answer that is not JSON", args: GMAIL, reply: { status: 201, type: "text/html", body: "<html>gateway</html>" }, exit: 0, call: CREATE, body: { mailbox: { connection: "google_app_password", address: "anna@gmail.com" }, ...PW }, says: "do not retry it" },
  { name: "no server at the base URL", args: GMAIL, env: { CURVIATE_BASE_URL: "http://127.0.0.1:1" }, exit: 7 },
  { name: "piped: leading and inner spaces kept, trailing whitespace and CRLF dropped", args: GMAIL, stdin: `  sp ace ${CANARY}  \r\n`, reply: { status: 201, body: DONE }, exit: 0, call: CREATE, body: { mailbox: { connection: "google_app_password", address: "anna@gmail.com" }, credentials: { password: `  sp ace ${CANARY}` } } },
  { name: "piped: more than one line is refused, nothing half-read", args: GMAIL, stdin: `${CANARY}\nsecond line\n`, exit: 2, says: "more than one line" },
  { name: "--password-stdin=VALUE is refused, the value never echoed", args: ["mailbox", "connect", "anna@gmail.com", "--connection", "google_app_password", `--password-stdin=${CANARY}`], exit: 2 },
  { name: "reconnect --password-stdin=VALUE is refused", args: ["mailbox", "reconnect", "mbx_1", `--password-stdin=${CANARY}`], exit: 2 },
  { name: "CLI-wide (MBX-33): account link --password-stdin=VALUE is refused, never echoed", args: ["account", "link", "--seat-id", "seat_1", "--auth-method", "credentials", "--email", "a@b.c", "--country", "US", `--password-stdin=${CANARY}`], exit: 2, says: "takes no value" },
  { name: "CLI-wide (MBX-33): account link --li-at-stdin=VALUE is refused", args: ["account", "link", "--seat-id", "seat_1", "--auth-method", "cookie", `--li-at-stdin=${CANARY}`], exit: 2, says: "takes no value" },
  { name: "typed on a terminal (MBX-33): leading and inner spaces kept, trailing dropped, as piped", args: GMAIL, tty: true, stdin: `  sp ace ${CANARY}  \n`, reply: { status: 201, body: DONE }, exit: 0, call: CREATE, body: { mailbox: { connection: "google_app_password", address: "anna@gmail.com" }, credentials: { password: `  sp ace ${CANARY}` } } },
  // reconnect
  { name: "reconnect: new password checked and stored", args: ["mailbox", "reconnect", "mbx_1", "--password-stdin"], reply: { status: 201, body: { ...DONE, kind: "mailbox_reconnect" } }, exit: 0, call: CREATE, body: { mailbox_id: "mbx_1", ...PW } },
  { name: "reconnect: an app password beside a Google sign-in (the same call)", args: ["mailbox", "reconnect", "mbx_gsi", "--password-stdin", "--json"], reply: { status: 201, body: { ...DONE, kind: "mailbox_reconnect", mailbox_id: "mbx_gsi" } }, exit: 0, call: CREATE, body: { mailbox_id: "mbx_gsi", ...PW } },
  { name: "reconnect: password refused", args: ["mailbox", "reconnect", "mbx_1", "--password-stdin"], reply: REFUSED("MAILBOX_CREDENTIAL_REJECTED"), exit: 8, call: CREATE, body: { mailbox_id: "mbx_1", ...PW } },
  { name: "reconnect: unknown Mailbox 404: 4", args: ["mailbox", "reconnect", "mbx_x", "--password-stdin"], reply: API_ERROR(404, "MAILBOX_NOT_FOUND"), exit: 4, call: CREATE, body: { mailbox_id: "mbx_x", ...PW } },
  { name: "reconnect: credentials on a Microsoft sign-in Mailbox, 400", args: ["mailbox", "reconnect", "mbx_ms", "--password-stdin"], reply: API_ERROR(400, "INVALID_REQUEST"), exit: 2, call: CREATE, body: { mailbox_id: "mbx_ms", ...PW } },
  // no password: the link
  { name: "google_sign_in: the sign-in link and the administrator link", args: ["mailbox", "connect", "anna@acme.example", "--connection", "google_sign_in"], reply: { status: 201, body: { ...REQ, admin_consent_url: "https://docs.example/google-admin" } }, exit: 0, call: CREATE, body: { mailbox: { connection: "google_sign_in", address: "anna@acme.example" } }, says: '"admin_consent_url":"https://docs.example/google-admin"' },
  { name: "reconnect without a password: the link", args: ["mailbox", "reconnect", "mbx_1"], reply: { status: 201, body: { ...REQ, kind: "mailbox_reconnect", mailbox_id: "mbx_1" } }, exit: 0, call: CREATE, body: { mailbox_id: "mbx_1" }, says: '"status":"pending"' },
  // refused before any request; the canary is never read, never echoed
  { name: "--password CANARY is not a flag", args: ["mailbox", "connect", "anna@gmail.com", "--connection", "google_app_password", "--password", CANARY], exit: 2 },
  { name: "--password=CANARY is not a flag", args: ["mailbox", "reconnect", "mbx_1", `--password=${CANARY}`], exit: 2 },
  { name: "--password-stdin on a sign-in connection", args: ["mailbox", "connect", "anna@acme.example", "--connection", "google_sign_in", "--password-stdin"], exit: 2 },
  { name: "--password-stdin with an empty stdin", args: GMAIL, stdin: "\n", exit: 2 },
  { name: "imap_smtp without its server flags", args: ["mailbox", "connect", "anna@acme.example", "--connection", "imap_smtp", "--password-stdin"], exit: 2 },
  { name: "imap_smtp cleartext security", args: ["mailbox", "connect", "anna@acme.example", "--connection", "imap_smtp", ...IMAP.map((a) => (a === "tls" ? "none" : a)), "--password-stdin"], exit: 2 },
  { name: "server flags on a google_app_password connect", args: [...GMAIL, "--imap-host", "imap.acme.example"], exit: 2 },
  { name: "no --connection", args: ["mailbox", "connect", "anna@gmail.com", "--password-stdin"], exit: 2 },
  { name: "--preview renders the request masked and reads nothing", args: [...GMAIL, "--preview"], exit: 0, says: "••••" },
  { name: "reconnect --preview masked", args: ["mailbox", "reconnect", "mbx_1", "--password-stdin", "--preview"], exit: 0, says: "••••" },
  // the Mailbox kinds of the connect request, and discover
  { name: "connect-request get reads a Mailbox request", args: ["account", "connect-request", "get", "creq_1", "--json"], reply: { body: { ...DONE, admin_consent_url: "https://docs.example/google-admin" } }, exit: 0, call: "GET /v1/auth/connect-requests/creq_1", says: "mbx_1" },
  { name: "connect-request cancel cancels a Mailbox request", args: ["account", "connect-request", "cancel", "creq_1", "--json"], reply: { body: { ...REQ, status: "cancelled" } }, exit: 0, call: "POST /v1/auth/connect-requests/creq_1/cancel", says: "cancelled" },
  { name: "discover", args: ["mailbox", "discover", "anna@acme.example", "--json"], stdin: "", reply: { body: { connection: "imap_smtp", imap: { host: "imap.acme.example", port: 993, security: "tls" }, smtp: { host: "smtp.acme.example", port: 465, security: "tls" }, source: "autoconfig", confirm_required: false } }, exit: 0, call: "GET /v1/mailboxes/discover", says: "imap.acme.example" },
];

const sink = useSink((h: Hit) => ({ status: 200, body: h.url.startsWith("/v1/mailboxes/discover") ? {} : REQ }));

/** Every file under `dir`, as text: what the CLI keeps on disk. */
const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? filesUnder(p) : [readFileSync(p, "utf8")];
  });
const found = (haystack: string[]) => NEEDLES.filter((n) => haystack.some((h) => h.includes(n)));

describe("mailbox discover, connect, reconnect: the password reaches the request body and nowhere else", () => {
  for (const mode of ["plain", "verbose and debug env"] as const) {
    it.each(ROWS)(`${mode}: $name`, async (row) => {
      sink.reply = row.reply ?? sink.reply;
      const xdg = configHome();
      const flags = mode === "plain" ? [] : ["--verbose"];
      const env = mode === "plain" ? {} : { DEBUG: "*", CURVIATE_DEBUG: "1", NODE_DEBUG: "http" };
      const r = await sink.run([...row.args, ...flags], { xdg, stdin: row.stdin ?? `${CANARY}\n`, stdinTTY: row.tty, env: { ...env, ...row.env } });
      const out = `${r.stdout}${r.stderr}`;
      expect(r.status, out).toBe(row.exit);
      if (row.env?.["CURVIATE_BASE_URL"] === undefined) expect(r.requests.map(line), "calls made: one per connect, none when refused").toEqual(row.call ? [row.call] : []);
      if (row.body !== undefined) expect(JSON.parse(r.requests[0]!.body)).toEqual(row.body);
      if (row.says) expect(out).toContain(row.says);
      // the oracle: the canary is in the body when the row sends it, and in nothing else
      const sent = row.body !== undefined && JSON.stringify(row.body).includes(CANARY);
      expect(found(r.requests.map((h) => h.body)).length > 0, "the canary reaches the request body when sent").toBe(sent);
      expect(found([out]), "stdout and stderr").toEqual([]);
      expect(found(r.requests.map((h) => `${h.method} ${h.url} ${JSON.stringify(h.headers)}`)), "request line and headers").toEqual([]);
      expect(found(filesUnder(xdg)), "files the CLI keeps").toEqual([]);
    });
  }

  it("control: the grep finds the canary where it is, in each place it looks", async () => {
    expect(found([`out ${CANARY}`])).toEqual([CANARY]);
    expect(found([`out ${encodeURIComponent(CANARY)}`])).toEqual([encodeURIComponent(CANARY)]);
    const xdg = mkdtempSync(join(tmpdir(), "mbx-leak-"));
    const r = await sink.run(GMAIL, { xdg, stdin: `${CANARY}\n` });
    expect(found(r.requests.map((h) => h.body))).toEqual([CANARY]);
  });

  // A password never passes through an agent: no output an agent reads suggests piping one in; the link is the way.
  // `--password-stdin` stays in `--help`, for a person at their own terminal (checked by the help case below).
  it.each([
    ["a pending link", ["mailbox", "connect", "anna@acme.example", "--connection", "google_sign_in"], "", 0],
    ["a pending reconnect", ["mailbox", "reconnect", "mbx_1"], "", 0],
    ["an empty --password-stdin", GMAIL, "\n", 2],
    ["--password-stdin=VALUE", ["mailbox", "connect", "anna@gmail.com", "--connection", "google_app_password", "--password-stdin=x"], "", 2],
  ] as const)("output text, %s: never suggests piping a password, points to the link", async (_n, args, stdin, exit) => {
    sink.reply = { status: 201, body: REQ };
    const r = await sink.run([...args], { stdin });
    const out = `${r.stdout}${r.stderr}`;
    expect(r.status, out).toBe(exit);
    expect(out).not.toMatch(/pipe|printf|\|\s*curviate|--password-stdin\s*</i); // no suggestion to send a password in

    expect(out).toMatch(/never passes through|link/i);
  });

  it("human output: the Mailbox once connected, else the link and the administrator link", () => {
    expect(requestLines(DONE)).toEqual(["Mailbox: mbx_1", "Request: creq_1"]);
    expect(requestLines({ ...REQ, admin_consent_url: "https://docs.example/google-admin" })).toEqual([`Link: ${REQ.url}`, `Expires: ${REQ.expires_at}`, "Request: creq_1", "Administrator link: https://docs.example/google-admin"]);
  });

  it("help lists every connect row and offers no value flag for a password", async () => {
    const help = async (...a: string[]) => { const r = await sink.run([...a, "--help"]); return r.stdout + r.stderr; };
    const mailbox = await help("mailbox");
    for (const v of ["discover", "connect", "reconnect"]) expect(mailbox).toContain(v);
    const connect = await help("mailbox", "connect");
    for (const f of ["--connection", "--password-stdin", "--imap-host", "--imap-port", "--imap-security", "--smtp-host", "--smtp-port", "--smtp-security", "google_sign_in"]) expect(connect).toContain(f);
    const reconnect = await help("mailbox", "reconnect");
    expect(reconnect).toContain("--password-stdin");
    for (const text of [connect, reconnect, await help("mailbox", "discover")]) expect(text).not.toMatch(/--password(?!-stdin)/);
    expect(await help("account", "connect-request", "get")).toContain("Mailbox");
    expect(await help("account", "connect-request", "cancel")).toContain("Mailbox");
  });
});
