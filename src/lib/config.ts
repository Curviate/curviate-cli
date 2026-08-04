/**
 * Config file management for the CLI.
 *
 * Config lives at `${XDG_CONFIG_HOME:-$HOME/.config}/curviate/config.json`.
 * Writes are atomic (write-temp → chmod → rename) so a crash mid-write cannot
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
import { assertNoStdinPlaceholder } from "./stdin.js";

/** A single named profile's fields. */
export interface ProfileEntry {
  apiKey?: string;
  account?: string;
  baseUrl?: string;
  timeout?: number;
}

/** The on-disk config shape. */
export interface CliConfig {
  /** The currently-active profile name. */
  active: string;
  profiles: Record<string, ProfileEntry | undefined>;
}

/** Return the absolute path to the config file (even if it does not exist). */
export function getConfigPath(): string {
  const xdg =
    process.env["XDG_CONFIG_HOME"] ??
    (process.env["APPDATA"] ?? join(homedir(), ".config"));
  return join(xdg, "curviate", "config.json");
}

/**
 * Read the config file. Returns null if the file does not exist.
 * Throws on parse/read errors.
 */
export async function readConfig(): Promise<CliConfig | null> {
  const cfgPath = getConfigPath();
  let raw: string;
  try {
    raw = await readFile(cfgPath, "utf8");
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    throw err;
  }
  return JSON.parse(raw) as CliConfig;
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
    // but on some platforms it may not — assert here for safety).
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
    profiles: {},
  };

  // Merge entry into existing profile (don't overwrite unrelated fields).
  const current = existing.profiles[profileName] ?? {};
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
    }
  }
  await writeConfig(cfg);
}
