/**
 * `curviate doctor`, one command answering "can I run?".
 *
 * Reports, in order: the CLI version; the resolved config path, active
 * profile and base URL; whether a credential resolved and from WHICH
 * precedence tier (flag, environment, or profile), never the value; which
 * workspace it belongs to; whether the API is reachable and the credential
 * valid; and the connected accounts with their id and status.
 *
 * Exit `0` when every check passes, otherwise the first failing check's code.
 *
 * Precedence is not re-derived here. `lib/resolve.ts` owns it and now reports
 * which tier won, so `doctor` and every other command can never disagree
 * about where a credential came from.
 */

import { defineCommand } from "citty";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfigPath, readConfig } from "../lib/config.js";
import { createClient } from "../lib/client.js";
import { getExitCode } from "../lib/exit-codes.js";
import { GLOBAL_FLAGS } from "../lib/global-flags.js";
import { resolveEffectiveConfig, type CredentialSource } from "../lib/resolve.js";
import type { CurviateError } from "@curviate/sdk";

/** One connected account, as `doctor` reports it. */
interface AccountLine {
  account_id: string;
  status: string;
}

/** A single check's verdict. `exit` is consulted only when `ok` is false. */
interface Check {
  name: string;
  ok: boolean;
  detail: string;
  exit: number;
}

export interface DoctorReport {
  version: string;
  config_path: string;
  profile: string;
  base_url: string;
  credential_source: CredentialSource;
  credential_resolved: boolean;
  tenant: string | null;
  api_reachable: boolean;
  credential_valid: boolean;
  accounts: AccountLine[];
  checks: Array<Omit<Check, "exit">>;
  ok: boolean;
  exit: number;
}

export interface DoctorIO {
  stdout: { write: (s: string) => void };
  stderr: { write: (s: string) => void };
  isOutputTTY: boolean;
  /** Lists the connected accounts with the resolved credential. */
  listAccounts: (apiKey: string, baseUrl: string, timeout: number) => Promise<unknown>;
  version: () => string;
}

/**
 * The declared version, found by walking up from this module.
 *
 * NOT a fixed relative path. This module sits at `src/commands/` in the tree
 * and at the bundle root in `dist/`, so any single `../` count is wrong in
 * one of the two layouts. It was wrong in the one that ships: the built bin
 * died with `Cannot find module` on every invocation, while the suite stayed
 * green because every case injected this function away.
 */
function defaultVersion(): string {
  const require = createRequire(import.meta.url);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) return (require(candidate) as { version: string }).version;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("could not locate the package manifest");
    dir = parent;
  }
}

async function defaultListAccounts(
  apiKey: string,
  baseUrl: string,
  timeout: number,
): Promise<unknown> {
  return createClient({ apiKey, baseUrl, timeout }).accounts.list();
}

export function resolveDoctorIO(io: Partial<DoctorIO> = {}): DoctorIO {
  return {
    stdout: io.stdout ?? { write: (s: string) => void process.stdout.write(s) },
    stderr: io.stderr ?? { write: (s: string) => void process.stderr.write(s) },
    isOutputTTY: io.isOutputTTY ?? (process.stdout.isTTY ?? false),
    listAccounts: io.listAccounts ?? defaultListAccounts,
    version: io.version ?? defaultVersion,
  };
}

/** Pull `{ account_id, status }` out of whatever list envelope arrived. */
function accountLines(payload: unknown): AccountLine[] {
  if (typeof payload !== "object" || payload === null) return [];
  const items = (payload as Record<string, unknown>)["items"];
  if (!Array.isArray(items)) return [];
  return items.map((raw) => {
    const item = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    return {
      account_id: typeof item["id"] === "string" ? item["id"] : String(item["account_id"] ?? ""),
      status: typeof item["status"] === "string" ? item["status"] : "unknown",
    };
  });
}

export interface DoctorArgs {
  profile?: string;
  "api-key"?: string;
  "base-url"?: string;
  timeout?: string;
  json?: boolean;
}

