/**
 * Command dispatcher — a thin pre-router around citty 0.1.6.
 *
 * WHY THIS EXISTS (citty 0.1.6 constraint):
 * citty's own `runCommand` mis-handles command nodes that declare BOTH a bare
 * positional argument AND `subCommands`:
 *
 *   1. MISROUTE — when the first non-flag token is not a registered subcommand
 *      keyword, citty throws `Unknown command <token>` and the node's own
 *      `run()` (the bare-positional handler) is never reached. So an intent-
 *      shaped form like `connect <slug>` or `profile <url>` is rejected.
 *   2. DOUBLE-RUN — when the first token IS a subcommand keyword, citty runs
 *      the subcommand AND THEN also runs the parent node's `run()` (the
 *      `if (cmd.run)` branch sits OUTSIDE the subcommand block). So
 *      `message new …` executes `new` (startChat) and then the parent send
 *      handler with the positional captured as `"new"`.
 *   3. USAGE-ERROR EXIT CODE — citty's `runMain` exits `1` for routing errors
 *      and bleeds a usage block to stderr; the CLI contract wants exit `2`.
 *
 * This dispatcher walks the command tree itself and resolves exactly ONE node
 * to execute, so a node may safely mix a bare-positional `run()` with
 * `subCommands`:
 *   - first token matches a subcommand keyword → descend into it ONLY.
 *   - otherwise, if the node has a `run()` → execute the bare form ONLY.
 *   - otherwise (pure group, unknown token) → usage error, exit 2.
 *
 * The resolved leaf is then executed via citty's `runCommand` on a clone with
 * `subCommands` removed, so citty's buggy descent never fires again. citty's
 * arg parsing (positionals, flags, types) is reused unchanged.
 *
 * DO NOT collapse this back into a plain `runMain(main)` call: the bare-form
 * UX (`connect <slug>`, `profile <url>`, `message <chat> "text"`) depends on
 * this pre-dispatch, and citty 0.1.6 cannot express it natively.
 */

import { runCommand, type CommandDef } from "citty";
import { STDIN_SENTINEL } from "./lib/stdin.js";

type AnyCommand = CommandDef;

/**
 * Removed/renamed commands → a one-line "did you mean" successor hint.
 *
 * Keyed by `<group>` → `<removed subcommand token>` → hint text. Consulted at
 * the dispatcher's unknown-command path so an agent that reaches for the old
 * grammar is pointed at the replacement instead of getting a bare "unknown
 * command" (pure groups) or a confusing downstream error from the removed
 * keyword being swallowed as a bare id (the bare-positional groups: connect,
 * profile, company). Exit stays 2 — this only enriches the diagnostic.
 *
 * The tokens here are the exact removed/renamed keywords from the 0.15.0
 * release; none is a current subcommand, and none is a plausible bare
 * identifier (a member slug, company id, or invitation id is never literally
 * "respond"/"connections"/"followers"), so intercepting them is safe.
 */
const REMOVED_COMMANDS: Record<string, Record<string, string>> = {
  post: {
    list: "`post list` was removed — use `post user-posts <user_id>` (accepts `me`).",
    comment: "post comments are their own group now — use `comment add <post_id> <text>`.",
    comments: "post comments are their own group now — use `comment list <post_id>`.",
  },
  connect: {
    respond: "`connect respond` was split — use `connect accept <id>` or `connect decline <id>`.",
  },
  profile: {
    connections: "`profile connections` was renamed — use `profile relations`.",
  },
  account: {
    "connect-link": "`account connect-link` was removed — use `account link [--account-id <id>]`.",
    "reconnect-link": "`account reconnect-link` was removed — use `account link [--account-id <id>]`.",
    reconnect: "`account reconnect` was removed — use `account link [--account-id <id>]`.",
  },
  inbox: {
    sync: "`inbox sync` was removed — history syncs automatically; just read `inbox messages <chat_id>`.",
    "sync-chat": "`inbox sync-chat` was removed — history syncs automatically; just read `inbox messages <chat_id>`.",
  },
  recruiter: {
    "add-candidate": "`recruiter add-candidate` was renamed — use `recruiter save-candidate <project_id> --stage-id <id> --candidate-id <id>`.",
    "project-jobs": "`recruiter project-jobs` was renamed — use `recruiter project-job get <project_id>`.",
    sync: "`recruiter sync` was removed — Recruiter data syncs automatically now.",
    "add-applicant": "`recruiter add-applicant` was removed with no replacement.",
    "reject-applicant": "`recruiter reject-applicant` was removed with no replacement.",
  },
  "sales-nav": {
    sync: "`sales-nav sync` was removed — Sales Navigator data syncs automatically now.",
  },
  webhook: {
    "state-diff": "`webhook state-diff` was removed with no replacement.",
  },
};

