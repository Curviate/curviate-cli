/**
 * `--beta`, the per-invocation beta-consent override.
 *
 * Beta operations can be gated: the API refuses them `403 BETA_NOT_ENABLED`
 * (exit 5) until the workspace opts into beta. Consent itself is a WORKSPACE
 * setting, owned by the dashboard and the REST tenant route, and this flag is
 * deliberately not a way to set it: `--beta` overrides the answer for ONE
 * invocation and persists nothing. There is no `curviate config set beta`, no
 * profile field and no env var, because a durable consent written by a CLI
 * flag is exactly the state a human is supposed to own.
 *
 * The override works in BOTH directions, which is why the flag takes a value
 * at all. `--beta=false` on a workspace that HAS consented turns beta off for
 * that one call, which is how a script proves it does not depend on a gated
 * operation without a human toggling the workspace setting and back.
 *
 * ## Why the dispatcher consumes the token instead of citty parsing it
 *
 * citty 0.1.6 cannot express this flag. Declared `type: "boolean"`, its parser
 * (mri) reads `--beta` and `--beta=true` as `true`, `--beta=false` as `false`,
 * and then SILENTLY reads `--beta=maybe` as `true` while pushing `"maybe"`
 * into the positionals — so an invalid value becomes an accidental opt-IN plus
 * a stray positional, which is the worst available outcome for a flag whose
 * whole job is to say yes or no on purpose. Measured, not assumed; the same
 * happens for `--beta=1` and `--beta=0`.
 *
 * So the token never reaches citty: `parseBetaFlag` validates it against the
 * grammar the API's own header accepts, strips it from the arguments, and the
 * dispatcher turns a bad value into an ordinary usage error (exit 2). The flag
 * is still DECLARED in `GLOBAL_FLAGS` so `--help` renders it and the routing
 * scan recognises it.
 *
 * The accepted values mirror the server's header grammar rather than being
 * narrower, so `--beta=yes` means over the CLI exactly what it means over
 * REST. The wire value is normalised to `true` / `false`.
 */

/** The per-request override header. Spelled once. */
export const BETA_CONSENT_HEADER = "X-Curviate-Beta";

const TRUE_TOKENS = new Set(["true", "1", "on", "yes"]);
const FALSE_TOKENS = new Set(["false", "0", "off", "no"]);

/** Human-readable accepted grammar, matching the API's own error message. */
export const BETA_ACCEPTED_VALUES =
  "true|false, 1|0, on|off, yes|no (case-insensitive)";

export type BetaFlagParse =
  | {
      ok: true;
      /** `undefined` when the flag was absent: send no header at all. */
      value: boolean | undefined;
      /** `rawArgs` with every `--beta` / `--no-beta` token removed. */
      rest: string[];
    }
  | { ok: false; error: string };

/**
 * Read and strip the beta flag from raw arguments.
 *
 * Recognises `--beta`, `--beta=<value>` and `--no-beta`. A repeated flag is
 * last-wins, matching how every other flag behaves under mri. `--no-beta` with
 * a value is a usage error rather than a guess.
 *
 * KNOWN EDGE, deliberately left: `--user-agent --beta` used to bind the literal
 * string `--beta` as `--user-agent`'s value, because `--beta` was not a declared
 * flag. Now the token is stripped first, so `--user-agent` is left without a
 * value and the override is set. Every already-declared global flag behaves the
 * same way (the argument walker refuses to bind any declared flag name as a
 * value), so this is the existing convention rather than a new trap; pass
 * `--user-agent=--beta` to mean the literal.
 *
 * `--beta <value>` (space-separated) is deliberately NOT recognised: the flag
 * is optional-valued, so a following token is ambiguous between its value and
 * the command's own positional, and `curviate --beta sales-nav search people`
 * must keep routing to `sales-nav`. `=` is the only way to pass a value, which
 * is also the only form GNU-style optional-valued flags accept.
 */
export function parseBetaFlag(rawArgs: string[]): BetaFlagParse {
  let value: boolean | undefined;
  const rest: string[] = [];
  let endOfFlags = false;

  for (const arg of rawArgs) {
    // Everything after a bare `--` is positional data, never a flag. A message
    // body that happens to read `--beta=maybe` is text, not a usage error.
    if (endOfFlags) {
      rest.push(arg);
      continue;
    }
    if (arg === "--") {
      endOfFlags = true;
      rest.push(arg);
      continue;
    }
    if (arg === "--beta") {
      value = true;
      continue;
    }
    if (arg === "--no-beta") {
      value = false;
      continue;
    }
    if (arg.startsWith("--no-beta=")) {
      // `--no-beta` is already a negation, so a value on it is contradictory at
      // best (`--no-beta=false`) and meaningless at worst. It used to fall
      // through to `rest`, where the argument parser accepted it as the
      // negation of the declared `beta` flag and nothing read the result: the
      // caller's explicit "beta off" was discarded with no error and no header.
      // That is the same silent-wrong-answer class the header comment warns
      // about, so it refuses instead.
      return {
        ok: false,
        error: `--no-beta takes no value. Use --no-beta, or --beta=${BETA_ACCEPTED_VALUES.split(",")[0]!.split("|")[1]!}.`,
      };
    }
    if (arg.startsWith("--beta=")) {
      const raw = arg.slice("--beta=".length).trim().toLowerCase();
      if (TRUE_TOKENS.has(raw)) {
        value = true;
        continue;
      }
      if (FALSE_TOKENS.has(raw)) {
        value = false;
        continue;
      }
      // An empty value (`--beta=`) lands here too, and should: it is a typo,
      // not an opt-in, and guessing either way is how a flag that means
      // "consent" ends up consenting by accident.
      return {
        ok: false,
        error: `--beta must be one of ${BETA_ACCEPTED_VALUES}. Got "${arg.slice("--beta=".length)}".`,
      };
    }
    rest.push(arg);
  }

  return { ok: true, value, rest };
}

/**
 * Process-wide override for this invocation.
 *
 * Module state rather than a field threaded through `ClientConfig`, and that is
 * a considered choice rather than a shortcut: the value is genuinely
 * process-global (one CLI invocation carries exactly one `--beta`), it is set
 * once by the dispatcher before any command runs, and `createClient` is called
 * from over a hundred sites that would otherwise each have to forward a
 * parameter none of them has an opinion about. Threading it would put the same
 * constant in 100+ places and make forgetting one a silent wrong answer.
 */
let override: boolean | undefined;

/** Set by the dispatcher, once, from the parsed flag. */
export function setBetaOverride(value: boolean | undefined): void {
  override = value;
}

/** Exposed for tests, which must not leak state between cases. */
export function resetBetaOverride(): void {
  override = undefined;
}

/**
 * The header to merge into an outgoing request: an empty object when the flag
 * was absent, so an invocation without `--beta` sends no header and the
 * workspace setting decides, exactly as it did before this flag existed.
 */
export function betaOverrideHeader(): Record<string, string> {
  if (override === undefined) return {};
  return { [BETA_CONSENT_HEADER]: override ? "true" : "false" };
}
