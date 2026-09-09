/**
 * `curviate setup` - the flow, its ordering, its retries, and its refusals.
 *
 * Everything the command touches that is not pure is injected: the terminal
 * (an unmasked line reader), the transport, the browser opener, the verifying
 * call and the session-material generator. Nothing here reaches a real
 * terminal, a real browser, or the network.
 *
 * Paste ergonomics and the leak grep live in sibling files, because both need
 * a different harness: one drives the REAL reader over a fake stream, the
 * other greps every stream against a positive control.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createECDH,
  createCipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { mkdtempSync, readFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runSetup,
  resumeStatePath,
  normaliseCode,
  authorizeUrl,
  browserAvailable,
  generateSessionMaterial,
  unsealApiKey,
  type SetupIO,
  type SessionMaterial,
} from "../../src/commands/setup.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const API_KEY = "rdc_live_SETUPFIXTUREKEY0001";
const TENANT = "Fixture Workspace";
const CODE = "WDJB-MJHT";
const BASE_URL = "http://127.0.0.1:9/api";

/** A pinned keypair, so a test can assert on the exact public key in the URL. */
function pinnedMaterial(): SessionMaterial {
  return generateSessionMaterial();
}

/**
 * Seal `plaintext` to the CLI's public key exactly as the server does, so the
 * unsealing under test is exercised against a real, independently-built
 * ciphertext rather than a fixture the implementation also produced.
 */
function seal(plaintext: string, cliPublicKeyB64: string) {
  const ephemeral = createECDH("prime256v1");
  ephemeral.generateKeys();
  const shared = ephemeral.computeSecret(Buffer.from(cliPublicKeyB64, "base64url"));
  const key = Buffer.from(
    hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.from("curviate-cli-setup-v1", "utf8"), 32),
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    alg: "ECDH-P256-HKDF-SHA256-A256GCM",
    epk: ephemeral.getPublicKey().toString("base64url"),
    iv: iv.toString("base64url"),
    ciphertext: Buffer.concat([body, cipher.getAuthTag()]).toString("base64url"),
  };
}

interface Harness {
  io: SetupIO;
  stdout: string[];
  stderr: string[];
  /** Every prompt string the command wrote, in order. */
  prompts: string[];
  /** Every URL handed to the browser opener. */
  opened: string[];
  /** Every exchange request body, parsed. */
  requests: Array<{ session_id: string; verification_code: string }>;
  /** Was the stdin reader ever called? */
  stdinReads: number;
  material: SessionMaterial;
  /** Interleaved transcript, so ordering is assertable. */
  transcript: string[];
}

type Responder = (
  body: { session_id: string; verification_code: string },
  material: SessionMaterial,
) => { status: number; json: unknown } | "network-failure";

/** The server arm that always accepts. */
const acceptAll: Responder = (_body, material) => ({
  status: 200,
  json: {
    sealed_key: seal(API_KEY, material.publicKey),
    tenant_name: TENANT,
    account_id: "acc_fixture_1",
  },
});

function harness(opts: {
  answers: string[];
  respond?: Responder;
  isTTY?: boolean;
  isOutputTTY?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  stdin?: string;
  verifyFails?: boolean;
  openThrows?: boolean;
}): Harness {
  const material = pinnedMaterial();
  const h: Partial<Harness> = {
    stdout: [],
    stderr: [],
    prompts: [],
    opened: [],
    requests: [],
    stdinReads: 0,
    material,
    transcript: [],
  };
  const respond = opts.respond ?? acceptAll;
  const answers = [...opts.answers];

  h.io = {
    stdout: {
      write: (s: string) => {
        h.stdout!.push(s);
        h.transcript!.push(`stdout:${s}`);
      },
    },
    stderr: {
      write: (s: string) => {
        h.stderr!.push(s);
        h.transcript!.push(`stderr:${s}`);
      },
    },
    isTTY: opts.isTTY ?? true,
    isOutputTTY: opts.isOutputTTY ?? true,
    env: opts.env ?? {},
    platform: opts.platform ?? "darwin",
    prompt: async (p: string) => {
      h.prompts!.push(p);
      h.transcript!.push(`prompt:${p}`);
      return answers.shift() ?? "";
    },
    readStdin: async () => {
      h.stdinReads!++;
      return opts.stdin ?? "";
    },
    open: async (url: string) => {
      h.opened!.push(url);
      h.transcript!.push(`open:${url}`);
      if (opts.openThrows) throw new Error("no browser");
      return undefined;
    },
    fetch: (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        session_id: string;
        verification_code: string;
      };
      h.requests!.push(body);
      const outcome = respond(body, material);
      if (outcome === "network-failure") throw new TypeError("fetch failed");
      return {
        ok: outcome.status >= 200 && outcome.status < 300,
        status: outcome.status,
        json: async () => outcome.json,
      } as unknown as Response;
    }) as unknown as typeof fetch,
    verify: async () => {
      if (opts.verifyFails) throw new Error("rejected");
    },
    generate: () => material,
  };
  return h as Harness;
}

