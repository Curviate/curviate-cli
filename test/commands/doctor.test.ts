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
import { CurviateError } from "@curviate/sdk";
import { runDoctor, resolveDoctorIO, type DoctorIO } from "../../src/commands/doctor.js";

/**
 * What the SDK's transport ACTUALLY throws when the request never reached the
 * API: `INTERNAL`, no `httpStatus`, retryable. Not a bare `TypeError` — the
 * transport wraps every fetch rejection before it leaves the SDK, so a fake
 * throwing a raw error is testing a path production cannot produce, and it
 * cannot fail when reachability is decided from the error CODE.
 */
function transportFailure(message = "Network error."): CurviateError {
  return new CurviateError({
    code: "INTERNAL",
    message,
    userFixable: false,
    retryLikelyToSucceed: true,
  });
}

/**
 * What the SDK throws when the CLIENT refuses to build the request — an empty
 * `--api-key`, a malformed base URL. Raised before anything leaves this
 * process, so it carries no `httpStatus` (like a transport failure) but is
 * NOT retryable (unlike one). That pair is the only thing separating them.
 */
function preRequestRefusal(message: string): CurviateError {
  return new CurviateError({
    code: "INVALID_REQUEST",
    message,
    userFixable: true,
    retryLikelyToSucceed: false,
  });
}

/** What the SDK throws for a refusal the API itself sent back. */
function apiRefusal(code: string, httpStatus: number, message: string): CurviateError {
  return new CurviateError({
    code: code as never,
    message,
    httpStatus,
    userFixable: true,
    retryLikelyToSucceed: false,
  });
}

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
          throw apiRefusal("UNAUTHORIZED", 401, "Invalid or revoked API key.");
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
  beforeEach(() => {
    writeConfigFile({
      active: "default",
      profiles: { default: { apiKey: "rdc_live_X", baseUrl: "https://example.test" } },
    });
  });

  it("fails the reachability check and exits 7", async () => {
    const report = await runDoctor(
      {},
      io({ listAccounts: async () => Promise.reject(transportFailure()) }),
    );

    expect(report.api_reachable).toBe(false);
    expect(report.exit).toBe(7);
    expect(report.checks.find((c) => c.name === "api reachable")?.ok).toBe(false);
  });

  it("does not report the credential as rejected when nothing asked it", async () => {
    // The regression this guards: reachability was decided from the error
    // CODE, and the SDK collapses a transport failure to `INTERNAL` — never
    // `undefined`. So an unreachable API reported `api reachable: PASS` and
    // blamed the credential, sending the caller to re-run `setup` over a
    // network fault.
    const report = await runDoctor(
      {},
      io({ listAccounts: async () => Promise.reject(transportFailure()) }),
    );

    expect(report.checks.map((c) => [c.name, c.ok])).toEqual([
      ["credential", true],
      ["api reachable", false],
      ["credential valid", false],
    ]);
    const credential = report.checks.find((c) => c.name === "credential valid");
    expect(credential?.detail).not.toContain("rejected");
    expect(credential?.detail).toContain("could not be reached");
  });

  it("still exits 7 when the request timed out", async () => {
    const report = await runDoctor(
      {},
      io({ listAccounts: async () => Promise.reject(transportFailure("Request timed out.")) }),
    );

    expect(report.api_reachable).toBe(false);
    expect(report.exit).toBe(7);
  });
});

describe("a request the client refuses to send", () => {
  beforeEach(() => {
    writeConfigFile({
      active: "default",
      profiles: { default: { apiKey: "rdc_live_X", baseUrl: "https://example.test" } },
    });
  });

  it("does not blame the network for a usage error", async () => {
    // The third category. It has no `httpStatus`, exactly like a transport
    // failure, so deciding reachability on that alone reports "could not
    // reach" and exit 7 for something that never touched the network — and
    // exit 7 invites a retry that cannot possibly help.
    const report = await runDoctor(
      {},
      io({
        listAccounts: async () =>
          Promise.reject(preRequestRefusal("An apiKey is required to construct a Curviate client.")),
      }),
    );

    expect(report.api_reachable).toBe(false);
    expect(report.exit).toBe(2);
    const reach = report.checks.find((c) => c.name === "api reachable");
    expect(reach?.detail).not.toContain("could not reach");
    expect(reach?.detail).toContain("refused before it was sent");
  });
});

describe("an API that answers with a platform fault", () => {
  it("reports it as reached, because it answered", async () => {
    writeConfigFile({
      active: "default",
      profiles: { default: { apiKey: "rdc_live_X", baseUrl: "https://example.test" } },
    });
    const report = await runDoctor(
      {},
      io({
        listAccounts: async () =>
          Promise.reject(apiRefusal("PLATFORM_ERROR", 503, "Upstream unavailable.")),
      }),
    );

    // The inverse of the case above, and the reason code-based detection was
    // wrong in BOTH directions: a 503 came back over a working connection.
    expect(report.api_reachable).toBe(true);
    expect(report.checks.find((c) => c.name === "api reachable")?.ok).toBe(true);
    expect(report.exit).toBe(7);
  });

  it("passes a named refusal through to its own exit code", async () => {
    writeConfigFile({
      active: "default",
      profiles: { default: { apiKey: "rdc_live_X", baseUrl: "https://example.test" } },
    });
    const report = await runDoctor(
      {},
      io({
        listAccounts: async () =>
          Promise.reject(apiRefusal("NO_ACTIVE_SEAT", 402, "No active seat.")),
      }),
    );

    expect(report.api_reachable).toBe(true);
    expect(report.exit).toBe(5);
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
