/**
 * `curviate config`, manage named profiles in the config file.
 *
 * Subcommands:
 *   config list: list profiles with redacted keys; mark active.
 *   config path: print absolute config file path (even if absent).
 *   config use <name>: set active profile.
 *   config rename <o> <n>: rename a profile.
 *   config set-account: set default account on active (or --profile) profile.
 *   config set-base-url: set base URL on active profile; --reset clears it.
 *   config reset: remove config file (or --profile to remove one profile).
 */

import { defineCommand } from "citty";
import {
  readConfig,
  getConfigPath,
  setActiveProfile,
  renameProfile,
  removeProfile,
  updateProfileField,
  readConfigFile,
  assertStructure,
  isPlainObject,
  PROFILE_FIELD_TYPES,
} from "../lib/config.js";
import { GLOBAL_FLAGS } from "../lib/global-flags.js";
import { redactKeyForDisplay } from "../lib/config-display.js";
import { baseUrlProblem, withoutUserinfo } from "../lib/client.js";


export const configCommand = defineCommand({
  meta: {
    name: "config",
    description: "Manage CLI profiles and settings.",
  },
  subCommands: {
    list: defineCommand({
      meta: { name: "list", description: "List all profiles (keys redacted)." },
      args: { json: GLOBAL_FLAGS.json },
      async run({ args }) {
        // Never refuses: this is how a malformed file gets inspected. A field of
        // the wrong type renders as <invalid>, never its value, and only known
        // fields are emitted.
        const file = await readConfigFile();
        if (!file) {
          process.stderr.write("No config file found. Run `curviate login` to create one.\n");
          return;
        }
        // Nothing to list in a file that does not parse: exit 2 with the repair.
        if (file.unparseable) assertStructure(file, false);
        const INVALID = "<invalid>";
        const root = isPlainObject(file.root) ? file.root : undefined;
        const rawActive = root?.["active"];
        const active = rawActive === undefined || rawActive === null ? undefined : typeof rawActive === "string" ? rawActive : INVALID;
        const rawProfiles = root === undefined ? INVALID : (root["profiles"] ?? {});
        const profiles = isPlainObject(rawProfiles) ? rawProfiles : undefined;

        /** Known fields of one profile, display-safe; `<invalid>` for a non-object. */
        const display = (profile: unknown): Record<string, string | number> | string => {
          if (!isPlainObject(profile)) return INVALID;
          const out: Record<string, string | number> = {};
          for (const [field, want] of Object.entries(PROFILE_FIELD_TYPES)) {
            const value = profile[field];
            if (typeof value !== want) {
              if (value !== undefined && value !== null) out[field] = INVALID;
            } else {
              out[field] =
                field === "apiKey"
                  ? redactKeyForDisplay(value as string)
                  : field === "baseUrl"
                    ? withoutUserinfo(value as string)
                    : (value as string | number);
            }
          }
          if (out["apiKey"] === undefined) out["apiKey"] = redactKeyForDisplay(undefined);
          return out;
        };

        const json = (args.json as boolean | undefined) ?? !process.stdout.isTTY;
        const entries = Object.entries(profiles ?? {}).filter(([, profile]) => profile !== undefined && profile !== null);

        if (json) {
          // Built with no prototype: a profile named "__proto__" assigned into
          // a plain `{}` hits the inherited accessor instead of creating an own
          // key, silently dropping that profile from the JSON output.
          const shown = Object.create(null) as Record<string, unknown>;
          for (const [name, profile] of entries) {
            const d = display(profile);
            shown[name] = typeof d === "string" ? d : { ...d, ...(name === active ? { active: true } : {}) };
          }
          process.stdout.write(
            JSON.stringify({ ...(active !== undefined ? { active } : {}), profiles: profiles ? shown : INVALID }) + "\n",
          );
        } else {
          if (active === INVALID) process.stdout.write(`active: ${INVALID}\n`);
          if (!profiles) process.stdout.write(`profiles: ${INVALID}\n`);
          for (const [name, profile] of entries) {
            const marker = name === active ? " (active)" : "";
            process.stdout.write(`${name}${marker}\n`);
            const d = display(profile);
            if (typeof d === "string") {
              process.stdout.write(`  ${d}\n`);
              continue;
            }
            process.stdout.write(`  apiKey: ${d["apiKey"]}\n`);
            for (const field of ["account", "baseUrl", "timeout"]) {
              if (d[field]) process.stdout.write(`  ${field}: ${d[field]}\n`);
            }
          }
        }
      },
    }),

    path: defineCommand({
      meta: { name: "path", description: "Print the config file path." },
      async run() {
        process.stdout.write(getConfigPath() + "\n");
      },
    }),

    use: defineCommand({
      meta: { name: "use", description: "Set the active profile." },
      args: {
        name: { type: "positional", description: "Profile name to activate." },
      },
      async run({ args }) {
        const name = args.name as string;
        try {
          await setActiveProfile(name);
          process.stderr.write(`Switched to profile "${name}".\n`);
        } catch (err: unknown) {
          process.stderr.write(
            `error: ${err instanceof Error ? err.message : "unknown error"}\n`,
          );
          process.exit(2);
        }
      },
    }),

    rename: defineCommand({
      meta: { name: "rename", description: "Rename a profile." },
      args: {
        old: { type: "positional", description: "Current profile name." },
        new: { type: "positional", description: "New profile name." },
      },
      async run({ args }) {
        const oldName = args.old as string;
        const newName = args.new as string;
        try {
          await renameProfile(oldName, newName);
          process.stderr.write(`Renamed profile "${oldName}" to "${newName}".\n`);
        } catch (err: unknown) {
          process.stderr.write(
            `error: ${err instanceof Error ? err.message : "unknown error"}\n`,
          );
          process.exit(2);
        }
      },
    }),

    "set-account": defineCommand({
      meta: {
        name: "set-account",
        description: "Set the default account on a profile.",
      },
      args: {
        profile: GLOBAL_FLAGS.profile,
        json: GLOBAL_FLAGS.json,
        account: {
          type: "positional",
          description: "Account id to set as default.",
        },
      },
      async run({ args }) {
        const cfg = await readConfig();
        if (!cfg) {
          process.stderr.write("No config file. Run `curviate login` first.\n");
          process.exit(2);
        }
        const profileName = (args.profile as string | undefined) ?? cfg.active;
        const account = args.account as string;
        try {
          await updateProfileField(profileName, "account", account);
          process.stderr.write(`Set account "${account}" on profile "${profileName}".\n`);
        } catch (err: unknown) {
          process.stderr.write(
            `error: ${err instanceof Error ? err.message : "unknown error"}\n`,
          );
          process.exit(2);
        }
      },
    }),

    "set-base-url": defineCommand({
      meta: {
        name: "set-base-url",
        description: "Set or clear the base URL on a profile.",
      },
      args: {
        profile: GLOBAL_FLAGS.profile,
        json: GLOBAL_FLAGS.json,
        url: {
          type: "positional",
          description: 'Base URL to set, or "" to clear.',
          required: false,
        },
        reset: {
          type: "boolean",
          description: "Clear the base URL (reset to SDK default).",
          default: false,
        },
      },
      async run({ args }) {
        const cfg = await readConfig();
        if (!cfg) {
          process.stderr.write("No config file. Run `curviate login` first.\n");
          process.exit(2);
        }
        const profileName = (args.profile as string | undefined) ?? cfg.active;
        const reset = args.reset as boolean;
        const url = reset ? undefined : ((args.url as string | undefined) ?? "");
        const badUrl = url ? baseUrlProblem(url) : null;
        if (badUrl) {
          process.stderr.write(`error: ${badUrl}\n`);
          process.exit(2);
        }

        try {
          await updateProfileField(
            profileName,
            "baseUrl",
            url === "" ? undefined : url,
          );
          if (url === undefined || url === "") {
            process.stderr.write(
              `Cleared baseUrl on profile "${profileName}", using the API default.\n`,
            );
          } else {
            process.stderr.write(
              `Set baseUrl to "${url}" on profile "${profileName}".\n`,
            );
          }
        } catch (err: unknown) {
          process.stderr.write(
            `error: ${err instanceof Error ? err.message : "unknown error"}\n`,
          );
          process.exit(2);
        }
      },
    }),

    reset: defineCommand({
      meta: {
        name: "reset",
        description: "Remove the config file (or a single profile).",
      },
      args: {
        json: GLOBAL_FLAGS.json,
        profile: {
          type: "string",
          description: "Remove only this profile instead of the whole file.",
        },
        yes: {
          type: "boolean",
          description: "Skip the confirmation prompt.",
          default: false,
        },
      },
      async run({ args }) {
        const profileName = args.profile as string | undefined;
        const yes = args.yes as boolean;

        // Confirm on TTY unless --yes.
        if (!yes && process.stdin.isTTY) {
          const target = profileName ? `profile "${profileName}"` : "the entire config file";
          process.stderr.write(`Remove ${target}? [y/N] `);
          const answer = await new Promise<string>((resolve) => {
            process.stdin.setEncoding("utf8");
            process.stdin.once("data", (chunk: string) => {
              resolve(chunk.trim().toLowerCase());
            });
          });
          if (answer !== "y" && answer !== "yes") {
            process.stderr.write("Aborted.\n");
            return;
          }
        }

        if (profileName) {
          await removeProfile(profileName);
          process.stderr.write(`Removed profile "${profileName}".\n`);
        } else {
          const { unlink } = await import("node:fs/promises");
          try {
            await unlink(getConfigPath());
            process.stderr.write("Config file removed.\n");
          } catch (err: unknown) {
            const e = err as NodeJS.ErrnoException;
            if (e.code !== "ENOENT") {
              process.stderr.write(`error: could not remove config file: ${e.message}\n`);
              process.exit(1);
            }
            // File already gone, that's fine.
            process.stderr.write("No config file to remove.\n");
          }
        }
      },
    }),
  },
  async run() {
    process.stderr.write(
      "Usage: curviate config <subcommand>\n" +
      "  list         List all profiles (keys redacted)\n" +
      "  path         Print config file path\n" +
      "  use <name>   Set active profile\n" +
      "  rename <old> <new>\n" +
      "  set-account <acc>\n" +
      "  set-base-url [<url>] [--reset]\n" +
      "  reset        [--profile <name>] [--yes]\n",
    );
  },
});