let xdg: string;
let configPath: string;

beforeEach(() => {
  xdg = mkdtempSync(join(tmpdir(), "curviate-setup-"));
  process.env["XDG_CONFIG_HOME"] = xdg;
  configPath = join(xdg, "curviate", "config.json");
  delete process.env["CURVIATE_API_KEY"];
  delete process.env["CURVIATE_BASE_URL"];
});

afterEach(() => {
  delete process.env["XDG_CONFIG_HOME"];
  rmSync(xdg, { recursive: true, force: true });
});

function storedProfile(name = "default") {
  const cfg = JSON.parse(readFileSync(configPath, "utf8")) as {
    profiles: Record<string, { apiKey?: string; account?: string; tenant?: string }>;
  };
  return cfg.profiles[name];
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("normalisation accepts every shape a paste arrives in", () => {
  it("uppercases, drops the hyphen, and drops everything outside the alphabet", () => {
    expect(normaliseCode("WDJB-MJHT")).toBe("WDJBMJHT");
    expect(normaliseCode("wdjb-mjht")).toBe("WDJBMJHT");
    expect(normaliseCode("wdjbmjht")).toBe("WDJBMJHT");
    expect(normaliseCode("  WDJB-MJHT  \n")).toBe("WDJBMJHT");
    // A bracketed paste arrives wrapped in the two escape sequences.
    expect(normaliseCode("\x1b[200~wdjb-mjht\x1b[201~")).toBe("WDJBMJHT");
  });

  it("drops out-of-alphabet letters rather than passing them through", () => {
    // A, E, I, O, U and every digit are deliberately absent from the alphabet.
    expect(normaliseCode("WDJB-MJHTAEIOU0159")).toBe("WDJBMJHT");
  });
});

describe("session material carries real entropy and never a guessable id", () => {
  it("the session id is 144 bits, well above the floor", () => {
    const m = generateSessionMaterial();
    expect(Buffer.from(m.sessionId, "base64url").length * 8).toBe(144);
  });

  it("two runs never produce the same session id or public key", () => {
    const a = generateSessionMaterial();
    const b = generateSessionMaterial();
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.publicKey).not.toBe(b.publicKey);
  });

  it("the public key is a raw uncompressed point", () => {
    const raw = Buffer.from(generateSessionMaterial().publicKey, "base64url");
    expect(raw.length).toBe(65);
    expect(raw[0]).toBe(0x04);
  });
});