// `company followers` was removed in the 0.15.0 v2 migration (the v1 endpoint
// it wrapped no longer existed) and re-added as a real subcommand once the SDK
// shipped a new v2 `companies.followers` method, so it is no longer in the map
// above. See CHANGELOG.md 0.15.0 "Removed" and the current entry under
// "Added" for both halves of this history.

/**
 * The successor hint for a removed/renamed `<group> <token>`, or null when the
 * token is a current command or a plausible identifier. Exported for direct
 * unit coverage of the map.
 */
export function successorHint(group: string, token: string): string | null {
  return REMOVED_COMMANDS[group]?.[token] ?? null;
}

/** Resolve a possibly-lazy citty value (subCommands entry, args, meta). */
async function resolveValue<T>(input: T | (() => T) | (() => Promise<T>)): Promise<T> {
  return typeof input === "function" ? (input as () => T | Promise<T>)() : input;
}

/** Index of the first token that is not a flag (does not start with "-"). */
function firstPositionalIndex(rawArgs: string[]): number {
  return rawArgs.findIndex((a) => !a.startsWith("-"));
}

/**
 * Whether a node declares at least one positional argument — i.e. it accepts a
 * bare intent-shaped form (e.g. `connect <slug>`, `profile <url>`,
 * `message <chat_id> "text"`). Pure groups (account, webhook, …) declare none,
 * so an unrecognized token under them is an unknown-subcommand usage error.
 */
async function nodeHasPositional(cmd: AnyCommand): Promise<boolean> {
  const argsDef = (await resolveValue(cmd.args ?? {})) as Record<
    string,
    { type?: string }
  >;
  return Object.values(argsDef).some((def) => def?.type === "positional");
}

/** Count of positional arguments a node declares (the bare form's arity). */
async function nodePositionalCount(cmd: AnyCommand): Promise<number> {
  const argsDef = (await resolveValue(cmd.args ?? {})) as Record<
    string,
    { type?: string }
  >;
  return Object.values(argsDef).filter((def) => def?.type === "positional").length;
}

/** Names (and aliases) of a node's boolean flags — flags that take no value. */
async function booleanFlagNames(cmd: AnyCommand): Promise<Set<string>> {
  const names = new Set<string>();
  const argsDef = (await resolveValue(cmd.args ?? {})) as Record<
    string,
    { type?: string; alias?: string | string[] }
  >;
  for (const [name, def] of Object.entries(argsDef)) {
    if (def?.type !== "boolean") continue;
    names.add(name);
    const alias = def.alias;
    if (typeof alias === "string") names.add(alias);
    else if (Array.isArray(alias)) for (const a of alias) names.add(a);
  }
  return names;
}

/** Resolve a node's display name (meta may be lazy) for a usage diagnostic. */
async function nodeName(cmd: AnyCommand): Promise<string> {
  const meta = (await resolveValue(cmd.meta ?? {})) as { name?: string };
  return meta.name ?? "this command";
}

/**
 * The positional tokens citty/mri would leave after parsing `rawArgs` against a
 * node's declared flags — matching mri's rule that a `--flag` consumes the
 * FOLLOWING token as its value UNLESS the flag is declared boolean (or the value
 * is inline `--flag=value`, or the following token is itself a flag). An unknown
 * `--flag` consumes its follower too (mri's default), so a subcommand's own flag
 * (e.g. `company <id> employees --keywords eng`) is classified correctly even at
 * the parent node that never declared it.
 *
 * Used to detect UNEXPECTED extra positionals — tokens beyond a node's declared
 * positional arity that citty would silently swallow into `args._` (the D4a
 * silent-wrong-data class). Each result carries its index in `rawArgs` so a
 * reroute can drop exactly the subcommand-naming token.
 */
function positionalTokens(
  rawArgs: string[],
  booleanFlags: Set<string>,
): Array<{ token: string; index: number }> {
  const out: Array<{ token: string; index: number }> = [];
  let afterDoubleDash = false;
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]!;
    if (afterDoubleDash) {
      out.push({ token: arg, index: i });
      continue;
    }
    if (arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    // A flag: starts with "-" but is not the bare "-" stdin sentinel.
    if (arg.startsWith("-") && arg !== "-") {
      const body = arg.replace(/^-+/, "");
      if (body.includes("=")) continue; // inline value — self-contained
      const isBoolean =
        booleanFlags.has(body) ||
        (body.startsWith("no-") && booleanFlags.has(body.slice(3)));
      if (isBoolean) continue; // boolean flag — consumes no following token
      // Value-flag (declared string or unknown): consume the next token as its
      // value when present and not itself a flag (mirrors mri).
      const next = rawArgs[i + 1];
      if (next !== undefined && !(next.startsWith("-") && next !== "-")) i++;
      continue;
    }
    // Positional (including the bare "-" stdin sentinel).
    out.push({ token: arg, index: i });
  }
  return out;
}

