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
  const total = Math.ceil(ids.length / size);
  const done: R[] = [];
  for (let k = 0; k < total; k++) {
    const chunk = ids.slice(k * size, (k + 1) * size);
    try {
      done.push(await send(chunk));
    } catch (err) {
      const { CurviateError } = await import("@curviate/sdk");
      const progress = {
        chunks: { sent: k, total },
        items: { accepted: k * size, total: ids.length },
        failed_chunk: { index: k + 1, first_row: k * size + 1, last_row: k * size + chunk.length },
      };
      if (!(err instanceof CurviateError)) {
        process.stderr.write(`Chunk ${k + 1} of ${total} failed; ${k * size} of ${ids.length} ids were sent before it. Nothing after it was sent.\n`);
        return fail(err, f);
      }
      const { getExitCode } = await import("./exit-codes.js");
      const e = (err as CurviateError).toJSON();
      if (outputOpts(f).json) process.stdout.write(JSON.stringify({ error: e, progress }) + "\n");
      process.stderr.write(
        `error [${e.code}] ${e.message}\n` +
          `Chunk ${k + 1} of ${total} failed (ids ${progress.failed_chunk.first_row} to ${progress.failed_chunk.last_row}); ` +
          `${progress.items.accepted} of ${ids.length} ids were sent before it. Nothing after it was sent.\n`,
      );
      process.exit(getExitCode(err as CurviateError));
    }
  }
  return done;
}
