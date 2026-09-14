/**
 * Credential-flag edge cases through the built bin: a repeated secret flag,
 * malformed secret-flag spellings, a stray value after `--api-key=`, short-key
 * masking in `config list`, and a non-numeric `--timeout`.
 *
 * Every refusal is checked for the sentinel on BOTH streams: a usage error
 * that exits 2 but prints the key is the defect, not the fix.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBin } from "./helpers/run-bin.js";

const K = "SENTINELkey7Q3Z9";
let xdg: string;

beforeEach(() => {
  xdg = mkdtempSync(join(tmpdir(), "curviate-cred-edges-"));
});

const configFile = () => join(xdg, "curviate", "config.json");

function refused(args: string[]) {
  const r = runBin(args, xdg);
  expect(r.status, `${args.join(" ")}\n${r.stdout}${r.stderr}`).toBe(2);
  expect(r.stdout + r.stderr).not.toContain(K);
  return r;
}

describe("a well-formed credential flag still works (positive control)", () => {
  it("login --api-key K saves the key and never prints it", () => {
    const r = runBin(["login", "--api-key", K], xdg);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(configFile())).toBe(true);
    expect(r.stdout + r.stderr).not.toContain(K);
  });

  it("login --api-key=K works too", () => {
    const r = runBin(["login", `--api-key=${K}`], xdg);
    expect(r.status, r.stderr).toBe(0);
  });
});

describe("a repeated secret flag is a usage error", () => {
  it("login --api-key=K --api-key=K exits 2 without a crash", () => {
    const r = refused(["login", `--api-key=${K}`, `--api-key=${K}`]);
    expect(r.stderr).toMatch(/--api-key.*more than once/);
    expect(r.stderr).not.toMatch(/is not a function/);
  });

  it("the space-separated repeat too, on an API command", () => {
    const r = refused(["profile", "me", "--api-key", K, "--api-key", K, "--account", "acc_1"]);
    expect(r.stderr).toMatch(/--api-key.*more than once/);
  });
});

describe("a malformed credential spelling is refused and never echoed", () => {
  it("--api-key= K: the stray value is redacted", () => {
    const r = refused(["login", "--api-key=", K]);
    expect(r.stderr).toMatch(/unexpected argument/);
  });

  it("--api-key= K before the command: the stray value is redacted", () => {
    refused(["--api-key=", K, "account", "list"]);
  });

  it("--api-key-K: the flag name is redacted", () => {
    const r = refused(["login", `--api-key-${K}`]);
    expect(r.stderr).toMatch(/unknown flag `--api-key/);
  });

  it("---api-key=K is an unknown flag, and nothing is saved", () => {
    const r = refused(["login", `---api-key=${K}`]);
    expect(r.stderr).toMatch(/unknown flag `---api-key`/);
    expect(existsSync(configFile())).toBe(false);
  });

  it("-api-key=K is an unknown flag", () => {
    refused(["login", `-api-key=${K}`]);
  });

  it("--no-api-key=K is an unknown flag (negation is for booleans)", () => {
    const r = refused(["login", `--no-api-key=${K}`]);
    expect(r.stderr).toMatch(/unknown flag `--no-api-key`/);
  });

  it("--no-json still negates a boolean", () => {
    const r = runBin(["login", "--api-key", K, "--no-json"], xdg);
    expect(r.status, r.stderr).toBe(0);
  });

  it("other secret flags: --secret= K and --code-K", () => {
    refused(["webhook", "verify", "--secret=", K]);
    refused(["setup", `--code-${K}`]);
  });
});

describe("config list masks a short key", () => {
  function listWith(apiKey: string) {
    mkdirSync(join(xdg, "curviate"), { recursive: true });
    writeFileSync(configFile(), JSON.stringify({ active: "default", profiles: { default: { apiKey } } }), {
      mode: 0o600,
    });
    const r = runBin(["config", "list", "--json"], xdg);
    expect(r.status, r.stderr).toBe(0);
    return (JSON.parse(r.stdout) as { profiles: { default: { apiKey: string } } }).profiles.default.apiKey;
  }

  it("a 13-character key shows none of its characters", () => {
    const shown = listWith("cvt_live_abcd");
    expect(shown).not.toMatch(/[a-z0-9_]/i);
  });

  it("a long key shows its last 4 only", () => {
    const shown = listWith("rdc_live_ABCDEFGHIJ1234");
    expect(shown).toMatch(/1234$/);
    expect(shown.replace(/[^\x21-\x7e]/g, "")).toBe("1234");
  });
});

describe("--timeout must be a positive whole number of milliseconds", () => {
  for (const bad of ["abc", "10abc", "0", "-5", "1.5"]) {
    it(`--timeout ${bad} exits 2 naming --timeout`, () => {
      const r = refused(["profile", "me", "--api-key", K, "--account", "acc_1", `--timeout=${bad}`]);
      expect(r.stderr).toMatch(/timeout/i);
    });
  }

  it("--timeout 50 is accepted (positive control: fails later, on the network, not as usage)", () => {
    const r = runBin(
      ["profile", "me", "--api-key", K, "--account", "acc_1", "--timeout", "50", "--base-url", "http://127.0.0.1:9"],
      xdg,
    );
    expect(r.status).not.toBe(2);
    expect(r.status).not.toBe(0);
  });
});
