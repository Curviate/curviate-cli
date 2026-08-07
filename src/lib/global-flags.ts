/**
 * Global flags inherited by every command in the CLI.
 *
 * Declared once here and merged into each leaf command's argument schema, so
 * `curviate <anything> --json --account acc_1` parses identically regardless
 * of which command is running.
 *
 * Semantics of each flag are owned by the relevant sub-system:
 *   --account / --api-key / --profile  -> lib/resolve.ts (auth & config)
 *   --json / --fields / --limit / --cursor / --all / --max-pages -> lib/output.ts
 *   --preview                           -> lib/preview.ts
 *   --base-url / --timeout              -> lib/resolve.ts
 */

export const GLOBAL_FLAGS = {
  // Auth / config
  "api-key": {
    type: "string" as const,
    description:
      "API key (overrides env and profile). Note: a key passed on the command line is visible to other processes via `ps` and is saved in shell history; prefer the CURVIATE_API_KEY env var or `curviate login`.",
  },
  profile: {
    type: "string" as const,
    description: "Named profile to use from the config file.",
  },
  account: {
    type: "string" as const,
    description: "Account id for account-scoped commands.",
  },
  "base-url": {
    type: "string" as const,
    description: "Override the API base URL.",
  },
  timeout: {
    type: "string" as const,
    description: "Request timeout in milliseconds.",
  },
  // Output
  json: {
    type: "boolean" as const,
    description: "Emit JSON output (default when stdout is not a TTY).",
    default: false,
  },
  fields: {
    type: "string" as const,
    description: "Comma-separated dot-path field projection (e.g. id,name).",
  },
  limit: {
    type: "string" as const,
    description: "Maximum items per page.",
  },
  cursor: {
    type: "string" as const,
    description: "Pagination cursor (opaque token from a previous response).",
  },
  all: {
    type: "boolean" as const,
    description: "Stream all pages as NDJSON.",
    default: false,
  },
  "max-pages": {
    type: "string" as const,
    description: "Maximum number of pages to fetch when --all is used.",
  },
  "page-delay": {
    type: "string" as const,
    description:
      "Milliseconds to pause between pages when --all is used (default 400; pass 0 to disable). A modest delay keeps a long stream under the platform rate gate.",
  },
  preview: {
    type: "boolean" as const,
    description:
      "Render the request that would be sent without calling the API.",
    default: false,
  },
  verbose: {
    type: "boolean" as const,
    description: "Output the full SDK response instead of the slim default.",
    default: false,
  },
} as const;

export type GlobalFlags = {
  "api-key"?: string;
  profile?: string;
  account?: string;
  "base-url"?: string;
  timeout?: string;
  json?: boolean;
  fields?: string;
  limit?: string;
  cursor?: string;
  all?: boolean;
  "max-pages"?: string;
  "page-delay"?: string;
  preview?: boolean;
  verbose?: boolean;
};

/**
 * WRITE_FLAGS: GLOBAL_FLAGS minus pagination/projection flags.
 *
 * Spread into write (mutating) commands so `--limit`, `--cursor`, `--all`,
 * `--max-pages`, and `--fields` do NOT appear in their `--help` output.
 * These flags are list-read-only and have no meaning on mutations.
 */
export const WRITE_FLAGS = {
  "api-key": GLOBAL_FLAGS["api-key"],
  profile: GLOBAL_FLAGS.profile,
  account: GLOBAL_FLAGS.account,
  "base-url": GLOBAL_FLAGS["base-url"],
  timeout: GLOBAL_FLAGS.timeout,
  json: GLOBAL_FLAGS.json,
  preview: GLOBAL_FLAGS.preview,
  verbose: GLOBAL_FLAGS.verbose,
};

export type WriteFlags = Omit<GlobalFlags, "limit" | "cursor" | "all" | "max-pages" | "page-delay" | "fields">;

/**
 * READ_SINGLE_FLAGS: GLOBAL_FLAGS minus pagination-only flags, but keeping --fields.
 *
 * Spread into single-object read commands so `--limit`, `--cursor`, `--all`,
 * and `--max-pages` do NOT appear in their `--help` output. `--fields` is
 * retained because field projection is meaningful on single-object reads.
 * These are non-paginated reads (inbox get, message get, inbox sync, etc.).
 */
export const READ_SINGLE_FLAGS = {
  "api-key": GLOBAL_FLAGS["api-key"],
  profile: GLOBAL_FLAGS.profile,
  account: GLOBAL_FLAGS.account,
  "base-url": GLOBAL_FLAGS["base-url"],
  timeout: GLOBAL_FLAGS.timeout,
  json: GLOBAL_FLAGS.json,
  fields: GLOBAL_FLAGS.fields,
  preview: GLOBAL_FLAGS.preview,
  verbose: GLOBAL_FLAGS.verbose,
};

export type ReadSingleFlags = Omit<GlobalFlags, "limit" | "cursor" | "all" | "max-pages" | "page-delay">;

/**
 * WRITE_SINGLE_FLAGS: the single-object write convention.
 *
 * For write (mutating) commands that operate on exactly one resource
 * (connect/reconnect/update/disconnect an account, submit or poll a
 * checkpoint) rather than a list. Pagination flags (`--limit`, `--cursor`,
 * `--all`, `--max-pages`) are meaningless on a one-row response, but
 * `--fields` is still useful to project it, unlike `WRITE_FLAGS`, which
 * drops `--fields` too because it targets commands with no response shape
 * worth projecting. Identical to `READ_SINGLE_FLAGS` today (same flag set
 * serves both single-object reads and single-object writes); kept as its
 * own export so the two call sites can diverge later without a rename.
 */
export const WRITE_SINGLE_FLAGS = READ_SINGLE_FLAGS;

export type WriteSingleFlags = ReadSingleFlags;
