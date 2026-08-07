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

import { readConfig } from "./config.js";

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
}

const DEFAULT_BASE_URL = "https://api.curviate.com";
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Resolve the effective config by merging flags -> env -> profile -> SDK defaults.
 */
export async function resolveEffectiveConfig(
  flags: FlagInputs,
): Promise<EffectiveConfig> {
  // Load config file once.
  const cfg = await readConfig();

  // Determine which profile to use.
  const profileName = flags.profile ?? (cfg?.active ?? "default");
  const profile = cfg?.profiles[profileName];

  // API key: flag > env > profile
  const apiKey =
    flags.apiKey ??
    process.env["CURVIATE_API_KEY"] ??
    profile?.apiKey ??
    undefined;

  // Base URL: flag > env > profile > SDK default
  const baseUrl =
    flags.baseUrl ??
    process.env["CURVIATE_BASE_URL"] ??
    profile?.baseUrl ??
    DEFAULT_BASE_URL;

  // Timeout: flag (as number) > profile > SDK default
  const timeoutFlag =
    flags.timeout !== undefined ? parseInt(flags.timeout, 10) : undefined;
  const timeout = timeoutFlag ?? profile?.timeout ?? DEFAULT_TIMEOUT_MS;

  // Account: flag > env > profile
  const account =
    flags.account ??
    process.env["CURVIATE_ACCOUNT"] ??
    profile?.account ??
    undefined;

  return { apiKey, baseUrl, timeout, account };
}
