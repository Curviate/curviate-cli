/**
 * Stdin reading utility for CLI commands.
 *
 * Used when the TEXT positional is exactly "-": reads all of stdin until EOF,
 * strips trailing newlines, and returns the result. Empty input exits 2.
 *
 * WHY THE SENTINEL EXISTS:
 * mri (citty's embedded arg parser) silently swallows a bare "-" token — it
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
      // Strip trailing newlines only — internal newlines are preserved.
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
