/**
 * `curviate doctor` - the one command that answers "can I run?".
 *
 * The API call is the only injected seam; config resolution, precedence and
 * the exit-code decision are the production ones, because those are what the
 * command exists to report on.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor, resolveDoctorIO, type DoctorIO } from "../../src/commands/doctor.js";

const ACCOUNTS = {
  items: [
    { id: "acc_one", status: "OK" },
    { id: "acc_two", status: "CREDENTIALS" },
  ],
  cursor: null,
};

let xdg: string;

function writeConfigFile(config: unknown): void {
  mkdirSync(join(xdg, "curviate"), { recursive: true });
  writeFileSync(join(xdg, "curviate", "config.json"), JSON.stringify(config), { mode: 0o600 });
}

function io(overrides: Partial<DoctorIO> = {}): DoctorIO {
  return resolveDoctorIO({
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    isOutputTTY: false,
    version: () => "9.9.9",
    listAccounts: async () => ACCOUNTS,
    ...overrides,
  });
}

beforeEach(() => {
  xdg = mkdtempSync(join(tmpdir(), "curviate-doctor-"));
  process.env["XDG_CONFIG_HOME"] = xdg;
  delete process.env["CURVIATE_API_KEY"];
  delete process.env["CURVIATE_BASE_URL"];
  delete process.env["CURVIATE_ACCOUNT"];
});

afterEach(() => {
  delete process.env["XDG_CONFIG_HOME"];
  delete process.env["CURVIATE_API_KEY"];
  rmSync(xdg, { recursive: true, force: true });
});

describe("everything green", () => {
  beforeEach(() => {
    writeConfigFile({
      active: "default",
      profiles: {
        default: {
          apiKey: "rdc_live_DOCTORFIXTURE",
          baseUrl: "https://example.test",
          tenant: "Doctor Workspace",
        },
      },
    });
  });

  it("reports every field the command promises, and exits 0", async () => {
    const report = await runDoctor({}, io());

    expect(report.exit).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.version).toBe("9.9.9");
    expect(report.config_path).toBe(join(xdg, "curviate", "config.json"));
    expect(report.profile).toBe("default");
    expect(report.base_url).toBe("https://example.test");
    expect(report.credential_resolved).toBe(true);
    expect(report.credential_source).toBe("profile");
    expect(report.tenant).toBe("Doctor Workspace");
    expect(report.api_reachable).toBe(true);
    expect(report.credential_valid).toBe(true);
    expect(report.accounts).toEqual([
      { account_id: "acc_one", status: "OK" },
      { account_id: "acc_two", status: "CREDENTIALS" },
    ]);
  });

  it("never carries the credential VALUE, only which tier it came from", () => {
    return runDoctor({}, io()).then((report) => {
      expect(JSON.stringify(report)).not.toContain("rdc_live_DOCTORFIXTURE");
      expect(report.credential_source).toBe("profile");
    });
  });

  it("names the precedence tier that actually won", async () => {
    process.env["CURVIATE_API_KEY"] = "rdc_live_FROM_ENV";
    expect((await runDoctor({}, io())).credential_source).toBe("env");

    // A flag outranks the environment, and the report must say so.
    const flagged = await runDoctor({ "api-key": "rdc_live_FROM_FLAG" }, io());
    expect(flagged.credential_source).toBe("flag");
    expect(JSON.stringify(flagged)).not.toContain("rdc_live_FROM_FLAG");
  });

  it("reads the profile named by --profile, not the active one", async () => {
    writeConfigFile({
      active: "default",
      profiles: {
        default: { apiKey: "rdc_live_A", tenant: "Default Workspace" },
        work: { apiKey: "rdc_live_B", tenant: "Work Workspace" },
      },
    });
    const report = await runDoctor({ profile: "work" }, io());
    expect(report.profile).toBe("work");
    expect(report.tenant).toBe("Work Workspace");
  });
});

describe("a credential that the API rejects", () => {
  beforeEach(() => {
    writeConfigFile({
      active: "default",
      profiles: { default: { apiKey: "rdc_live_REVOKED", baseUrl: "https://example.test" } },
    });
  });

  it("fails the auth check by name and exits 3", async () => {
    const report = await runDoctor(
      {},
      io({
        listAccounts: async () => {
          throw Object.assign(new Error("Invalid or revoked API key."), {
            code: "UNAUTHORIZED",
          });
        },
      }),
    );

    expect(report.exit).toBe(3);
    expect(report.ok).toBe(false);
    expect(report.credential_valid).toBe(false);
    // The API answered, so reachability is NOT what failed. Reporting both as
    // broken would send someone to debug their network.
    expect(report.api_reachable).toBe(true);
    const failing = report.checks.filter((c) => !c.ok).map((c) => c.name);
    expect(failing).toEqual(["credential valid"]);
    expect(report.checks.find((c) => c.name === "credential valid")?.detail).toContain(
      "UNAUTHORIZED",
    );
  });
});

describe("an API that cannot be reached", () => {
  it("fails the reachability check and exits 7", async () => {
    writeConfigFile({
      active: "default",
      profiles: { default: { apiKey: "rdc_live_X", baseUrl: "https://example.test" } },
    });
    const report = await runDoctor(
      {},
      io({
        listAccounts: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    );

    expect(report.api_reachable).toBe(false);
    expect(report.exit).toBe(7);
    expect(report.checks.find((c) => c.name === "api reachable")?.ok).toBe(false);
  });
});

describe("no credential anywhere", () => {
  it("says so, names the way out, and exits 3 without calling the API", async () => {
    let called = 0;
    const report = await runDoctor(
      {},
      io({
        listAccounts: async () => {
          called++;
          return ACCOUNTS;
        },
      }),
    );

    expect(report.credential_resolved).toBe(false);
    expect(report.credential_source).toBe("none");
    expect(report.exit).toBe(3);
    expect(called).toBe(0);
    expect(report.checks[0]?.detail).toContain("curviate setup");
  });

  it("still reports the config path, profile and base url", async () => {
    const report = await runDoctor({}, io());
    expect(report.config_path).toBe(join(xdg, "curviate", "config.json"));
    expect(report.profile).toBe("default");
    expect(report.base_url).toBe("https://api.curviate.com");
  });
});

describe("a workspace nobody recorded", () => {
  it("reports null rather than guessing, and does not fail the run", async () => {
    writeConfigFile({
      active: "default",
      profiles: { default: { apiKey: "rdc_live_LOGIN_ONLY" } },
    });
    const report = await runDoctor({}, io());
    expect(report.tenant).toBeNull();
    expect(report.exit).toBe(0);
  });
});
