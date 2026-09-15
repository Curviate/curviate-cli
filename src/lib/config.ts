/**
 * Config file management for the CLI.
 *
 * Config lives at `${XDG_CONFIG_HOME:-$HOME/.config}/curviate/config.json`.
 * Writes are atomic (write-temp -> chmod -> rename) so a crash mid-write cannot
 * corrupt the file. File mode is 0600 (owner-only); dir mode is 0700.
 *
 * API key values stored here are the raw key strings. The caller is responsible
 * for redacting them before any display (see commands/config.ts).
 */

import {
  readFile,
  writeFile,
  mkdir,
  rename,
  chmod,
  unlink,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { CurviateError } from "@curviate/sdk";
import { assertNoStdinPlaceholder } from "./stdin.js";

/** A single named profile's fields. */
export interface ProfileEntry {
  apiKey?: string;
  account?: string;
  baseUrl?: string;
  timeout?: number;
  /**
   * Display name of the workspace this key authenticates as, recorded by
   * `curviate setup` from the exchange response. Not a credential and not
   * used for auth: it exists so `doctor` can answer "whose key is this?"
   * without a round trip. Absent on a profile written by `login`, which
   * never learns it.
   */
  tenant?: string;
}

/** The on-disk config shape. */
export interface CliConfig {
  /** The currently-active profile name. */
  active: string;
  profiles: Record<string, ProfileEntry | undefined>;
}

/**
 * Every function below reads `cfg.profiles[profileName]` (or `[oldName]`
 * / `[newName]`) against a profile name the user typed on the command line
 * (`--profile <name>`). On a plain object -- what `JSON.parse` and `{}`
 * both produce -- `profiles["constructor"]` returns a live Function
 * inherited from Object.prototype. `??`/truthiness checks don't catch it,
 * so e.g. `setActiveProfile("constructor")` on a config that never had a
 * "constructor" profile incorrectly found one and did not throw.
 *
 * Rebuild `profiles` with no prototype at the two places a CliConfig is
 * created (parsed from disk, or the fresh-file default below) so every
 * read against it in this file -- however it's written -- is safe by
 * construction.
 */
function nullProtoProfiles(
  profiles: Record<string, ProfileEntry | undefined>,
): Record<string, ProfileEntry | undefined> {
  return Object.assign(Object.create(null) as Record<string, ProfileEntry | undefined>, profiles);
}

/** The JSON type of every field a profile may carry. */
export const PROFILE_FIELD_TYPES = {
  apiKey: "string",
  account: "string",
  baseUrl: "string",
  tenant: "string",
  timeout: "number",
} as const;

export type ProfileField = keyof typeof PROFILE_FIELD_TYPES;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A malformed config file is a usage error (exit 2), never a crash or a value
 * sent onto the wire. The file is hand-editable, so any part of it can hold any
 * JSON type. Messages name the file, profile and field, never the value:
 * `apiKey` is a secret whatever its shape.
 */
function malformed(message: string): CurviateError {
  return new CurviateError({ code: "INVALID_REQUEST", message, userFixable: true, retryLikelyToSucceed: false });
}

function fileProblem(what: string): CurviateError {
  return malformed(`${getConfigPath()} is invalid: ${what}. Edit the file, or run \`curviate config reset\` to start over.`);
}

/**
 * The shape every reader and writer relies on: an object top level, an object
 * (or absent) `profiles`, and, when the command takes it, a string (or absent)
 * `active`. Refuses with exit 2 otherwise.
 */
function assertStructure(root: unknown, takesActive: boolean): asserts root is Record<string, unknown> {
  if (!isPlainObject(root)) throw fileProblem("the top level must be an object");
  if (takesActive && root["active"] != null && typeof root["active"] !== "string") throw fileProblem("\"active\" must be a string");
  if (root["profiles"] != null && !isPlainObject(root["profiles"])) throw fileProblem("\"profiles\" must be an object");
}

function profileRepair(name: string): string {
  return `Run \`curviate config reset --profile ${name}\`, or edit the file.`;
}

/** The parsed file, unvalidated. Null when there is no file; throws on read/parse errors. */
export async function readConfigFile(): Promise<{ root: unknown } | null> {
  let raw: string;
  try {
    raw = await readFile(getConfigPath(), "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return { root: JSON.parse(raw) as unknown };
}

/**
 * One value the command takes from the profile, type-checked. Called only once
 * a value has fallen through every higher precedence tier, so a flag or env var
 * bypasses a broken field. `null` means unset. `selected` is `--profile`; without
 * it `active` is taken too.
 */
export function profileValue(file: { root: unknown } | null, selected: string | undefined, field: ProfileField): string | number | undefined {
  if (file === null) return undefined;
  const { root } = file;
  assertStructure(root, selected === undefined);
  const name = selected ?? (root["active"] as string | null | undefined) ?? "default";
  const profiles = root["profiles"] as Record<string, unknown> | null | undefined;
  if (profiles == null) return undefined;
  const profile = Object.prototype.hasOwnProperty.call(profiles, name) ? profiles[name] : undefined;
  if (profile == null) return undefined;
  const where = `Profile ${JSON.stringify(name)} in ${getConfigPath()}`;
  if (!isPlainObject(profile)) throw malformed(`${where} is not an object. ${profileRepair(name)}`);
  const value = profile[field];
  if (value == null) return undefined;
  const want = PROFILE_FIELD_TYPES[field];
  if (typeof value !== want) throw malformed(`${where} is invalid: ${field} must be a ${want}. ${profileRepair(name)}`);
  return value as string | number;
}

/** Return the absolute path to the config file (even if it does not exist). */
export function getConfigPath(): string {
  const xdg =
    process.env["XDG_CONFIG_HOME"] ??
    (process.env["APPDATA"] ?? join(homedir(), ".config"));
  return join(xdg, "curviate", "config.json");
}

/**
 * Read the config file for a command that rewrites it. Returns null if the
 * file does not exist. A malformed top level, `active` or `profiles` refuses
 * with exit 2 (the repair is editing the file or `config reset`); throws on
 * read/parse errors.
 */
export async function readConfig(): Promise<CliConfig | null> {
  const file = await readConfigFile();
  if (file === null) return null;
  const { root } = file;
  assertStructure(root, true);
  const profiles = root["profiles"] ?? {};
  return { ...(root as unknown as CliConfig), profiles: nullProtoProfiles(profiles as Record<string, ProfileEntry | undefined>) };
}

/**
 * Atomically write the config to disk.
 * Creates the directory (mode 0700) if it does not exist.
 * Writes to a temp file, chmods it to 0600, then renames into place.
 */
async function writeConfig(cfg: CliConfig): Promise<void> {
  const cfgPath = getConfigPath();
  const cfgDir = dirname(cfgPath);

  // Ensure directory exists with mode 0700.
  await mkdir(cfgDir, { recursive: true, mode: 0o700 });
  // Re-assert dir mode (mkdir may not set it if it already exists).
  try {
    await chmod(cfgDir, 0o700);
  } catch {
    // On platforms without chmod support, ignore silently.
  }

  const content = JSON.stringify(cfg, null, 2) + "\n";
  // The persistence half of the stdin-placeholder backstop. A config file is
  // the worst place for the placeholder to land: it survives the process, and
  // every later command then fails blaming the credential it was stored as.
  assertNoStdinPlaceholder("the configuration about to be written", [content]);
  const tmpPath = join(
    tmpdir(),
    `curviate-cfg-${randomBytes(6).toString("hex")}.tmp`,
  );

  try {
    await writeFile(tmpPath, content, { encoding: "utf8", mode: 0o600 });
    // Re-assert mode in case writeFile's mode was ignored by the OS.
    try {
      await chmod(tmpPath, 0o600);
    } catch {
      // Ignore on non-POSIX.
    }
    await rename(tmpPath, cfgPath);
    // Re-assert mode on the renamed file (rename preserves the source inode mode,
    // but on some platforms it may not, assert here for safety).
    try {
      await chmod(cfgPath, 0o600);
    } catch {
      // Ignore on non-POSIX.
    }
  } catch (err) {
    // Clean up the temp file if rename failed.
    try {
      await unlink(tmpPath);
    } catch {
      // Best-effort cleanup.
    }
    throw err;
  }
}

/**
 * Write (create or update) a named profile entry in the config.
 * The first profile written becomes the active profile (if no active set).
 */
export async function writeProfile(
  profileName: string,
  entry: ProfileEntry,
): Promise<void> {
  const existing = (await readConfig()) ?? {
    active: profileName,
    profiles: nullProtoProfiles({}),
  };

  // Merge entry into existing profile (don't overwrite unrelated fields).
  const stored = existing.profiles[profileName];
  const current = isPlainObject(stored) ? stored : {};
  existing.profiles[profileName] = { ...current, ...entry };

  // If no active is set yet, default to this profile.
  if (!existing.active) {
    existing.active = profileName;
  }

  await writeConfig(existing);
}

/**
 * Set the active profile. Throws if the named profile does not exist.
 */
export async function setActiveProfile(profileName: string): Promise<void> {
  const cfg = await readConfig();
  if (!cfg || !cfg.profiles[profileName]) {
    throw new Error(`Profile "${profileName}" not found.`);
  }
  cfg.active = profileName;
  await writeConfig(cfg);
}

/**
 * Rename a profile. Updates the active pointer if it pointed at the old name.
 * Throws if old name does not exist or new name already exists.
 */
export async function renameProfile(
  oldName: string,
  newName: string,
): Promise<void> {
  const cfg = await readConfig();
  if (!cfg || !cfg.profiles[oldName]) {
    throw new Error(`Profile "${oldName}" not found.`);
  }
  if (cfg.profiles[newName]) {
    throw new Error(
      `Profile "${newName}" already exists. Remove it first or choose another name.`,
    );
  }
  cfg.profiles[newName] = cfg.profiles[oldName];
  delete cfg.profiles[oldName];
  if (cfg.active === oldName) {
    cfg.active = newName;
  }
  await writeConfig(cfg);
}

/**
 * Remove a profile. If it was active, repoints active to "default".
 */
export async function removeProfile(profileName: string): Promise<void> {
  const cfg = await readConfig();
  if (!cfg) return;
  delete cfg.profiles[profileName];
  if (cfg.active === profileName) {
    cfg.active = "default";
  }
  await writeConfig(cfg);
}

/**
 * Update a single field on a named profile.
 */
export async function updateProfileField(
  profileName: string,
  field: keyof ProfileEntry,
  value: string | number | undefined,
): Promise<void> {
  const cfg = await readConfig();
  if (!cfg || !cfg.profiles[profileName]) {
    throw new Error(`Profile "${profileName}" not found.`);
  }
  const profile = cfg.profiles[profileName];
  if (profile) {
    if (field === "timeout") {
      profile.timeout =
        typeof value === "number" ? value : value !== undefined
          ? Number(value)
          : undefined;
    } else if (field === "apiKey") {
      profile.apiKey = value !== undefined ? String(value) : undefined;
    } else if (field === "account") {
      profile.account = value !== undefined ? String(value) : undefined;
    } else if (field === "baseUrl") {
      profile.baseUrl = value !== undefined ? String(value) : undefined;
    } else if (field === "tenant") {
      profile.tenant = value !== undefined ? String(value) : undefined;
    }
  }
  await writeConfig(cfg);
}
