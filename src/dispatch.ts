/**
 * Command dispatcher, a thin pre-router around citty 0.1.6.
 *
 * WHY THIS EXISTS (citty 0.1.6 constraint):
 * citty's own `runCommand` mis-handles command nodes that declare BOTH a bare
 * positional argument AND `subCommands`:
 *
 *   1. MISROUTE, when the first non-flag token is not a registered subcommand
 *      keyword, citty throws `Unknown command <token>` and the node's own
 *      `run()` (the bare-positional handler) is never reached. So an intent-
 *      shaped form like `connect <slug>` or `profile <url>` is rejected.
 *   2. DOUBLE-RUN, when the first token IS a subcommand keyword, citty runs
 *      the subcommand AND THEN also runs the parent node's `run()` (the
 *      `if (cmd.run)` branch sits OUTSIDE the subcommand block). So
 *      `message new ...` executes `new` (startChat) and then the parent send
 *      handler with the positional captured as `"new"`.
 *   3. USAGE-ERROR EXIT CODE, citty's `runMain` exits `1` for routing errors
 *      and bleeds a usage block to stderr; the CLI contract wants exit `2`.
 *
 * This dispatcher walks the command tree itself and resolves exactly ONE node
 * to execute, so a node may safely mix a bare-positional `run()` with
 * `subCommands`:
 *   - first token matches a subcommand keyword -> descend into it ONLY.
 *   - otherwise, if the node has a `run()` -> execute the bare form ONLY.
 *   - otherwise (pure group, unknown token) -> usage error, exit 2.
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
import {
  STDIN_SENTINEL,
  restoreLiteralDashes,
  type RestorableArgDef,
} from "./lib/stdin.js";
import { GLOBAL_FLAGS } from "./lib/global-flags.js";

type AnyCommand = CommandDef;

/**
 * Every global flag name, and the subset that is boolean (takes no value).
 * `GLOBAL_FLAGS` is merged into each LEAF's own `args` (see global-flags.ts's
 * header comment: "curviate <anything> --json --account acc_1 parses
 * identically regardless of which command is running"), but a GROUP node on
 * the way to that leaf, the root `main` command and pure groups like
 * `account`/`webhook` (no bare positional, only `subCommands`), declares no
 * `args` of its own. The routing scan below (which walks every node from the
 * root down, before any leaf is chosen) still has to recognise a global flag
 * and skip its value there, so it unions the current node's own declared
 * flags with this constant. `findUnknownFlag`, by contrast, must NOT use this
 * union: whether a flag is actually ALLOWED on the resolved leaf stays
 * leaf-precise (`account link` deliberately declares no `--limit`), so
 * accept/reject decisions read only the leaf's own args, never this constant.
 */
const GLOBAL_FLAG_NAMES = new Set(Object.keys(GLOBAL_FLAGS));
const GLOBAL_BOOLEAN_FLAG_NAMES = new Set(
  Object.entries(GLOBAL_FLAGS)
    .filter(([, def]) => def.type === "boolean")
    .map(([name]) => name),
);

/**
 * Removed/renamed commands -> a one-line "did you mean" successor hint.
 *
 * Keyed by `<group>` -> `<removed subcommand token>` -> hint text. Consulted at
 * the dispatcher's unknown-command path so an agent that reaches for the old
 * grammar is pointed at the replacement instead of getting a bare "unknown
 * command" (pure groups) or a confusing downstream error from the removed
 * keyword being swallowed as a bare id (the bare-positional groups: connect,
 * profile, company). Exit stays 2; this only enriches the diagnostic.
 *
 * The tokens here are the exact removed/renamed keywords from the 0.15.0
 * release; none is a current subcommand, and none is a plausible bare
 * identifier (a member slug, company id, or invitation id is never literally
 * "respond"/"connections"/"followers"), so intercepting them is safe.
 */