describe("the authorize URL", () => {
  it("strips a trailing api path and carries both values", () => {
    const url = new URL(authorizeUrl("https://example.test/api", "SID", "PK"));
    expect(url.pathname).toBe("/cli");
    expect(url.searchParams.get("sid")).toBe("SID");
    expect(url.searchParams.get("pk")).toBe("PK");
  });

  it("works against an origin with no path", () => {
    expect(authorizeUrl("https://example.test", "S", "P")).toBe(
      "https://example.test/cli?sid=S&pk=P",
    );
  });

  /**
   * The page and the API are different hosts, and the dashboard session
   * cookie lives on the page's host. Deriving the page from the API origin
   * printed a link that lands somewhere with no session, so the flow could
   * not complete anywhere it is actually deployed. Nothing asserted the host
   * before, which is why that shipped.
   */
  it("points at the app host, not the api host, on the default base url", () => {
    expect(new URL(authorizeUrl("https://api.curviate.com", "S", "P")).host).toBe(
      "app.curviate.com",
    );
  });

  it("keeps the rest of the labels when swapping the first one", () => {
    expect(new URL(authorizeUrl("https://api.staging.curviate.com", "S", "P")).host).toBe(
      "app.staging.curviate.com",
    );
  });

  it("leaves a host with no api label alone, port and all", () => {
    // One origin serves both surfaces on a local run, an IP, or a custom base.
    expect(new URL(authorizeUrl("http://localhost:3000", "S", "P")).host).toBe("localhost:3000");
    expect(new URL(authorizeUrl("http://127.0.0.1:8080/api", "S", "P")).host).toBe(
      "127.0.0.1:8080",
    );
    // Bare "api" with no domain after it is a hostname, not a first label to swap.
    expect(new URL(authorizeUrl("http://api:3000", "S", "P")).host).toBe("api:3000");
  });

  it("an explicit override wins over both rules", () => {
    expect(authorizeUrl("https://api.curviate.com", "S", "P", "https://dash.example.test")).toBe(
      "https://dash.example.test/cli?sid=S&pk=P",
    );
    // A path on the override is kept, so a surface mounted under a prefix works.
    expect(
      authorizeUrl("https://api.curviate.com", "S", "P", "https://example.test/console/"),
    ).toBe("https://example.test/console/cli?sid=S&pk=P");
  });
});

describe("the override reaches the command, not just the helper", () => {
  it("a run with the override set prints the overridden host", async () => {
    const h = harness({
      answers: [CODE],
      env: { CI: "1", CURVIATE_APP_URL: "https://dash.example.test" },
    });
    await runSetup({ "base-url": "https://api.curviate.com" }, h.io);
    expect(h.stdout.join("")).toContain("https://dash.example.test/cli?sid=");
  });

  it("a run without it derives the app host from the api host", async () => {
    const h = harness({ answers: [CODE], env: { CI: "1" } });
    await runSetup({ "base-url": "https://api.curviate.com" }, h.io);
    expect(h.stdout.join("")).toContain("https://app.curviate.com/cli?sid=");
  });
});

describe("unsealing round-trips against an independently built ciphertext", () => {
  it("recovers the exact plaintext", () => {
    const m = generateSessionMaterial();
    expect(unsealApiKey(seal(API_KEY, m.publicKey), m.privateKey)).toBe(API_KEY);
  });

  it("refuses a payload sealed to a different key", () => {
    const mine = generateSessionMaterial();
    const theirs = generateSessionMaterial();
    expect(() => unsealApiKey(seal(API_KEY, theirs.publicKey), mine.privateKey)).toThrow();
  });
});

