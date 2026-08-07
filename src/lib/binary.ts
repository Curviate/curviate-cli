/**
 * Binary return handling.
 *
 * Commands that return binary data (`message attachment`, `recruiter applicant resume`)
 * write bytes to `-o <file>` or, when stdout is not a TTY, to stdout raw.
 * If stdout IS a TTY and no `-o` is given, the CLI refuses with exit 2.
 *
 * Binary content is:
 *   - Never JSON-wrapped
 *   - Never logged
 *   - Never retained beyond the write
 */

import { writeFile } from "node:fs/promises";

/** Usage error that the run-loop maps to exit 2. */
export class BinaryOutputError extends Error {
  readonly exitCode = 2;
  constructor(message: string) {
    super(message);
    this.name = "BinaryOutputError";
  }
}

export interface BinaryOutputOptions {
  /** Path to write the file to (`-o <file>`). */
  outputPath?: string;
  /** Whether stdout is a TTY. */
  isTTY: boolean;
  /** Raw stdout stream for piped output. */
  stdout: NodeJS.WritableStream;
}

/**
 * Write binary data to either a file (`-o <file>`) or stdout (when piped).
 * Refuses with exit 2 if stdout is a TTY and no `-o` is given.
 */
export async function writeBinaryOutput(
  data: ArrayBuffer | Buffer,
  opts: BinaryOutputOptions,
): Promise<void> {
  const buf = data instanceof Buffer ? data : Buffer.from(new Uint8Array(data));

  if (opts.outputPath) {
    await writeFile(opts.outputPath, buf);
    return;
  }

  if (opts.isTTY) {
    throw new BinaryOutputError(
      "Binary output: pass -o <file> to save it, or redirect stdout to a file/pipe.",
    );
  }

  // Non-TTY stdout: write raw bytes.
  await new Promise<void>((resolve, reject) => {
    opts.stdout.write(buf, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