/** Collect the declared argument names for a node (for unknown-flag detection). */
async function declaredArgNames(cmd: AnyCommand): Promise<Set<string>> {
  const names = new Set<string>();
  const argsDef = (await resolveValue(cmd.args ?? {})) as Record<
    string,
    { type?: string; alias?: string | string[] }
  >;
  for (const [name, def] of Object.entries(argsDef)) {
    names.add(name);
    const alias = def?.alias;
    if (typeof alias === "string") names.add(alias);
    else if (Array.isArray(alias)) for (const a of alias) names.add(a);
  }
  return names;
}

/**
 * Validate that every `--flag` / `-x` in rawArgs is a declared argument on the
 * resolved leaf. Unknown flags are a usage error (exit 2) per the CLI contract.
 * Returns the offending flag token, or null if all flags are known.
 *
 * citty's own parser silently accepts unknown flags, so this check is the CLI
 * layer's responsibility.
 */
function findUnknownFlag(rawArgs: string[], declared: Set<string>): string | null {
  let afterDoubleDash = false;
  for (const arg of rawArgs) {
    if (afterDoubleDash) continue;
    if (arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!arg.startsWith("-")) continue;
    // Strip leading dashes and any "=value" suffix to get the flag name.
    let name = arg.replace(/^-+/, "");
    const eq = name.indexOf("=");
    if (eq !== -1) name = name.slice(0, eq);
    if (name === "") continue; // bare "--" already handled
    // Match the full declared name FIRST — a flag may be literally declared
    // with a "no-" prefix (e.g. "no-interactive"), and that declaration must
    // win. Only fall back to stripping "no-" for citty's implicit negation
    // (e.g. "--no-json" negating a declared "json") when the full name isn't
    // itself declared.
    if (declared.has(name)) continue;
    if (name.startsWith("no-") && declared.has(name.slice(3))) continue;
    return arg;
  }
  return null;
}

/** Whether `--fields ""` (empty projection) was passed — a usage error. */
function hasEmptyFields(rawArgs: string[]): boolean {
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--fields") {
      // Empty when the next token is missing, another flag, or the literal "".
      const next = rawArgs[i + 1];
      if (next === undefined || next.startsWith("-")) return true;
      if (next.trim() === "") return true;
    } else if (arg?.startsWith("--fields=")) {
      if (arg.slice("--fields=".length).trim() === "") return true;
    }
  }
  return false;
}

/**
 * Emit a usage diagnostic to stderr and exit 2 (CLI-side usage error).
 * An optional `hint` line (e.g. a removed-command successor) is written
 * between the error and the generic help pointer.
 */
function usageError(message: string, hint?: string): never {
  process.stderr.write(`error: ${message}\n`);
  if (hint) process.stderr.write(`hint: ${hint}\n`);
  process.stderr.write("Run `curviate --help` for usage.\n");
  process.exit(2);
}

/**
 * Resolve a node + remaining args down to the single command to execute,
 * descending through matching subcommand keywords. Returns the leaf to run and
 * the rawArgs that belong to it. On an unrecognized token under a pure group
 * (no bare `run`), emits a usage error and exits 2.
 */
