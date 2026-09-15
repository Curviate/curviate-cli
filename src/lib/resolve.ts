/**
 * Effective-config resolution.
 *
 * Computes the authoritative values for a command invocation by merging,
 * in priority order (highest first):
 *   1. CLI flags (`--api-key`, `--base-url`, `--timeout`, `--account`)
 *   2. Environment variables (`CURVIATE_API_KEY`, `CURVIATE_BASE_URL`, `CURVIATE_ACCOUNT`)
 *   3. Active (or `--profile`-selected) config-file profile
 *   4. SDK defaults (`https://api.curviate.com`, `30000 ms`)
 *
 * The API key is passed through verbatim, no prefix validation.
 */

import { profileValue, readConfigFile, type ProfileField } from "./config.js";

export interface FlagInputs {
  /** `--api-key` flag value (citty parses `--api-key` to camelCase `apiKey`). */
  apiKey?: string;
  /** `--base-url` flag value (citty parses `--base-url` to camelCase `baseUrl`). */
  baseUrl?: string;
  timeout?: string;
  account?: string;
  profile?: string;
}

export interface EffectiveConfig {
  /** Resolved API key. `undefined` when no key is found anywhere. */
  apiKey: string | undefined;
  /** Resolved base URL. Always present (falls back to SDK default). */
  baseUrl: string;
  /** Resolved timeout in ms. Always present (falls back to SDK default). */
  timeout: number;
  /** Resolved account id. `undefined` when not set. */
  account: string | undefined;
  /**
   * Which precedence tier the API key came from. `"none"` when no key was
   * found anywhere. Reported by `doctor` so an operator can see WHICH source
   * is in play without the value itself ever being displayed.
   */
  apiKeySource: CredentialSource;
  /** Workspace name `setup` recorded, when the key came from the profile. */
  tenant: string | undefined;
}

/** The precedence tier a credential resolved from. */
export type CredentialSource = "flag" | "env" | "profile" | "none";

const DEFAULT_BASE_URL = "https://api.curviate.com";
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Resolve the effective config by merging flags -> env -> profile -> SDK defaults.
 */
export async function resolveEffectiveConfig(
  flags: FlagInputs,
): Promise<EffectiveConfig> {
  // Load config file once. A value is taken from the profile, and type-checked,
  // only after every higher tier came up empty, so a flag or env var bypasses a
  // broken field.
  const file = await readConfigFile();
  const fromProfile = <T extends string | number>(field: ProfileField): T | undefined =>
    profileValue(file, flags.profile, field) as T | undefined;

  // API key: flag > env > profile
  const profileKey =
    flags.apiKey === undefined && process.env["CURVIATE_API_KEY"] === undefined
      ? fromProfile<string>("apiKey")
      : undefined;
  const apiKey = flags.apiKey ?? process.env["CURVIATE_API_KEY"] ?? profileKey;

  // Derived from the same expression above, in the same order, so the two can
  // never disagree about which tier won.
  const apiKeySource: CredentialSource =
    flags.apiKey !== undefined
      ? "flag"
      : process.env["CURVIATE_API_KEY"] !== undefined
        ? "env"
        : profileKey !== undefined
          ? "profile"
          : "none";

  // Base URL: flag > env > profile > SDK default
  const baseUrl =
    flags.baseUrl ??
    process.env["CURVIATE_BASE_URL"] ??
    fromProfile<string>("baseUrl") ??
    DEFAULT_BASE_URL;

  // Timeout: flag (as number) > profile > SDK default
  const timeoutFlag =
    flags.timeout === undefined ? undefined : /^[1-9]\d*$/.test(flags.timeout) ? Number(flags.timeout) : NaN;
  // `timeout` has a default, so when the key and base URL both came from
  // flags or env, an unreadable profile never blocks the command (env-only CI):
  // its timeout is taken if it can be read, and the default otherwise.
  const keyAndUrlBypassProfile =
    apiKeySource !== "profile" &&
    apiKeySource !== "none" &&
    (flags.baseUrl ?? process.env["CURVIATE_BASE_URL"]) !== undefined;
  const profileTimeout = (): number | undefined => {
    try {
      return fromProfile<number>("timeout");
    } catch (err) {
      if (keyAndUrlBypassProfile) return undefined;
      throw err;
    }
  };
  const timeout = timeoutFlag ?? profileTimeout() ?? DEFAULT_TIMEOUT_MS;

  return {
    apiKey,
    baseUrl,
    timeout,
    apiKeySource,
    // Account: flag > env > profile. Read on access: a root-scoped command never
    // takes it, so a broken profile account must not refuse that command.
    get account() {
      return flags.account ?? process.env["CURVIATE_ACCOUNT"] ?? fromProfile<string>("account");
    },
    // Tenant: only meaningful when the key itself came from the profile.
    get tenant() {
      return apiKeySource === "profile" ? fromProfile<string>("tenant") : undefined;
    },
  };
}
