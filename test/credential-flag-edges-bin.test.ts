/**
 * Credential-flag edge cases through the built bin: a repeated secret flag,
 * malformed secret-flag spellings, a stray value after `--api-key=`, short-key
 * masking in `config list`, and a non-numeric `--timeout`.
 *
 * Every refusal is checked for the sentinel on BOTH streams: a usage error
 * that exits 2 but prints the key is the defect, not the fix.
 */

import { SECRET_FLAGS } from "../src/dispatch.js";
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

  it("--api-key-K: a flag name running on past a secret flag is named by position", () => {
    const r = refused(["login", `--api-key-${K}`]);
    expect(r.stderr).toMatch(/unknown flag at argument 1/);
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
  for (const bad of ["abc", "10abc", "0", "-5", "1.5", "0x10", "1e3", " 5", "2147483648", "05"]) {
    it(`--timeout ${bad} exits 2 naming --timeout`, () => {
      const r = refused(["profile", "me", "--api-key", K, "--account", "acc_1", `--timeout=${bad}`]);
      expect(r.stderr).toMatch(/timeout/i);
    });
  }

  it("--timeout 2147483647 is accepted (upper bound)", () => {
    const r = runBin(
      ["profile", "me", "--api-key", K, "--account", "acc_1", "--timeout", "2147483647", "--base-url", "http://127.0.0.1:9"],
      xdg,
    );
    expect(r.status).not.toBe(2);
  });

  it("--timeout 50 is accepted (positive control: fails later, on the network, not as usage)", () => {
    const r = runBin(
      ["profile", "me", "--api-key", K, "--account", "acc_1", "--timeout", "50", "--base-url", "http://127.0.0.1:9"],
      xdg,
    );
    expect(r.status).not.toBe(2);
    expect(r.status).not.toBe(0);
  });
});

describe("usage errors never echo a user-supplied token", () => {
  for (const flag of SECRET_FLAGS) {
    it(`--${flag}= --json SECRET: the stray value is named by position`, () => {
      const r = refused(["login", `--${flag}=`, "--json", K]);
      expect(r.stderr).not.toMatch(/<redacted>/);
    });

    it(`-- --${flag}=SECRET: the token after -- is named by position`, () => {
      const r = refused(["login", "--", `--${flag}=${K}`]);
      expect(r.stderr).toMatch(/unexpected argument 2 after `curviate login`/);
    });

    it(`---${flag}=SECRET: the unknown flag is named exactly, without its value`, () => {
      const r = refused(["login", `---${flag}=${K}`]);
      expect(r.stderr).toContain(`unknown flag \`---${flag}\``);
    });
  }

  it("an unknown command is named by position, not echoed", () => {
    const r = refused(["--api-key=", K, "--json", "account", "list"]);
    expect(r.stderr).toMatch(/argument 2/);
  });
});

describe("a negated or --beta repeat is a repeat", () => {
  const cases: string[][] = [
    ["config", "list", "--json", "--no-json"],
    ["config", "list", "--no-json", "--no-json"],
    ["profile", "me", "--account", "acc_1", "--verbose", "--no-verbose"],
    ["account", "list", "--all", "--no-all"],
    ["webhook", "create", "--enabled", "--no-enabled"],
    ["--beta", "--beta", "config", "list"],
    ["config", "list", "--beta", "--no-beta"],
  ];
  for (const args of cases) {
    it(args.join(" "), () => {
      // local commands refuse --api-key/--base-url as unknown flags
      const local = args.includes("config");
      const r = refused(local ? args : [...args, "--api-key", "x", "--base-url", "http://127.0.0.1:9"]);
      expect(r.stderr).toMatch(/was given more than once/);
    });
  }
});

describe("login --base-url is validated before anything is saved", () => {
  it("login --api-key K --base-url 'not a url' exits 2 and writes nothing", () => {
    const r = refused(["login", "--api-key", K, "--base-url", "not a url"]);
    expect(r.stderr).toMatch(/base URL/i);
    expect(existsSync(configFile())).toBe(false);
  });
});