export async function resolveLeaf(
  cmd: AnyCommand,
  rawArgs: string[],
): Promise<{ leaf: AnyCommand; leafArgs: string[] }> {
  const subCommands = (await resolveValue(cmd.subCommands)) as
    | Record<string, unknown>
    | undefined;

  if (subCommands && Object.keys(subCommands).length > 0) {
    const idx = firstPositionalIndex(rawArgs);
    const token = idx === -1 ? undefined : rawArgs[idx];
    const hasBarePositional = await nodeHasPositional(cmd);

    if (token !== undefined && subCommands[token]) {
      // Token is a known subcommand keyword → descend into it ONLY.
      const sub = (await resolveValue(subCommands[token])) as AnyCommand;
      return resolveLeaf(sub, rawArgs.slice(idx + 1));
    }

    // Removed/renamed command → point at the successor BEFORE the token is
    // either swallowed as a bare positional (connect/profile/company) or
    // reported as a generic unknown command (pure groups). A current
    // subcommand always won above, so this only ever fires on a stale token.
    if (token !== undefined) {
      const hint = successorHint(await nodeName(cmd), token);
      if (hint) {
        usageError(`unknown command \`${token}\``, hint);
      }
    }

    if (token !== undefined && hasBarePositional) {
      // No keyword match but the node accepts a bare positional. Before running
      // the bare form, guard against UNEXPECTED extra positionals: citty binds
      // only the node's declared positionals and silently swallows the rest into
      // `args._` — the D4a silent-wrong-data class (e.g. `company <id> employees`
      // returning the base company profile, ignoring `employees`). Reroute an
      // id-first ergonomic form, or fail loudly — never silently ignore.
      const booleanFlags = await booleanFlagNames(cmd);
      const positionals = positionalTokens(rawArgs, booleanFlags);
      const declaredCount = await nodePositionalCount(cmd);
      const extras = positionals.slice(declaredCount);
      if (extras.length > 0) {
        const first = extras[0]!;
        // Exactly one extra positional that names a subcommand → the id-first
        // form `<group> <id> <sub>`, equivalent to `<group> <sub> <id>`. Drop
        // only that token and descend into the subcommand with the remaining
        // args (the id positional + any flags, which the subcommand re-parses).
        if (
          extras.length === 1 &&
          Object.prototype.hasOwnProperty.call(subCommands, first.token)
        ) {
          const sub = (await resolveValue(subCommands[first.token])) as AnyCommand;
          const remaining = rawArgs.filter((_, i) => i !== first.index);
          return resolveLeaf(sub, remaining);
        }
        // Otherwise it cannot be a valid reroute → actionable usage error, never
        // a silent swallow of the extra token.
        const name = await nodeName(cmd);
        usageError(
          `unexpected argument \`${first.token}\` after \`${name}\`. ` +
            `It is neither a positional \`${name}\` accepts nor one of its subcommands. ` +
            `Run \`curviate ${name} --help\` for the available subcommands.`,
        );
      }
      // No keyword match but the node accepts a bare positional → run it.
      return { leaf: cmd, leafArgs: rawArgs };
    }

    // No bare-positional intent. A token here is an unknown subcommand keyword.
    if (token !== undefined) {
      usageError(`unknown command \`${token}\``);
    }
    // No token at all → no subcommand specified. Run the node's handler (group
    // nodes print their usage block; the root's no-op falls through to help).
    return { leaf: cmd, leafArgs: rawArgs };
  }

  // Leaf node (no subcommands).
  return { leaf: cmd, leafArgs: rawArgs };
}

/**
 * Run the root command against rawArgs, applying the citty-0.1.6 workarounds
 * described in the file header. Mirrors citty's `runMain` for the help/version
 * fast-paths, then routes through `resolveLeaf`.
 */
export async function dispatch(root: AnyCommand, rawArgs: string[]): Promise<void> {
  // --help / -h : delegate to citty's renderer (exit 0). Resolve the deepest
  // matching node so `curviate profile me --help` shows the right usage.
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    const { showUsage, runMain } = await import("citty");
    // runMain handles --help by resolving the subcommand and printing usage.
    // We only borrow its help path; routing is ours.
    void showUsage;
    await runMain(root, { rawArgs });
    return;
  }

  if (rawArgs.length === 1 && rawArgs[0] === "--version") {
    const meta = (await resolveValue(root.meta ?? {})) as { version?: string };
    if (meta.version) {
      process.stdout.write(meta.version + "\n");
    }
    process.exit(0);
  }

  try {
    const { leaf, leafArgs } = await resolveLeaf(root, rawArgs);

    // CLI-side usage validation on the resolved leaf, BEFORE any handler runs
    // (so a bad projection / unknown flag never reaches the SDK).
    if (hasEmptyFields(leafArgs)) {
      usageError("--fields must not be empty.");
    }
    const declared = await declaredArgNames(leaf);
    const unknown = findUnknownFlag(leafArgs, declared);
    if (unknown !== null) {
      usageError(`unknown flag \`${unknown}\`.`);
    }

    // Pre-process: replace bare "-" with the stdin sentinel before handing to
    // citty/mri. mri's embedded parser (j-dash-count loop) silently swallows "-"
    // — one leading dash gives j=1 → flag branch → empty name → 0-char iteration
    // → never lands in `_[]` → citty cannot bind it to a positional. The sentinel
    // starts with "_" (no leading dash) so mri treats it as a plain positional;
    // resolveTextOrStdin then recognises both "-" and the sentinel.
    const processedLeafArgs = leafArgs.map((a) => (a === "-" ? STDIN_SENTINEL : a));

    // Execute the resolved leaf with subCommands stripped so citty does not
    // re-trigger its buggy descent (misroute / double-run).
    const leafToRun: AnyCommand = { ...leaf, subCommands: undefined };
    await runCommand(leafToRun, { rawArgs: processedLeafArgs });
  } catch (err: unknown) {
    // citty raises a CLIError with code "EARG" for a missing required argument
    // or positional — that is a usage error → exit 2. Anything else thrown here
    // is genuinely unexpected (handlers exit on their own error paths) → exit 1.
    // Either way, write a plain diagnostic without the framework's usage bleed;
    // routing errors already exited 2 above.
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string } | null)?.code;
    process.stderr.write(`error: ${message}\n`);
    process.exit(code === "EARG" ? 2 : 1);
  }
}
