/**
 * Stdin reading utility for CLI commands.
 *
 * Used when the TEXT positional is exactly "-": reads all of stdin until EOF,
 * strips trailing newlines, and returns the result. Empty input exits 2.
 *
 * WHY THE SENTINEL EXISTS:
 * mri (citty's embedded arg parser) silently swallows a bare "-" token, it
 * counts one leading dash (j=1), enters the flag-handling branch, derives an
 * empty flag name, and iterates 0 times, so "-" never lands in `_[]`. citty
 * therefore cannot bind it to a positional argument.
 *
 * dispatch.ts replaces any bare "-" in leafArgs with STDIN_SENTINEL before
 * calling `runCommand` so mri sees a plain positional (no leading dash) and
 * binds it correctly. resolveTextOrStdin then recognises both "-" (for unit
 * tests that inject the value directly) and STDIN_SENTINEL (for the real bin).
 */

/**
 * Internal sentinel substituted for "-" by dispatch.ts before citty/mri parses
 * argv. Must not start with "-" (mri would treat it as a flag), must be
 * impossible to type from a shell without quoting (underscore prefix + suffix),
 * and must be stable across builds (it appears in the argv preprocessing path,
 * not in any persisted data).
 */
export const STDIN_SENTINEL = "__curviate_stdin__";

/**
 * Read all bytes from stdin until EOF, strip trailing newlines, and return
 * the result as a UTF-8 string. Internal newlines are preserved.
 *
 * In tests, inject a mock reader instead of calling this directly so tests
 * remain hermetic (the real stdin blocks on a TTY).
 */
export async function defaultReadStdin(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    });
    process.stdin.on("end", () => {
      const full = Buffer.concat(chunks).toString("utf8");
      // Strip trailing newlines only, internal newlines are preserved.
      resolve(full.replace(/\n+$/, ""));
    });
    process.stdin.on("error", reject);
  });
}

/**
 * Does this argument value mean "read from stdin"?
 *
 * The single place in the CLI that answers that question. Two spellings reach
 * a consuming site: the literal "-" (unit tests that inject a value directly)
 * and STDIN_SENTINEL (every real invocation, because dispatch.ts substitutes it
 * before citty/mri can swallow the dash).
 *
 * Every argument documented as accepting "-" MUST route through this predicate,
 * or through `resolveTextOrStdin` below. A site that tests `value === "-"`
 * itself is dead code in the built binary: the sentinel arrives instead, the
 * branch is never taken, and the sentinel is consumed as if the user had typed
 * it. That is how `login --api-key -` came to write the sentinel into the
 * config file as an API key, report success, and leave every later command
 * blaming the user's credentials.
 */
export function isStdinToken(value: unknown): boolean {
  return value === "-" || value === STDIN_SENTINEL;
}

/**
 * The marker an argument definition carries to opt into the `-`-means-stdin
 * contract. Declared next to the argument rather than in a central list, so a
 * new argument opts in where it is defined and everything else is contained by
 * default.
 */
export interface StdinArgMarker {
  /** Set on an argument whose value may be a bare `-` meaning "read stdin". */
  stdinArg?: boolean;
}

/** The shape `restoreLiteralDashes` needs from a citty argument definition. */
export interface RestorableArgDef extends StdinArgMarker {
  type?: string;
  alias?: string | string[];
}

/** Does this argument definition opt into reading its value from stdin? */
export function declaresStdinArg(def: RestorableArgDef | undefined): boolean {
  return def?.stdinArg === true;
}

/**
 * Put back what the dispatcher rewrote.
 *
 * The dash substitution is a parser workaround, and it is indiscriminate: every
 * bare `-` in the leaf argument list becomes the sentinel, whether or not the
 * argument it binds to has anything to do with stdin. Left alone, an argument
 * that never advertised the contract receives the sentinel as if the user had
 * typed it, and then persists or transmits it. That is how `--password -`
 * came to send the sentinel as a LinkedIn password: exit 0, success-shaped, and
 * the fault deferred to whoever reads the resulting login failure.
 *
 * So the substitution is made symmetric. An argument that declares the contract
 * keeps the sentinel, because its handler resolves it through the resolver
 * above. Every other argument gets a literal `-` back, so a dash keeps its
 * ordinary meaning everywhere it is not special. This is a rule over the parsed
 * argument set, not a list of known sites: an argument added tomorrow is
 * contained without anyone remembering it exists.
 *
 * Mutates `args` in place, because that object is the handler's context.
 */