const REMOVED_COMMANDS: Record<string, Record<string, string>> = {
  post: {
    list: "`post list` was removed. Use `post user-posts <user_id>` (accepts `me`).",
    comment: "post comments are their own group now. Use `comment add <post_id> <text>`.",
    comments: "post comments are their own group now. Use `comment list <post_id>`.",
  },
  connect: {
    respond: "`connect respond` was split. Use `connect accept <id>` or `connect decline <id>`.",
  },
  profile: {
    connections: "`profile connections` was renamed. Use `profile relations`.",
  },
  account: {
    "connect-link": "`account connect-link` was removed. Use `account link [--account-id <id>]`.",
    "reconnect-link": "`account reconnect-link` was removed. Use `account link [--account-id <id>]`.",
    reconnect: "`account reconnect` was removed. Use `account link [--account-id <id>]`.",
  },
  inbox: {
    sync: "`inbox sync` was removed. History syncs automatically; just read `inbox messages <chat_id>`.",
    "sync-chat": "`inbox sync-chat` was removed. History syncs automatically; just read `inbox messages <chat_id>`.",
  },
  recruiter: {
    "add-candidate": "`recruiter add-candidate` was renamed. Use `recruiter save-candidate <project_id> --stage-id <id> --candidate-id <id>`.",
    "project-jobs": "`recruiter project-jobs` was renamed. Use `recruiter project-job get <project_id>`.",
    sync: "`recruiter sync` was removed. Recruiter data syncs automatically now.",
    "add-applicant": "`recruiter add-applicant` was removed with no replacement.",
    "reject-applicant": "`recruiter reject-applicant` was removed with no replacement.",
  },
  "sales-nav": {
    sync: "`sales-nav sync` was removed. Sales Navigator data syncs automatically now.",
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

/**
 * The stripped flag name a token names, or null when the token is not
 * flag-shaped: it doesn't start with "-", or it IS the bare "-" (the stdin
 * sentinel's literal meaning elsewhere in this file, never a flag name).
 * Strips every leading dash (so both `-o` and `--output` resolve to a plain
 * name) and any inline `=value` suffix.
 */
function stripFlagName(token: string): string | null {
  if (!token.startsWith("-") || token === "-") return null;
  const body = token.replace(/^-+/, "");
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  return name === "" ? null : name;
}

/** Does `token` name a flag present in `declared` (full name, or its "no-"-stripped form)? */
function isDeclaredFlagToken(token: string, declared: Set<string>): boolean {
  const name = stripFlagName(token);
  if (name === null) return false;
  return declared.has(name) || (name.startsWith("no-") && declared.has(name.slice(3)));
}

interface TokenWalk {
  /** Non-flag tokens, and every token after a literal "--", in argv order. */
  positionals: Array<{ token: string; index: number }>;
  /** Every flag-name occurrence NOT consumed as another flag's value, in argv order. */
  flags: Array<{ token: string; index: number; name: string }>;
  /**
   * `{ flagIndex, valueIndex }` pairs where a KNOWN (declared) flag consumed
   * the following token as its value AND that value starts with "-" (length
   * > 1; the bare stdin sentinel "-" is a different, already-solved case, see
   * stdin.ts). citty's own parser (a vendored mri) refuses to bind such a
   * value through the space-separated form: mri only consumes the next token
   * when its first character is not "-" (see citty's `parseRawArgs`), so a
   * value that legitimately starts with "-" (an API key, "--limit -5", a
   * message beginning with a dash) is left unbound and re-parsed as its own
   * (bogus) flag. `mergeDashPrefixedValues` below uses these pairs to rewrite
   * the pair into the unambiguous inline `--flag=value` form before citty
   * ever sees it.
   */
  merges: Array<{ flagIndex: number; valueIndex: number }>;
}

/**
 * Walk `rawArgs` ONCE, classifying every token as the "--" end-of-flags
 * marker, a flag name (bare, inline `--flag=value`, or one that consumes the
 * FOLLOWING token as its value), or a positional. This is the single source
 * of truth for "which token is the subcommand keyword" (routing),
 * "which tokens are extra beyond a leaf's declared arity" (D4a), and "which
 * tokens are genuine flag-name occurrences to validate" (unknown-flag
 * detection) — the same shape of question three call sites used to answer
 * with three separately-drifting scans, none of which tracked a token already
 * consumed as a value, so each re-inspected it as if it were fresh input.
 *
 * Consumption rule for a `--flag` (or `-x`) with no inline `=value`:
 *   - a declared BOOLEAN (or its "no-"-negated form): consumes nothing.
 *   - a declared VALUE flag: consumes the very next token as its value
 *     UNCONDITIONALLY — including one that starts with "-" — unless that
 *     token is itself a declared flag name (so `--limit --json` still splits
 *     into two flags, and a value that happens to collide with a real flag
 *     name stays a separate flag, never silently swallowed) or is the "--"
 *     terminator. This is the fix: previously a dash-prefixed value was never
 *     consumed, so it fell through and was re-scanned as its own (usually
 *     unknown) flag.
 *   - an UNDECLARED (unknown) flag: this scan does not know its arity, so it
 *     keeps the pre-existing conservative default, consume the next token
 *     unless it looks like a flag. An unknown flag is rejected downstream
 *     regardless (`findUnknownFlag`); this only affects how its neighbour is
 *     classified while we don't yet know whether the flag itself survives.
 */
function walkTokens(
  rawArgs: string[],
  booleanFlags: Set<string>,
  declaredFlags: Set<string>,
): TokenWalk {
  const positionals: TokenWalk["positionals"] = [];
  const flags: TokenWalk["flags"] = [];
  const merges: TokenWalk["merges"] = [];
  let afterDoubleDash = false;

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]!;
    if (afterDoubleDash) {
      positionals.push({ token: arg, index: i });
      continue;
    }
    if (arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    const name = stripFlagName(arg);
    if (name === null) {
      positionals.push({ token: arg, index: i });
      continue;
    }
    flags.push({ token: arg, index: i, name });
    if (arg.replace(/^-+/, "").includes("=")) continue; // inline value, self-contained.

    const isBoolean =
      booleanFlags.has(name) || (name.startsWith("no-") && booleanFlags.has(name.slice(3)));
    if (isBoolean) continue;

    const next = rawArgs[i + 1];
    if (next === undefined || next === "--") continue;

    const isDeclared =
      declaredFlags.has(name) || (name.startsWith("no-") && declaredFlags.has(name.slice(3)));
    const nextIsDashValue = next.startsWith("-") && next !== "-";
    const consume = isDeclared
      ? !isDeclaredFlagToken(next, declaredFlags)
      : !nextIsDashValue; // unknown flag: legacy fallback, unchanged.

    if (consume) {
      if (isDeclared && nextIsDashValue) merges.push({ flagIndex: i, valueIndex: i + 1 });
      i++;
    }
  }

  return { positionals, flags, merges };
}

/**
 * `booleanFlagNames`/`declaredArgNames` augmented with the global flag set,
 * for the ROUTING scan only (see the constants above for why). Never used to
 * decide whether a flag is accepted, only to correctly delineate token
 * boundaries while searching for the next subcommand keyword or counting a
 * node's extra positionals.
 */
async function routingBooleanFlagNames(cmd: AnyCommand): Promise<Set<string>> {
  return new Set([...(await booleanFlagNames(cmd)), ...GLOBAL_BOOLEAN_FLAG_NAMES]);
}
async function routingDeclaredFlagNames(cmd: AnyCommand): Promise<Set<string>> {
  return new Set([...(await declaredArgNames(cmd)), ...GLOBAL_FLAG_NAMES]);
}

/**
 * Rewrite each `{flagIndex, valueIndex}` pair from a `TokenWalk` into the
 * single inline-value token `--flag=value` (or `-x=value`), the one form
 * citty's parser binds correctly regardless of what the value starts with
 * (see `TokenWalk.merges`'s doc comment). Every other token, including a
 * bare "-" (handled separately, see stdin.ts), passes through unchanged.
 */
function mergeDashPrefixedValues(
  rawArgs: string[],
  merges: TokenWalk["merges"],
): string[] {
  if (merges.length === 0) return rawArgs;
  const valueIndexOfFlag = new Map(merges.map((m) => [m.flagIndex, m.valueIndex]));
  const consumedValueIndices = new Set(merges.map((m) => m.valueIndex));
  const out: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    if (consumedValueIndices.has(i)) continue;
    const valueIndex = valueIndexOfFlag.get(i);
    out.push(valueIndex === undefined ? rawArgs[i]! : `${rawArgs[i]}=${rawArgs[valueIndex]}`);
  }
  return out;
}

