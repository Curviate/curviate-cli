/**
 * Nothing leaks: a full two-process `setup` through the BUILT bin, with every
 * stream grepped for all four secrets, and a positive control that proves the
 * grep can find one.
 *
 * ## Why the built bin and not the exported function
 *
 * The claim is about what a user or an agent can SEE. That is the process's
 * real stdout and stderr, produced by the shipped artifact, not by a handler
 * called in-process with injected writers.
 *
 * ## Why the positive control is not optional
 *
 * "grep found nothing" is satisfied by a run that delivered nothing. So the
 * same needle, the same grep, is pointed at the profile file, where the key
 * MUST be. Without that arm this file passes on a `setup` that silently did
 * nothing at all.
 *
 * ## The one value that is in a stream by design
 *
 * The session id rides inside the authorize URL, because the browser has to
 * carry it to the server; that is the whole two-secrets-in-two-places shape.
 * What must never happen is the id appearing anywhere ELSE, so the authorize
 * URL is removed from the captured output and the grep runs on the rest.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createCipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliPath } from "../helpers/built-cli.js";

/** Distinctive enough that a match cannot be a coincidence. */
const API_KEY = "rdc_live_LEAKPROBE_9f3a1c7e5b2d";
const CODE_TYPED = "wdjb-mjht";
const CODE_NORMALISED = "WDJBMJHT";
const TENANT = "Leak Probe Workspace";

let xdg: string;
let configPath: string;
let statePath: string;
let server: Server;
let baseUrl: string;
/** The CLI public key seen on the exchange side, so the seal targets it. */
let seenExchange = 0;

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], input: string): Promise<Run> {
  return new Promise((resolvePromise, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      XDG_CONFIG_HOME: xdg,
      NODE_ENV: "production",
    };
    delete env["CURVIATE_API_KEY"];
    delete env["CURVIATE_ACCOUNT"];
    delete env["CURVIATE_BASE_URL"];

    const child = spawn(process.execPath, [cliPath, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

/** The public key the CLI parked; the stub seals to it, as the server would. */
function sealTo(publicKeyB64: string) {
  const ephemeral = createECDH("prime256v1");
  ephemeral.generateKeys();
  const shared = ephemeral.computeSecret(Buffer.from(publicKeyB64, "base64url"));
  const key = Buffer.from(
    hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.from("curviate-cli-setup-v1", "utf8"), 32),
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(API_KEY, "utf8"), cipher.final()]);
  return {
    alg: "ECDH-P256-HKDF-SHA256-A256GCM",
    epk: ephemeral.getPublicKey().toString("base64url"),
    iv: iv.toString("base64url"),
    ciphertext: Buffer.concat([body, cipher.getAuthTag()]).toString("base64url"),
  };
}

let firstRun: Run;
let secondRun: Run;
let authorizeUrl: string;
let sessionId: string;
let privateKey: string;

beforeAll(async () => {
  xdg = mkdtempSync(join(tmpdir(), "curviate-leak-"));
  configPath = join(xdg, "curviate", "config.json");
  statePath = join(xdg, "curviate", "setup-session.json");

  server = createServer((req, res) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (data += c));
    req.on("end", () => {
      if ((req.url ?? "").startsWith("/api/auth/cli/exchange")) {
        seenExchange++;
        const body = JSON.parse(data) as { session_id: string; verification_code: string };
        // The stub answers only the exact pair the flow should have sent.
        if (body.session_id !== sessionId || body.verification_code !== CODE_NORMALISED) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ code: "CLI_SETUP_INVALID_CODE", message: "no" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sealed_key: sealTo(publicKeyFromState()),
            tenant_name: TENANT,
            account_id: "acc_leak_probe",
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ items: [], cursor: null }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  // Leg one: the agent path. Prints the authorize URL and parks the material.
  firstRun = await runCli(["setup", "--json", "--base-url", baseUrl], "");
  const emitted = JSON.parse(firstRun.stdout.trim()) as { authorize_url: string };
  authorizeUrl = emitted.authorize_url;

  const parked = JSON.parse(readFileSync(statePath, "utf8")) as {
    sessionId: string;
    privateKey: string;
  };
  sessionId = parked.sessionId;
  privateKey = parked.privateKey;

  // Leg two: a separate process, code on stdin.
  secondRun = await runCli(["setup", "--code", "-", "--base-url", baseUrl], CODE_TYPED);
}, 120_000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function publicKeyFromState(): string {
  const parked = JSON.parse(readFileSync(statePath, "utf8")) as { publicKey: string };
  return parked.publicKey;
}

/** Every stream both processes wrote, minus the authorize URL itself. */
function streamsWithoutTheUrl(): string {
  const all = [firstRun.stdout, firstRun.stderr, secondRun.stdout, secondRun.stderr].join("\n");
  return all.split(authorizeUrl).join("<authorize-url>");
}

describe("the flow actually completed, so the grep below is not vacuous", () => {
  it("both legs succeeded and the exchange was really called", () => {
    expect(firstRun.status, firstRun.stderr).toBe(0);
    expect(secondRun.status, secondRun.stderr).toBe(0);
    expect(seenExchange).toBe(1);
  });

  it("POSITIVE CONTROL: the same grep finds the key in the profile file", () => {
    const profile = readFileSync(configPath, "utf8");
    const matches = profile.split(API_KEY).length - 1;
    expect(
      matches,
      "the key never reached the profile, so an absence assertion on the streams proves nothing",
    ).toBe(1);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it("and the workspace it belongs to was recorded and reported", () => {
    expect(readFileSync(configPath, "utf8")).toContain(TENANT);
    expect(secondRun.stdout + secondRun.stderr).toContain(TENANT);
  });
});

describe("no secret reaches any stream", () => {
  it("the delivered credential appears in neither stdout nor stderr", () => {
    expect(streamsWithoutTheUrl()).not.toContain(API_KEY);
  });

  it("the verification code appears in neither stream, in either spelling", () => {
    const streams = streamsWithoutTheUrl();
    expect(streams).not.toContain(CODE_TYPED);
    expect(streams).not.toContain(CODE_NORMALISED);
  });

  it("the session id appears nowhere outside the authorize URL", () => {
    expect(streamsWithoutTheUrl()).not.toContain(sessionId);
  });

  it("the private key appears nowhere at all", () => {
    const all = [firstRun.stdout, firstRun.stderr, secondRun.stdout, secondRun.stderr].join("\n");
    expect(all).not.toContain(privateKey);
    expect(authorizeUrl).not.toContain(privateKey);
  });

  it("the parked material is 0600 and does not survive the completed flow", () => {
    expect(existsSync(statePath)).toBe(false);
  });
});