export function restoreLiteralDashes(
  args: Record<string, unknown>,
  argsDef: Record<string, RestorableArgDef>,
): void {
  const declaring = new Set<string>();
  const positionalNames: string[] = [];

  for (const [name, def] of Object.entries(argsDef)) {
    if (def?.type === "positional") positionalNames.push(name);
    if (!declaresStdinArg(def)) continue;
    declaring.add(name);
    const alias = def.alias;
    if (typeof alias === "string") declaring.add(alias);
    else if (Array.isArray(alias)) for (const a of alias) declaring.add(a);
  }

  const put = (value: unknown): unknown => {
    if (value === STDIN_SENTINEL) return "-";
    if (Array.isArray(value)) return value.map((e) => (e === STDIN_SENTINEL ? "-" : e));
    return value;
  };

  for (const key of Object.keys(args)) {
    if (key === "_" || declaring.has(key)) continue;
    args[key] = put(args[key]);
  }

  // Positionals also land in `_`, in declaration order.
  const rest = args["_"];
  if (Array.isArray(rest)) {
    for (let i = 0; i < rest.length; i++) {
      const name = positionalNames[i];
      if (name !== undefined && declaring.has(name)) continue;
      if (rest[i] === STDIN_SENTINEL) rest[i] = "-";
    }
  }
}

/**
 * The backstop: refuse to let the internal placeholder leave the process.
 *
 * `restoreLiteralDashes` is the mechanism; this is the proof that the mechanism
 * held. Anything that carries the placeholder into an outbound request or a
 * file on disk got there through a path nobody has thought about, which is
 * exactly the case that cost a user their LinkedIn password field the first
 * time. Fail loudly at the boundary instead of transmitting it.
 *
 * Exits rather than throwing on purpose. The SDK converts a thrown transport
 * error into a generic "Network error." and retries reads, which would bury the
 * real cause under the same kind of misattributed diagnostic this whole
 * mechanism exists to prevent.
 */
export function assertNoStdinPlaceholder(
  where: string,
  values: Array<string | undefined>,
): void {
  if (!values.some((v) => typeof v === "string" && v.includes(STDIN_SENTINEL))) return;

  process.stderr.write(
    `error: refusing to continue. ${where} contains "${STDIN_SENTINEL}", ` +
      `the internal placeholder the CLI substitutes for a bare "-" while it parses arguments.\n`,
  );
  process.stderr.write(
    `hint: that placeholder means "read this value from stdin" and must never leave the process. ` +
      `Check the value you supplied, including environment variables such as CURVIATE_ACCOUNT and ` +
      `CURVIATE_API_KEY. If you did not supply it yourself, this is a bug in the CLI. ` +
      `Nothing was sent or written.\n`,
  );
  process.exit(1);
}

/**
 * Resolve an argument that may mean "read from stdin": if it does, call the
 * injected stdin reader (or `defaultReadStdin`). Exits 2 with
 * "stdin: empty input" when stdin is empty.
 *
 * @param rawText   The raw value from the argument.
 * @param out       Receives the error message (stderr.write equivalent).
 * @param readStdin Optional injected stdin reader (for tests).
 */
export async function resolveTextOrStdin(
  rawText: string,
  out: { stderr: { write: (s: string) => void } },
  readStdin?: () => Promise<string>,
): Promise<string> {
  if (!isStdinToken(rawText)) return rawText;
  const reader = readStdin ?? defaultReadStdin;
  const text = await reader();
  if (!text) {
    out.stderr.write("error: stdin: empty input\n");
    process.exit(2);
  }
  return text;
}