/**
 * Whether a node declares at least one positional argument, i.e. it accepts a
 * bare intent-shaped form (e.g. `connect <slug>`, `profile <url>`,
 * `message <chat_id> "text"`). Pure groups (account, webhook, ...) declare none,
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

/** Names (and aliases) of a node's boolean flags, flags that take no value. */
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
 * Render a resolved command path as the invocation a caller would type.
 *
 * The walk seeds the path with the root node's own name, which is "curviate"
 * for the real tree and the group's name when a test drives `resolveLeaf`
 * from a subtree directly. Normalising here means one message shape works for
 * both, and the printed form is always something that can be pasted back into
 * a shell.
 */
function renderPath(path: string[]): string {
  const parts = path[0] === "curviate" ? path.slice(1) : path;
  return ["curviate", ...parts].join(" ");
}

/** "no positional arguments" / "1 positional argument" / "N positional arguments". */
function arityPhrase(count: number): string {
  if (count === 0) return "no positional arguments";
  if (count === 1) return "1 positional argument";
  return `${count} positional arguments`;
}

/**
 * The positional tokens `cmd` would NOT bind: everything beyond its declared
 * positional arity. citty swallows these into `args._`, which no handler
 * reads, so an unchecked extra is silently discarded and the command returns
 * something other than what was asked for.
 *
 * Delegates the token-boundary classification to `walkTokens` (the routing-
 * augmented sets, so a global flag's value is correctly skipped even here,
 * mirroring the routing scan in `resolveLeaf` below); only the accept/reject
 * decision for a flag NAME stays leaf-precise, and that decision is not this
 * function's job.
 */
