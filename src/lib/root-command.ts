/**
 * What a root-scoped product command (`motion`, `enrollment`) needs around its
 * SDK call: a client from the effective config, the output options, the error
 * exit, and the repeatable comma-list flag. The acting `--account` is never
 * read here: these resources belong to the Team, and a configured default
 * Account must not narrow or redirect them.
 */
import type { Curviate } from "@curviate/sdk";
import { resolveEffectiveConfig } from "./resolve.js";
import { createClient } from "./client.js";
import { renderError, renderUnexpectedError, type OutputOptions } from "./output.js";

export type RootFlags = {
  "api-key"?: string;
  "base-url"?: string;
  timeout?: string;
  profile?: string;
  json?: boolean;
  fields?: string;
  verbose?: boolean;
  preview?: boolean;
};

export const outputOpts = (f: RootFlags): OutputOptions => ({
  json: (f.json ?? false) || !process.stdout.isTTY,
  isTTY: process.stdout.isTTY ?? false,
  fields: f.fields,
  verbose: f.verbose,
});

export function usage(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(2);
}

/** A client for the caller's key, or exit 3 when there is none. */
export async function rootClient(f: RootFlags): Promise<Curviate> {
  const cfg = await resolveEffectiveConfig({ apiKey: f["api-key"], baseUrl: f["base-url"], timeout: f.timeout, profile: f.profile });
  if (!cfg.apiKey) {
    process.stderr.write("error: no API key, run `curviate login` or pass --api-key.\n");
    process.exit(3);
  }
  try {
    return createClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, timeout: cfg.timeout });
  } catch (err) {
    return fail(err, f);
  }
}

/** Render an API error with its exit code, anything else as an internal fault (exit 1). */
export async function fail(err: unknown, f: RootFlags): Promise<never> {
  const { CurviateError } = await import("@curviate/sdk");
  if (err instanceof CurviateError) {
    const { getExitCode } = await import("./exit-codes.js");
    renderError(err, outputOpts(f), process);
    process.exit(getExitCode(err));
  }
  renderUnexpectedError(err, process);
  process.exit(1);
}

/** A repeatable flag that also takes a comma list: every id, in the order given. An empty segment is refused, never dropped. */
export function listFlag(flag: string, raw: string | string[] | undefined): string[] {
  if (raw === undefined) return [];
  const ids = ([] as string[]).concat(raw).flatMap((v) => v.split(",")).map((s) => s.trim());
  if (ids.length === 0 || ids.some((s) => s === "")) usage(`--${flag} was given an empty value. Pass one or more ids, comma-separated or with --${flag} repeated.`);
  return ids;
}
