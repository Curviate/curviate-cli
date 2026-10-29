/**
 * Id batches: one request per chunk of the operation's
 * `x-curviate-limits.items`, sequential, in input order. On a failed chunk the
 * CLI stops: no later chunk, no automatic retry (clients own retry safety).
 * The failure carries what was done, so a caller resumes from the failed
 * chunk: in JSON mode stdout is one document, `{error, progress}`; in human
 * mode the summary goes to stderr. The exit is the failing request's.
 * `progress.chunks.sent` counts the chunks accepted before the failed one (the
 * failed request went out too, and is `failed_chunk`); `items.accepted` is
 * their ids.
 */
import type { CurviateError } from "@curviate/sdk";
import { fail, outputOpts, type RootFlags } from "./root-command.js";

export async function sendInChunks<R>(ids: string[], size: number, send: (chunk: string[]) => Promise<R>, f: RootFlags): Promise<R[]> {
  const chunks: string[][] = [];
  for (let k = 0; k < ids.length; k += size) chunks.push(ids.slice(k, k + size));
  return sendChunked(chunks, send, f, "ids");
}

/** The same, for chunks already cut (an import's rows split by row count and body bytes): `unit` names what the chunks hold. */
export async function sendChunked<T, R>(chunks: T[][], send: (chunk: T[]) => Promise<R>, f: RootFlags, unit: "ids" | "rows"): Promise<R[]> {
  const total = chunks.length;
  const all = chunks.reduce((n, c) => n + c.length, 0);
  const done: R[] = [];
  let accepted = 0;
  for (let k = 0; k < total; k++) {
    const chunk = chunks[k]!;
    try {
      done.push(await send(chunk));
      accepted += chunk.length;
    } catch (err) {
      const { CurviateError } = await import("@curviate/sdk");
      const progress = {
        chunks: { sent: k, total },
        items: { accepted, total: all },
        failed_chunk: { index: k + 1, first_row: accepted + 1, last_row: accepted + chunk.length },
      };
      if (!(err instanceof CurviateError)) {
        process.stderr.write(`Chunk ${k + 1} of ${total} failed; ${accepted} of ${all} ${unit} were sent before it. Nothing after it was sent.\n`);
        return fail(err, f);
      }
      const { getExitCode } = await import("./exit-codes.js");
      const e = (err as CurviateError).toJSON();
      if (outputOpts(f).json) process.stdout.write(JSON.stringify({ error: e, progress }) + "\n");
      process.stderr.write(
        `error [${e.code}] ${e.message}\n` +
          `Chunk ${k + 1} of ${total} failed (${unit} ${progress.failed_chunk.first_row} to ${progress.failed_chunk.last_row}); ` +
          `${accepted} of ${all} ${unit} were sent before it. Nothing after it was sent.\n`,
      );
      process.exit(getExitCode(err as CurviateError));
    }
  }
  return done;
}
