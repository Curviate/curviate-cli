/**
 * `curviate login` — write or update an API key profile.
 *
 * Interactive mode (TTY, no --api-key): prompts for the key with masked
 * input (not echoed), then writes to the named profile.
 *
 * Non-interactive mode (--api-key <key>, or --api-key - to read from stdin):
 * writes without prompting. The key never appears in argv when read from stdin.
 *
 * A blank/empty key is rejected before any write (exit 2).
 * A --base-url of "" (explicitly empty) is rejected (exit 2).
 *
 * No network call is made — the key is saved as-is; the first real command
 * verifies it against the API.
 */

import { defineCommand } from "citty";
import { writeProfile } from "../lib/config.js";
import type { ProfileEntry } from "../lib/config.js";
import { GLOBAL_FLAGS } from "../lib/global-flags.js";
import { readlineSync } from "../lib/readline.js";
import { defaultReadStdin, resolveTextOrStdin } from "../lib/stdin.js";

type LoginArgs = {
  "api-key"?: string;
  account?: string;
  "base-url"?: string;
  profile?: string;
};

type LoginOut = {
  stderr: { write: (s: string) => void };
};

/**
 * Run the login non-interactive path (exported for testing).
 *
 * Takes a pre-resolved `api-key` (no TTY/stdin prompting here — that's
 * handled by the citty command handler before it calls this).
 *
 * Validates:
 *   - api-key must not be blank
 *   - base-url must not be "" (explicitly empty string)
 *
 * Writes the profile entry using `writeProfile` which merges into any existing
 * profile, so omitting `base-url` preserves whatever was previously stored.
 */
export async function runLogin(
  args: LoginArgs,
  out: LoginOut,
): Promise<void> {
  const profileName = args.profile ?? "default";
  const apiKey = (args["api-key"] ?? "").trim();

  if (!apiKey) {
    out.stderr.write("error: API key must not be empty.\n");
    process.exit(2);
    return;
  }

  const baseUrl = args["base-url"];
  if (baseUrl === "") {
    out.stderr.write("error: --base-url must not be empty.\n");
    process.exit(2);
    return;
  }

  const account = args.account;
  const entry: ProfileEntry = { apiKey, account };
  // Only include baseUrl when explicitly provided (non-empty).
  // Omitting it from the entry lets writeProfile's merge keep any existing baseUrl.
  if (baseUrl !== undefined && baseUrl !== "") {
    entry.baseUrl = baseUrl;
  }

  await writeProfile(profileName, entry);

  out.stderr.write(
    `Saved to profile "${profileName}". Run \`curviate profile me\` to verify.\n`,
  );
}

export const loginCommand = defineCommand({
  meta: {
    name: "login",
    description:
      "Save an API key to a local profile. Run `curviate profile me` to verify.",
  },
  args: {
    ...GLOBAL_FLAGS,
    "api-key": {
      type: "string",
      description:
        'API key to save. Pass "-" to read from stdin (keeps the key off argv).',
    },
    account: {
      type: "string",
      description: "Default account id to store with this profile.",
    },
    profile: {
      type: "string",
      description: "Profile name to write to (default: default).",
      default: "default",
    },
  },
  async run({ args }) {
    const profileName = (args.profile as string | undefined) ?? "default";
    let apiKey = (args["api-key"] as string | undefined);
    const out: LoginOut = { stderr: { write: (s: string) => process.stderr.write(s) } };

    // `--api-key -` means: read the key from stdin. Routed through the shared
    // resolver, which recognises both the literal dash and the sentinel the
    // dispatcher substitutes for it. Testing for the dash here instead is what
    // let the raw sentinel be persisted as the user's API key.
    if (apiKey !== undefined) {
      // Trimming both ends, not just trailing newlines: a key is a single
      // token, and a leading space survives a copy-paste more often than not.
      apiKey = await resolveTextOrStdin(apiKey, out, async () =>
        (await defaultReadStdin()).trim(),
      );
    }

    // If no --api-key and we have a TTY, prompt interactively.
    if (apiKey === undefined) {
      if (process.stdin.isTTY) {
        apiKey = await promptMasked("Enter your API key: ");
      } else {
        process.stderr.write(
          "error: no API key, pass --api-key or run interactively on a TTY.\n",
        );
        process.exit(2);
        return;
      }
    }

    await runLogin(
      {
        "api-key": apiKey,
        account: args.account as string | undefined,
        "base-url": args["base-url"] as string | undefined,
        profile: profileName,
      },
      out,
    );
  },
});

/**
 * Prompt for masked (not echoed) input.
 * Uses readline with setRawMode when available for mask-on-TTY behavior.
 */
async function promptMasked(prompt: string): Promise<string> {
  return readlineSync(prompt, { mask: true });
}