describe("browser detection is a reading of the environment, not a flag", () => {
  it("continuous integration, a remote shell, and a displayless session are all browserless", () => {
    expect(browserAvailable({ CI: "1" }, "darwin")).toBe(false);
    expect(browserAvailable({ SSH_CONNECTION: "1.2.3.4 1 5.6.7.8 22" }, "darwin")).toBe(false);
    expect(browserAvailable({ SSH_TTY: "/dev/pts/0" }, "darwin")).toBe(false);
    expect(browserAvailable({ SSH_CLIENT: "1.2.3.4" }, "darwin")).toBe(false);
    expect(browserAvailable({ DISPLAY: "" }, "linux")).toBe(false);
    expect(browserAvailable({}, "linux")).toBe(false);
  });

  it("a plain desktop session is not", () => {
    expect(browserAvailable({}, "darwin")).toBe(true);
    expect(browserAvailable({ DISPLAY: ":0" }, "linux")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

describe("the happy path", () => {
  it("writes the key at 0600, verifies, names the workspace, exits 0", async () => {
    const h = harness({ answers: [CODE] });
    const exit = await runSetup({ "base-url": BASE_URL }, h.io);

    expect(exit).toBe(0);
    const profile = storedProfile();
    expect(profile?.apiKey).toBe(API_KEY);
    expect(profile?.account).toBe("acc_fixture_1");
    expect(profile?.tenant).toBe(TENANT);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(h.stderr.join("")).toContain(TENANT);
  });

  it("submits the normalised code and the session id, and nothing else", async () => {
    const h = harness({ answers: ["  wdjbmjht \n"] });
    await runSetup({ "base-url": BASE_URL }, h.io);

    expect(h.requests).toEqual([
      { session_id: h.material.sessionId, verification_code: "WDJBMJHT" },
    ]);
  });

  it("writes to the named profile and leaves the default alone", async () => {
    const h = harness({ answers: [CODE] });
    await runSetup({ "base-url": BASE_URL, profile: "work" }, h.io);
    expect(storedProfile("work")?.apiKey).toBe(API_KEY);
    expect(storedProfile("default")).toBeUndefined();
  });

  it("removes the parked session material once the flow completes", async () => {
    const h = harness({ answers: [CODE] });
    await runSetup({ "base-url": BASE_URL }, h.io);
    expect(existsSync(resumeStatePath())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Ordering: the URL comes out before anything can block
// ---------------------------------------------------------------------------

describe("the authorize URL is printed before any prompt or gate", () => {
  it("the URL reaches a stream before the first prompt is written", async () => {
    const h = harness({ answers: [CODE] });
    await runSetup({ "base-url": BASE_URL }, h.io);

    // A STREAM write, not any transcript entry: the browser-open entry also
    // carries the URL, and counting it would let a run that never printed
    // anything pass this assertion.
    const urlAt = h.transcript.findIndex(
      (line) =>
        (line.startsWith("stdout:") || line.startsWith("stderr:")) && line.includes("/cli?sid="),
    );
    const promptAt = h.transcript.findIndex((line) => line.startsWith("prompt:"));
    expect(urlAt, "the authorize URL was never printed").toBeGreaterThanOrEqual(0);
    expect(promptAt, "the prompt never happened").toBeGreaterThanOrEqual(0);
    expect(urlAt).toBeLessThan(promptAt);
  });

  it("the URL is printed before the browser open is even attempted", async () => {
    const h = harness({ answers: [CODE] });
    await runSetup({ "base-url": BASE_URL }, h.io);
    const urlAt = h.transcript.findIndex(
      (line) => line.startsWith("stdout:") && line.includes("/cli?sid="),
    );
    const openAt = h.transcript.findIndex((line) => line.startsWith("open:"));
    expect(urlAt).toBeGreaterThanOrEqual(0);
    expect(openAt).toBeGreaterThanOrEqual(0);
    expect(openAt).toBeGreaterThan(urlAt);
  });

  it("the URL is still printed when there is no terminal to prompt on", async () => {
    const h = harness({ answers: [], isTTY: false });
    const exit = await runSetup({ "base-url": BASE_URL }, h.io);
    expect(h.stdout.join("")).toContain("/cli?sid=");
    expect(exit).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Retries and the three distinct messages
// ---------------------------------------------------------------------------

/** A responder that rejects the first `n` submissions, then accepts. */
function rejectFirst(n: number): Responder {
  let seen = 0;
  return (body, material) => {
    if (seen++ < n) {
      return { status: 400, json: { code: "CLI_SETUP_INVALID_CODE", message: "no" } };
    }
    return acceptAll(body, material);
  };
}

describe("a wrong code re-prompts in place", () => {
  it("offers exactly two retries, labelled, and succeeds on the third", async () => {
    const h = harness({ answers: ["ZZZZZZZZ", "XXXXXXXX", CODE], respond: rejectFirst(2) });
    const exit = await runSetup({ "base-url": BASE_URL }, h.io);

    expect(exit).toBe(0);
    expect(h.prompts).toEqual(["Paste the code: ", "Retry (1/2): ", "Retry (2/2): "]);
    expect(storedProfile()?.apiKey).toBe(API_KEY);
  });

  it("gives up after the third wrong code, exit 3, profile untouched", async () => {
    const h = harness({
      answers: ["ZZZZZZZZ", "XXXXXXXX", "VVVVVVVV"],
      respond: rejectFirst(99),
    });
    const exit = await runSetup({ "base-url": BASE_URL }, h.io);

    expect(exit).toBe(3);
    expect(h.requests).toHaveLength(3);
    // Byte-identical to before the run: the file was never created at all.
    expect(existsSync(configPath)).toBe(false);
  });
});

describe("a wrong code, an expired code and an unreachable API read differently", () => {
  const messages: Record<string, string> = {};

  it("collects each arm's message and exit code", async () => {
    const wrong = harness({
      answers: ["ZZZZZZZZ", "XXXXXXXX", "VVVVVVVV"],
      respond: rejectFirst(99),
    });
    expect(await runSetup({ "base-url": BASE_URL }, wrong.io)).toBe(3);
    messages["wrong"] = wrong.stderr.filter((l) => l.startsWith("error:")).join("");

    const expired = harness({
      answers: [CODE],
      respond: () => ({ status: 400, json: { code: "CLI_SETUP_EXPIRED", message: "gone" } }),
    });
    expect(await runSetup({ "base-url": BASE_URL }, expired.io)).toBe(3);
    messages["expired"] = expired.stderr.filter((l) => l.startsWith("error:")).join("");

    const down = harness({ answers: [CODE], respond: () => "network-failure" });
    expect(await runSetup({ "base-url": BASE_URL }, down.io)).toBe(7);
    messages["unreachable"] = down.stderr.filter((l) => l.startsWith("error:")).join("");

    // Every arm actually produced a message, so the distinctness assertion
    // below cannot pass on three empty strings.
    for (const [arm, text] of Object.entries(messages)) {
      expect(text.length, `${arm} produced no message`).toBeGreaterThan(20);
    }
    expect(new Set(Object.values(messages)).size).toBe(3);
  });

  it("an expired code is not retried", async () => {
    const h = harness({
      answers: [CODE, CODE, CODE],
      respond: () => ({ status: 400, json: { code: "CLI_SETUP_EXPIRED", message: "gone" } }),
    });
    await runSetup({ "base-url": BASE_URL }, h.io);
    expect(h.requests).toHaveLength(1);
    expect(h.prompts).toHaveLength(1);
  });

  it("a revoked key surfaces the server's own actionable message, exit 3", async () => {
    const named = "This workspace has no API key. Create one in the dashboard.";
    const h = harness({
      answers: [CODE],
      respond: () => ({ status: 409, json: { code: "CLI_SETUP_NO_API_KEY", message: named } }),
    });
    expect(await runSetup({ "base-url": BASE_URL }, h.io)).toBe(3);
    expect(h.stderr.join("")).toContain(named);
  });

  it("the endpoint cap exits 6", async () => {
    const h = harness({
      answers: [CODE],
      respond: () => ({ status: 429, json: { code: "PLATFORM_RATE_LIMIT", message: "slow down" } }),
    });
    expect(await runSetup({ "base-url": BASE_URL }, h.io)).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Headless, detected rather than flagged
// ---------------------------------------------------------------------------

describe("headless environments are detected", () => {
  for (const [label, env, platform] of [
    ["continuous integration", { CI: "true" }, "darwin"],
    ["a remote shell", { SSH_CONNECTION: "1.2.3.4 1 5.6.7.8 22" }, "darwin"],
    ["a displayless session", { DISPLAY: "" }, "linux"],
  ] as const) {
    it(`${label}: no open attempted, URL still printed, paste still works`, async () => {
      const h = harness({ answers: [CODE], env, platform });
      const exit = await runSetup({ "base-url": BASE_URL }, h.io);

      expect(h.opened).toEqual([]);
      expect(h.stdout.join("")).toContain("/cli?sid=");
      expect(h.prompts).toHaveLength(1);
      expect(exit).toBe(0);
    });
  }

  it("--no-browser where a browser exists says so rather than complying silently", async () => {
    const h = harness({ answers: [CODE], env: {}, platform: "darwin" });
    await runSetup({ "base-url": BASE_URL, "no-browser": true }, h.io);

    expect(h.opened).toEqual([]);
    expect(h.stderr.join("")).toMatch(/--no-browser/);
  });

  it("--no-browser where none exists says nothing extra", async () => {
    const h = harness({ answers: [CODE], env: { CI: "1" }, platform: "darwin" });
    await runSetup({ "base-url": BASE_URL, "no-browser": true }, h.io);
    expect(h.stderr.join("")).not.toMatch(/--no-browser/);
  });

  it("a browser that refuses to open is not an error", async () => {
    const h = harness({ answers: [CODE], openThrows: true });
    expect(await runSetup({ "base-url": BASE_URL }, h.io)).toBe(0);
  });
});

describe("a non-terminal invocation fails fast and never touches stdin", () => {
  it("names both remedies, exits 2, and the stdin reader is never called", async () => {
    const h = harness({ answers: [], isTTY: false, stdin: "WDJBMJHT" });
    const exit = await runSetup({ "base-url": BASE_URL }, h.io);

    expect(exit).toBe(2);
    const said = h.stderr.join("");
    expect(said).toContain("CURVIATE_API_KEY");
    expect(said).toContain("curviate login --api-key -");
    // Not merely "it exited": it must never have READ, or a piped secret is
    // consumed by a command that then refuses to use it.
    expect(h.stdinReads).toBe(0);
    expect(h.prompts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The agent path
// ---------------------------------------------------------------------------

describe("setup --json is the agent path", () => {
  it("emits one object with the URL and a literally runnable next step", async () => {
    const h = harness({ answers: [] });
    const exit = await runSetup({ "base-url": BASE_URL, json: true }, h.io);

    expect(exit).toBe(0);
    expect(h.stdout).toHaveLength(1);
    const emitted = JSON.parse(h.stdout[0]!) as Record<string, unknown>;
    expect(emitted["authorize_url"]).toContain("/cli?sid=");
    expect(emitted["next_step"]).toBe("curviate setup --code -");
    // The session id rides INSIDE authorize_url by design (it is one half of
    // the two secrets redemption needs, and the browser must carry it back);
    // what must never appear is a separate field exposing it, the private
    // key, the code, or the delivered credential.
    expect(Object.keys(emitted).sort()).toEqual([
      "authorize_url",
      "instructions",
      "next_step",
    ]);
    expect(h.stdout.join("")).not.toContain(h.material.privateKey);
    expect(h.stderr.join("")).not.toContain(h.material.sessionId);
  });

  it("does not prompt, does not open a browser, and does not call the API", async () => {
    const h = harness({ answers: [] });
    await runSetup({ "base-url": BASE_URL, json: true }, h.io);
    expect(h.prompts).toEqual([]);
    expect(h.opened).toEqual([]);
    expect(h.requests).toEqual([]);
  });

  it("parks the session material at 0600 so a second process can finish", async () => {
    const h = harness({ answers: [] });
    await runSetup({ "base-url": BASE_URL, json: true }, h.io);
    expect(existsSync(resumeStatePath())).toBe(true);
    expect(statSync(resumeStatePath()).mode & 0o777).toBe(0o600);
  });
});

describe("setup --code - resumes a flow another process started", () => {
  it("reads the code from stdin and lands the key", async () => {
    const first = harness({ answers: [] });
    await runSetup({ "base-url": BASE_URL, json: true }, first.io);

    // A SEPARATE invocation: a fresh harness, generating fresh material it
    // must NOT use, so a resume that silently started over would fail here.
    // The stub seals to the FIRST run's public key, so the assertion below
    // only passes if the resume recovered the parked private key too.
    const second = harness({
      answers: [],
      stdin: "wdjb-mjht",
      respond: () => ({
        status: 200,
        json: { sealed_key: seal(API_KEY, first.material.publicKey), tenant_name: TENANT },
      }),
    });
    const exit = await runSetup({ code: "-", json: true }, second.io);

    expect(exit).toBe(0);
    expect(second.stdinReads).toBe(1);
    expect(second.requests).toEqual([
      { session_id: first.material.sessionId, verification_code: "WDJBMJHT" },
    ]);
    expect(storedProfile()?.apiKey).toBe(API_KEY);
  });

  it("clears the parked material once redeemed, so it cannot be replayed", async () => {
    const first = harness({ answers: [] });
    await runSetup({ "base-url": BASE_URL, json: true }, first.io);
    const second = harness({
      answers: [],
      stdin: CODE,
      respond: () => ({
        status: 200,
        json: { sealed_key: seal(API_KEY, first.material.publicKey), tenant_name: TENANT },
      }),
    });
    expect(await runSetup({ code: "-", json: true }, second.io)).toBe(0);

    expect(existsSync(resumeStatePath())).toBe(false);

    const third = harness({ answers: [], stdin: CODE });
    expect(await runSetup({ code: "-", json: true }, third.io)).toBe(2);
    expect(third.requests).toEqual([]);
  });

  it("with no flow in progress it says so instead of starting one", async () => {
    const h = harness({ answers: [], stdin: CODE });
    const exit = await runSetup({ code: "-", json: true }, h.io);
    expect(exit).toBe(2);
    expect(h.stderr.join("")).toContain("no setup is in progress");
  });

  it("a code given as a flag VALUE earns the ps/shell-history warning", async () => {
    const first = harness({ answers: [] });
    await runSetup({ "base-url": BASE_URL, json: true }, first.io);
    const second = harness({
      answers: [],
      respond: () => ({
        status: 200,
        json: { sealed_key: seal(API_KEY, first.material.publicKey), tenant_name: TENANT },
      }),
    });
    expect(await runSetup({ code: CODE, json: true }, second.io)).toBe(0);
    expect(second.stderr.join("")).toMatch(/shell history/);
    expect(second.stdinReads).toBe(0);
  });

  it("a code read from stdin earns no such warning", async () => {
    const first = harness({ answers: [] });
    await runSetup({ "base-url": BASE_URL, json: true }, first.io);
    const second = harness({
      answers: [],
      stdin: CODE,
      respond: () => ({
        status: 200,
        json: { sealed_key: seal(API_KEY, first.material.publicKey), tenant_name: TENANT },
      }),
    });
    expect(await runSetup({ code: "-", json: true }, second.io)).toBe(0);
    expect(second.stderr.join("")).not.toMatch(/shell history/);
  });
});

// ---------------------------------------------------------------------------
// Verification is a real call, not an assumption
// ---------------------------------------------------------------------------

describe("the credential is proven, not assumed", () => {
  it("a verifying call that fails is reported and exits 3", async () => {
    const h = harness({ answers: [CODE], verifyFails: true });
    expect(await runSetup({ "base-url": BASE_URL }, h.io)).toBe(3);
    expect(h.stderr.join("")).toMatch(/verifying call/);
  });
});

// ---------------------------------------------------------------------------
// Fully piped is the agent path, deliberately
// ---------------------------------------------------------------------------

describe("a fully piped invocation is the agent path, not the non-terminal refusal", () => {
  /**
   * Both streams non-TTY and no `--json`: the agent object is emitted and the
   * run exits 0, rather than falling into the fail-fast that names
   * CURVIATE_API_KEY. That is a deliberate product ruling, not an accident of
   * branch order, so it is pinned here. The fail-fast still owns the case a
   * human hits: a terminal for output, nothing on stdin.
   */
  it("emits the agent object and exits 0 with both streams piped", async () => {
    const h = harness({ answers: [], isTTY: false, isOutputTTY: false, stdin: CODE });
    const exit = await runSetup({ "base-url": BASE_URL }, h.io);

    expect(exit).toBe(0);
    const emitted = JSON.parse(h.stdout.join("")) as Record<string, unknown>;
    expect(emitted["next_step"]).toBe("curviate setup --code -");
    expect(h.stdinReads).toBe(0);
    expect(h.stderr.join("")).not.toContain("CURVIATE_API_KEY");
  });

  it("but a terminal for output with nothing on stdin still fails fast", async () => {
    const h = harness({ answers: [], isTTY: false, isOutputTTY: true, stdin: CODE });
    expect(await runSetup({ "base-url": BASE_URL }, h.io)).toBe(2);
    expect(h.stderr.join("")).toContain("CURVIATE_API_KEY");
  });
});
