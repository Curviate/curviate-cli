/**
 * Connection location through the built bin: `account link` names exactly one
 * of --country / --ip / --proxy-host on a new connect, refused BEFORE any
 * request when it does not, and `account update --country` moves an account
 * and prints the location the API returned.
 *
 * Every refusal is asserted on what a local sink actually received (nothing),
 * next to a control in the same test that differs only by the fix and does
 * reach the sink, so "sent no request" cannot be satisfied by a command that
 * never gets as far as sending anything.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureFreshBuild } from "./helpers/built-cli.js";

interface Recorded {
  method: string;
  url: string;
  body: string;
}

const RETURNED_LOCATION = { country: "US", current_country: "US", mode: "auto", strict: true };

let cliPath: string;
let server: Server;
let baseUrl: string;
let recorded: Recorded[] = [];
let intentReply: { status: number; body: unknown };
const DEFAULT_INTENT = {
  status: 201,
  body: { object: "account", account_id: "acc_new", status: "active", connection_location: RETURNED_LOCATION },
};

beforeAll(async () => {
  cliPath = ensureFreshBuild();
  server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (body += c));
    req.on("end", () => {
      const url = req.url ?? "";
      recorded.push({ method: req.method ?? "", url, body });
      res.setHeader("content-type", "application/json");
      if (req.method === "PATCH") {
        res.writeHead(200);
        // The API's re-read: fields the request never carried (mode, strict,
        // current_country), so printing them proves the response is rendered.
        res.end(JSON.stringify({ object: "account", account_id: "acc_1", status: "active", connection_location: RETURNED_LOCATION }));
        return;
      }
      res.writeHead(intentReply.status);
      res.end(JSON.stringify(intentReply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

afterEach(() => {
  intentReply = DEFAULT_INTENT;
});
intentReply = DEFAULT_INTENT;

function run(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string; requests: Recorded[] }> {
  recorded = [];
  const xdg = mkdtempSync(join(tmpdir(), "curviate-location-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: xdg,
    NODE_ENV: "production",
    CURVIATE_API_KEY: "cvt_test_location_stub",
    CURVIATE_BASE_URL: baseUrl,
  };
  delete env["CURVIATE_ACCOUNT"];
  delete env["CURVIATE_PROXY_PASSWORD"];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("close", (status) => resolve({ status, stdout, stderr, requests: [...recorded] }));
    child.stdin.end("");
  });
}

const LINK = [
  "account", "link",
  "--auth-method", "cookie", "--li-at", "li_at_value", "--user-agent", "UA/1",
  "--seat-id", "seat_1", "--json",
];
const RECONNECT = [...LINK, "--account-id", "acc_1"];
const PROXY = ["--proxy-host", "proxy.example.com", "--proxy-port", "1080"];

const intentBody = (r: { requests: Recorded[] }) => {
  const q = r.requests.filter((x) => x.url.startsWith("/v1/auth/intent"));
  expect(q, "exactly one connect request").toHaveLength(1);
  return JSON.parse(q[0]!.body) as Record<string, unknown>;
};
const patchBody = (r: { requests: Recorded[] }) => {
  const q = r.requests.filter((x) => x.method === "PATCH");
  expect(q, "exactly one PATCH").toHaveLength(1);
  return JSON.parse(q[0]!.body) as Record<string, unknown>;
};

describe("account link: a new connect names exactly one location", () => {
  it("no location: exit 2, a guiding message, and NO request; the same call with --country connects", async () => {
    const refused = await run(LINK);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("--country");
    expect(refused.stderr).toContain("--ip");
    expect(refused.stderr).toContain("--proxy-host");
    expect(refused.stderr).not.toContain("—");
    expect(refused.requests).toEqual([]);

    const control = await run([...LINK, "--country", "US"]);
    expect(control.status, control.stderr).toBe(0);
    expect(intentBody(control)).toMatchObject({ country: "US" });
  });

  it("no location and no --seat-id: refused before the seats read too", async () => {
    const r = await run(LINK.filter((a, i) => a !== "--seat-id" && LINK[i - 1] !== "--seat-id"));
    expect(r.status).toBe(2);
    expect(r.requests).toEqual([]);
  });

  it("two location sources: exit 2 naming both, no request", async () => {
    for (const extra of [
      ["--country", "US", "--ip", "8.8.8.8"],
      ["--country", "US", ...PROXY],
      ["--ip", "8.8.8.8", ...PROXY],
    ]) {
      const r = await run([...LINK, ...extra]);
      expect(r.status, extra.join(" ")).toBe(2);
      expect(r.stderr).toMatch(/one location source/);
      expect(r.requests, extra.join(" ")).toEqual([]);
    }
  });

  it("a reconnect also refuses two sources", async () => {
    const r = await run([...RECONNECT, "--country", "US", "--ip", "8.8.8.8"]);
    expect(r.status).toBe(2);
    expect(r.requests).toEqual([]);
  });

  it("a lowercase country code is sent upper-case", async () => {
    const r = await run([...LINK, "--country", "de"]);
    expect(r.status, r.stderr).toBe(0);
    expect(intentBody(r)["country"]).toBe("DE");
  });

  it("a value that is not a two-letter code is refused before the request; an empty one too", async () => {
    for (const bad of ["USA", "1", "", " "]) {
      const r = await run([...LINK, "--country", bad]);
      expect(r.status, JSON.stringify(bad)).toBe(2);
      expect(r.stderr).toContain("--country");
      expect(r.requests, JSON.stringify(bad)).toEqual([]);
    }
  });

  it("an empty --ip or --proxy-host (an unset shell variable) is refused before the request", async () => {
    for (const extra of [["--ip", ""], ["--proxy-host", ""], ["--ip", " "]]) {
      const r = await run([...LINK, ...extra]);
      expect(r.status, extra.join(" ")).toBe(2);
      expect(r.stderr).toContain("empty value");
      expect(r.requests, extra.join(" ")).toEqual([]);
    }
  });

  it("a well-formed code the API does not serve is sent, and its 400 exits 2", async () => {
    intentReply = {
      status: 400,
      body: {
        code: "INVALID_REQUEST",
        message: "country: unsupported. Use `proxy` for a location we don't serve.",
        user_fixable: true,
        retry_likely_to_succeed: false,
      },
    };
    const r = await run([...LINK, "--country", "xx"]);
    expect(r.status).toBe(2);
    expect(intentBody(r)["country"]).toBe("XX");
    expect(r.stdout + r.stderr).toContain("INVALID_REQUEST");
  });

  it("--ip and --proxy-host are each a location on their own", async () => {
    const ip = await run([...LINK, "--ip", "8.8.8.8"]);
    expect(ip.status, ip.stderr).toBe(0);
    expect(intentBody(ip)).toMatchObject({ ip: "8.8.8.8" });
    expect(intentBody(ip)).not.toHaveProperty("country");

    const proxy = await run([...LINK, ...PROXY, "--proxy-protocol", "socks4"]);
    expect(proxy.status, proxy.stderr).toBe(0);
    expect(intentBody(proxy)["proxy"]).toEqual({ protocol: "socks4", host: "proxy.example.com", port: 1080 });
    expect(intentBody(proxy)).not.toHaveProperty("allow_country_fallback");
  });
});

describe("account link: --allow-country-fallback", () => {
  it("is sent with --country (true, and false when negated); omitted when not given", async () => {
    const on = await run([...LINK, "--country", "US", "--allow-country-fallback"]);
    expect(intentBody(on)["allow_country_fallback"]).toBe(true);
    const off = await run([...LINK, "--country", "US", "--no-allow-country-fallback"]);
    expect(intentBody(off)["allow_country_fallback"]).toBe(false);
    const unset = await run([...LINK, "--country", "US"]);
    expect(intentBody(unset)).not.toHaveProperty("allow_country_fallback");
  });

  it("with your own proxy: exit 2, no request", async () => {
    const r = await run([...LINK, ...PROXY, "--allow-country-fallback"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--allow-country-fallback");
    expect(r.requests).toEqual([]);
  });

  it("on a reconnect without --country or --ip: exit 2, no request (the API would ignore it)", async () => {
    const refused = await run([...RECONNECT, "--allow-country-fallback"]);
    expect(refused.status).toBe(2);
    expect(refused.requests).toEqual([]);

    const control = await run([...RECONNECT, "--country", "NL", "--allow-country-fallback"]);
    expect(control.status, control.stderr).toBe(0);
    expect(intentBody(control)).toMatchObject({ account_id: "acc_1", country: "NL", allow_country_fallback: true });
  });
});

describe("account link --account-id: a reconnect may keep its location", () => {
  it("sends no location keys when none is given", async () => {
    intentReply = { status: 200, body: { object: "account", account_id: "acc_1", status: "active" } };
    const r = await run(RECONNECT);
    expect(r.status, r.stderr).toBe(0);
    const body = intentBody(r);
    expect(body).toMatchObject({ account_id: "acc_1" });
    for (const k of ["country", "ip", "proxy", "allow_country_fallback"]) expect(body).not.toHaveProperty(k);
  });
});

describe("account link --preview: re-derived from the location rules", () => {
  it("without a location: exit 2 and nothing rendered; with one, the rendered body carries the normalised country", async () => {
    const refused = await run([...LINK, "--preview"]);
    expect(refused.status).toBe(2);
    expect(refused.stdout).toBe("");
    expect(refused.requests).toEqual([]);

    const r = await run([...LINK, "--preview", "--country", "de", "--allow-country-fallback"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.requests).toEqual([]);
    const preview = JSON.parse(r.stdout) as { body: Record<string, unknown> };
    expect(preview.body).toMatchObject({ country: "DE", allow_country_fallback: true });
  });
});

describe("account update: --country moves the account and prints where it connects from", () => {
  it("--country US sends country:\"US\" and prints the returned connection_location", async () => {
    const r = await run(["account", "update", "acc_1", "--country", "US"]);
    expect(r.status, r.stderr).toBe(0);
    expect(patchBody(r)).toEqual({ country: "US" });
    // The response's location, with fields the request never carried (mode,
    // strict, current_country): printed from the API's answer, not echoed.
    expect((JSON.parse(r.stdout) as { connection_location: unknown }).connection_location).toEqual(RETURNED_LOCATION);

    const lower = await run(["account", "update", "acc_1", "--country", "us", "--json"]);
    expect(patchBody(lower)).toEqual({ country: "US" });
  });

  it("--allow-country-fallback alone changes strictness", async () => {
    const r = await run(["account", "update", "acc_1", "--allow-country-fallback", "--json"]);
    expect(r.status, r.stderr).toBe(0);
    expect(patchBody(r)).toEqual({ allow_country_fallback: true });
  });

  it("--clear-proxy needs --country: refused alone, no request; sent together", async () => {
    const refused = await run(["account", "update", "acc_1", "--clear-proxy"]);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("--country");
    expect(refused.requests).toEqual([]);

    const control = await run(["account", "update", "acc_1", "--clear-proxy", "--country", "DE", "--json"]);
    expect(control.status, control.stderr).toBe(0);
    expect(patchBody(control)).toEqual({ proxy: null, country: "DE" });
  });

  it("--country with --proxy-host, or with --allow-country-fallback and a proxy: exit 2, no request", async () => {
    for (const extra of [["--country", "US", ...PROXY], [...PROXY, "--allow-country-fallback"]]) {
      const r = await run(["account", "update", "acc_1", ...extra]);
      expect(r.status, extra.join(" ")).toBe(2);
      expect(r.requests, extra.join(" ")).toEqual([]);
    }
  });

  it("a malformed --country is refused before the request", async () => {
    const r = await run(["account", "update", "acc_1", "--country", "Germany"]);
    expect(r.status).toBe(2);
    expect(r.requests).toEqual([]);
  });
});