async function extraPositionals(
  cmd: AnyCommand,
  rawArgs: string[],
): Promise<Array<{ token: string; index: number }>> {
  const booleanFlags = await routingBooleanFlagNames(cmd);
  const declaredFlags = await routingDeclaredFlagNames(cmd);
  const { positionals } = walkTokens(rawArgs, booleanFlags, declaredFlags);
  const declaredCount = await nodePositionalCount(cmd);
  return positionals.slice(declaredCount);
}

/**
 * Reject any positional the RESOLVED LEAF will not consume.
 *
 * This is the class-wide guard. The group-with-bare-positional branch below
 * has its own richer check because it can still reroute an id-first form; this
 * one runs on the node that is actually about to execute, so it holds no
 * matter how that node was reached: root-level leaf, subcommand descent at any
 * depth, or an id-first reroute that landed on a leaf of lower arity than the
 * group it came from. Placing it at the single point where every path
 * converges is deliberate: the two previous fixes for this class each guarded
 * one route, and the class came back through another.
 *
 * When the unconsumed token names a sibling of the resolved leaf, the caller
 * almost certainly meant that sibling (`profile me relations` for `profile
 * relations`), so the diagnostic names it. The token is never rerouted there
 * automatically: `endorse`, `follow`, and `save-candidate` are siblings too,
 * and reinterpreting a stray token as one of those would turn a typo into a
 * write. Naming the correct form costs the caller one edit and can do no harm.
 */