/** Build the report. Pure apart from the two injected calls. */
export async function runDoctor(args: DoctorArgs, io: DoctorIO): Promise<DoctorReport> {
  const cfg = await readConfig();
  const effective = await resolveEffectiveConfig({
    apiKey: args["api-key"],
    baseUrl: args["base-url"],
    timeout: args.timeout,
    profile: args.profile,
  });
  const profileName = args.profile ?? cfg?.active ?? "default";
  const checks: Check[] = [];

  const credentialResolved = effective.apiKey !== undefined;
  checks.push({
    name: "credential",
    ok: credentialResolved,
    detail: credentialResolved
      ? `resolved from ${effective.apiKeySource}`
      : "no credential found in a flag, the environment, or the profile. Run `curviate setup`.",
    // 3: auth. Nothing is malformed, there is simply nothing to authenticate
    // with, and the remedy is the same as for a rejected key.
    exit: 3,
  });

  let reachable = false;
  let valid = false;
  let accounts: AccountLine[] = [];

  if (credentialResolved) {
    try {
      const payload = await io.listAccounts(
        effective.apiKey as string,
        effective.baseUrl,
        effective.timeout,
      );
      reachable = true;
      valid = true;
      accounts = accountLines(payload);
      checks.push({ name: "api reachable", ok: true, detail: effective.baseUrl, exit: 7 });
      checks.push({
        name: "credential valid",
        ok: true,
        detail: `accepted by ${effective.baseUrl}`,
        exit: 3,
      });
      checks.push({
        name: "connected accounts",
        ok: true,
        detail: `${accounts.length} connected`,
        exit: 8,
      });
    } catch (err: unknown) {
      const error = err as Partial<CurviateError> & { code?: string; message?: string };
      const code = typeof error.code === "string" ? error.code : undefined;
      // Reachability is decided by whether a RESPONSE came back, which is
      // exactly what `httpStatus` records — the SDK sets it from `res.status`
      // on every error it decodes from a response, and never on one it raises
      // without a response.
      //
      // It cannot be decided from the error CODE. The previous rule here read
      // `code !== undefined && code !== "PLATFORM_ERROR"` on the premise that
      // a transport failure carries no code; the SDK collapses an undeclared
      // or absent code to `INTERNAL`, so the code is NEVER undefined by the
      // time it arrives. That made the check wrong in both directions: an
      // unreachable API reported `api reachable: PASS` and blamed the
      // credential (exit 1, sending the caller to re-run `setup` over a
      // network fault), while a reachable API answering `PLATFORM_ERROR` —
      // a 503 that by definition came back over a working connection —
      // reported it FAIL.
      const responded = typeof error.httpStatus === "number";
      // No `httpStatus` covers TWO different answers, and only one of them is
      // about the network: the transport failed to get a response, or the
      // client refused to build the request at all (an empty key, a malformed
      // base URL) so nothing ever left this process. `retryLikelyToSucceed`
      // is what separates them — the transport sets it true by construction,
      // every client-side refusal sets it false. Calling the second one
      // "could not reach" blames the network for a usage error, and exit 7
      // invites a retry that cannot help.
      const transportFault = !responded && error.retryLikelyToSucceed === true;
      const codeExit = code ? getExitCode(code as never) : 3;
      reachable = responded;
      checks.push({
        name: "api reachable",
        ok: reachable,
        detail: reachable
          ? effective.baseUrl
          : transportFault
            ? `could not reach ${effective.baseUrl}: ${error.message ?? "network error"}`
            : "not checked: the request was refused before it was sent",
        exit: transportFault ? 7 : codeExit,
      });
      checks.push({
        name: "credential valid",
        ok: false,
        // Nothing asked the credential anything unless a response came back,
        // so it was not "rejected". Saying it was is the half of this defect
        // that actually misdirects: it names the one subsystem that is fine.
        detail: responded
          ? code
            ? `rejected: ${code}`
            : (error.message ?? "the call did not succeed")
          : transportFault
            ? `not checked: ${effective.baseUrl} could not be reached`
            : (error.message ?? "the request was refused before it was sent"),
        exit: responded ? codeExit : transportFault ? 3 : codeExit,
      });
    }
  }

  // ONLY when the profile tier is the one that actually won.
  //
  // The workspace is recorded next to the key `setup` wrote. A credential
  // that came from a flag or the environment is a DIFFERENT key, quite
  // possibly a different workspace, and naming the profile's workspace beside
  // it is worse than naming none: it reads as an answer.
  const tenant =
    effective.apiKeySource === "profile" ? (cfg?.profiles[profileName]?.tenant ?? null) : null;

  const firstFailure = checks.find((c) => !c.ok);
  const report: DoctorReport = {
    version: io.version(),
    config_path: getConfigPath(),
    profile: profileName,
    base_url: effective.baseUrl,
    credential_source: effective.apiKeySource,
    credential_resolved: credentialResolved,
    tenant,
    api_reachable: reachable,
    credential_valid: valid,
    accounts,
    checks: checks.map(({ name, ok, detail }) => ({ name, ok, detail })),
    ok: firstFailure === undefined,
    exit: firstFailure?.exit ?? 0,
  };
  return report;
}

function renderHuman(report: DoctorReport, io: DoctorIO): void {
  const lines = [
    `version           ${report.version}`,
    `config            ${report.config_path}`,
    `profile           ${report.profile}`,
    `base url          ${report.base_url}`,
    `credential        ${report.credential_resolved ? `resolved from ${report.credential_source}` : "not found"}`,
    `workspace         ${report.tenant ?? "unknown (only a key `curviate setup` wrote carries it)"}`,
  ];
  for (const check of report.checks) {
    lines.push(`${check.ok ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}`);
  }
  for (const account of report.accounts) {
    lines.push(`account           ${account.account_id}  ${account.status}`);
  }
  io.stdout.write(lines.join("\n") + "\n");
}

export const doctorCommand = defineCommand({
  meta: {
    name: "doctor",
    description:
      "Check that this machine can call the API: config, credential source, workspace, reachability and connected accounts.",
  },
  args: {
    profile: GLOBAL_FLAGS.profile,
    "api-key": GLOBAL_FLAGS["api-key"],
    "base-url": GLOBAL_FLAGS["base-url"],
    timeout: GLOBAL_FLAGS.timeout,
    json: GLOBAL_FLAGS.json,
  },
  async run({ args }) {
    const io = resolveDoctorIO();
    const report = await runDoctor(
      {
        profile: args.profile as string | undefined,
        "api-key": args["api-key"] as string | undefined,
        "base-url": args["base-url"] as string | undefined,
        timeout: args.timeout as string | undefined,
        json: args.json as boolean | undefined,
      },
      io,
    );
    const json = args.json === true || !io.isOutputTTY;
    if (json) io.stdout.write(JSON.stringify(report) + "\n");
    else renderHuman(report, io);
    if (report.exit !== 0) process.exit(report.exit);
  },
});