async function assertLeafConsumesPositionals(
  leaf: AnyCommand,
  leafArgs: string[],
  path: string[],
  siblings: Record<string, unknown> | undefined,
): Promise<void> {
  const extras = await extraPositionals(leaf, leafArgs);
  if (extras.length === 0) return;

  const token = extras[0]!.token;
  const form = renderPath(path);
  const arity = arityPhrase(await nodePositionalCount(leaf));

  const hint =
    siblings && Object.prototype.hasOwnProperty.call(siblings, token)
      ? `Did you mean \`${renderPath([...path.slice(0, -1), token])}\`?`
      : undefined;

  usageError(
    `unexpected argument \`${token}\` after \`${form}\`. ` +
      `\`${form}\` takes ${arity}. ` +
      `Run \`${form} --help\` for its usage.`,
    hint,
  );
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
 *
 * Reads a pre-computed `TokenWalk.flags` list (leaf-precise sets, no global
 * union, see the constants above) rather than re-scanning `rawArgs` itself:
 * every entry there is already a genuine flag-NAME occurrence, a token
 * consumed as a KNOWN flag's value (dash-prefixed or not) never reaches this
 * list, so it can never be mistaken for a flag of its own. That is the actual
 * fix for a value like `--api-key -something`: the old version scanned every
 * dash-led token unconditionally and had no notion of "already spoken for".
 */
function findUnknownFlag(flags: TokenWalk["flags"], declared: Set<string>): string | null {
  for (const { token, name } of flags) {
    // Match the full declared name FIRST, a flag may be literally declared
    // with a "no-" prefix (e.g. "no-interactive"), and that declaration must
    // win. Only fall back to stripping "no-" for citty's implicit negation
    // (e.g. "--no-json" negating a declared "json") when the full name isn't
    // itself declared.
    if (declared.has(name)) continue;
    if (name.startsWith("no-") && declared.has(name.slice(3))) continue;
    return token;
  }
  return null;
}

/** Whether `--fields ""` (empty projection) was passed, a usage error. */
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
 * Where a descent currently is: the command path resolved so far (for the
 * diagnostic) and the registry the current node was looked up in (so an
 * unconsumed token that names a sibling can be pointed at).
 */
interface Descent {
  path: string[];
  siblings?: Record<string, unknown>;
}

/**
 * Resolve a node + remaining args down to the single command to execute,
 * descending through matching subcommand keywords. Returns the leaf to run and
 * the rawArgs that belong to it. On an unrecognized token under a pure group
 * (no bare `run`), emits a usage error and exits 2.
 *
 * Every path that ends at an executable node runs
 * `assertLeafConsumesPositionals` first, so a token the resolved command
 * cannot bind is a usage error rather than a silent discard.
 */
export async function resolveLeaf(
  cmd: AnyCommand,
  rawArgs: string[],
  descent?: Descent,
): Promise<{ leaf: AnyCommand; leafArgs: string[] }> {
  const here: Descent = descent ?? { path: [await nodeName(cmd)] };
  const subCommands = (await resolveValue(cmd.subCommands)) as
    | Record<string, unknown>
    | undefined;

  if (subCommands && Object.keys(subCommands).length > 0) {
    // Routing-augmented sets: a global flag (--api-key, --json, ...) must be
    // recognised and its value skipped here even though a pure group like
    // `account` or the root `main` declares no args of its own (see the
    // GLOBAL_FLAG_NAMES/GLOBAL_BOOLEAN_FLAG_NAMES comment above). Without
    // this, `curviate --api-key <key> account list` misreads the key's VALUE
    // as the first positional and never finds `account` at all.
    const booleanFlags = await routingBooleanFlagNames(cmd);
    const declaredFlags = await routingDeclaredFlagNames(cmd);
    const { positionals } = walkTokens(rawArgs, booleanFlags, declaredFlags);
    const idx = positionals.length > 0 ? positionals[0]!.index : -1;
    const token = idx === -1 ? undefined : rawArgs[idx];
    const hasBarePositional = await nodeHasPositional(cmd);

    if (token !== undefined && subCommands[token]) {
      // Token is a known subcommand keyword -> descend into it ONLY. Drop
      // JUST the matched keyword token, not everything before it: idx is no
      // longer always 0 now that the scan above can skip a leading global
      // flag (and its value) to find the keyword, so a flag preceding the
      // keyword (`curviate --api-key X account list`) must survive into the
      // descended rawArgs the same way `--api-key X` already does when it
      // follows the keyword, or the value is silently dropped on the floor
      // and whatever profile/env fallback exists underneath it answers
      // instead, an even quieter failure than the routing error this fixes.
      const sub = (await resolveValue(subCommands[token])) as AnyCommand;
      const remaining = [...rawArgs.slice(0, idx), ...rawArgs.slice(idx + 1)];
      return resolveLeaf(sub, remaining, {
        path: [...here.path, token],
        siblings: subCommands,
      });
    }

    // Removed/renamed command -> point at the successor BEFORE the token is
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
      // `args._`, the D4a silent-wrong-data class (e.g. `company <id> employees`
      // returning the base company profile, ignoring `employees`). Reroute an
      // id-first ergonomic form, or fail loudly, never silently ignore.
      const extras = await extraPositionals(cmd, rawArgs);
      if (extras.length > 0) {
        const first = extras[0]!;
        // Exactly one extra positional that names a subcommand -> the id-first
        // form `<group> <id> <sub>`, equivalent to `<group> <sub> <id>`. Drop
        // only that token and descend into the subcommand with the remaining
        // args (the id positional + any flags, which the subcommand re-parses).
        if (
          extras.length === 1 &&
          Object.prototype.hasOwnProperty.call(subCommands, first.token)
        ) {
          const sub = (await resolveValue(subCommands[first.token])) as AnyCommand;
          const remaining = rawArgs.filter((_, i) => i !== first.index);
          return resolveLeaf(sub, remaining, {
            path: [...here.path, first.token],
            siblings: subCommands,
          });
        }
        // Otherwise it cannot be a valid reroute -> actionable usage error, never
        // a silent swallow of the extra token.
        const name = await nodeName(cmd);
        usageError(
          `unexpected argument \`${first.token}\` after \`${name}\`. ` +
            `It is neither a positional \`${name}\` accepts nor one of its subcommands. ` +
            `Run \`curviate ${name} --help\` for the available subcommands.`,
        );
      }
      // No keyword match but the node accepts a bare positional -> run it.
      return { leaf: cmd, leafArgs: rawArgs };
    }

    // No bare-positional intent. A token here is an unknown subcommand keyword.
    if (token !== undefined) {
      usageError(`unknown command \`${token}\``);
    }
    // No token at all -> no subcommand specified. Run the node's handler (group
    // nodes print their usage block; the root's no-op falls through to help).
    // There is no positional here by definition, so nothing to reject.
    return { leaf: cmd, leafArgs: rawArgs };
  }

  // Leaf node (no subcommands) — the convergence point of every reach path
  // that is not the bare form guarded above.
  await assertLeafConsumesPositionals(cmd, rawArgs, here.path, here.siblings);
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
    // Leaf-precise sets (no global union, see the constants above): whether a
    // flag is ALLOWED on this specific leaf must not loosen just because it
    // happens to be a global flag elsewhere in the tree.
    const booleanFlags = await booleanFlagNames(leaf);
    const declared = await declaredArgNames(leaf);
    const walk = walkTokens(leafArgs, booleanFlags, declared);
    const unknown = findUnknownFlag(walk.flags, declared);
    if (unknown !== null) {
      usageError(`unknown flag \`${unknown}\`.`);
    }

    // Rewrite `--flag -value` pairs the SAME walk already proved are a known
    // flag consuming a dash-prefixed value into the inline `--flag=-value`
    // form citty's parser binds unambiguously (see mergeDashPrefixedValues's
    // doc comment). Must run BEFORE the stdin-sentinel substitution below:
    // it only ever touches a value of length > 1 that starts with "-", so it
    // can never touch the bare "-" sentinel case, and doing it first keeps
    // that substitution's own indices meaningful (a straight per-token map).
    const mergedLeafArgs = mergeDashPrefixedValues(leafArgs, walk.merges);

    // Pre-process: replace bare "-" with the stdin sentinel before handing to
    // citty/mri. mri's embedded parser (j-dash-count loop) silently swallows "-"
    //, one leading dash gives j=1 -> flag branch -> empty name -> 0-char iteration
    // -> never lands in `_[]` -> citty cannot bind it to a positional. The sentinel
    // starts with "_" (no leading dash) so mri treats it as a plain positional;
    // resolveTextOrStdin then recognises both "-" and the sentinel.
    const processedLeafArgs = mergedLeafArgs.map((a) => (a === "-" ? STDIN_SENTINEL : a));

    // Post-process, symmetrically: the substitution above is indiscriminate, so
    // undo it for every argument that did not opt into the stdin contract. The
    // sentinel then exists only where a handler is going to resolve it, and a
    // bare "-" keeps its ordinary literal meaning everywhere else. Done here,
    // between citty's parser and the handler, because that is the one point
    // where the parsed values and their declarations are both in hand.
    const leafArgsDef = (await resolveValue(leaf.args ?? {})) as Record<
      string,
      RestorableArgDef
    >;
    const originalRun = leaf.run;

    // Execute the resolved leaf with subCommands stripped so citty does not
    // re-trigger its buggy descent (misroute / double-run).
    const leafToRun: AnyCommand = {
      ...leaf,
      subCommands: undefined,
      ...(originalRun
        ? {
            run: (ctx: Parameters<NonNullable<AnyCommand["run"]>>[0]) => {
              restoreLiteralDashes(
                ctx.args as unknown as Record<string, unknown>,
                leafArgsDef,
              );
              return originalRun(ctx);
            },
          }
        : {}),
    };
    await runCommand(leafToRun, { rawArgs: processedLeafArgs });
  } catch (err: unknown) {
    // citty raises a CLIError with code "EARG" for a missing required argument
    // or positional, that is a usage error -> exit 2. Anything else thrown here
    // is genuinely unexpected (handlers exit on their own error paths) -> exit 1.
    // Either way, write a plain diagnostic without the framework's usage bleed;
    // routing errors already exited 2 above.
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string } | null)?.code;
    process.stderr.write(`error: ${message}\n`);
    process.exit(code === "EARG" ? 2 : 1);
  }
}
