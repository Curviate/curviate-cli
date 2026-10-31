import { closeSync, openSync, renameSync, unlinkSync, writeSync, fchmodSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Write `bytes` to `path` the way an export must be: a 0600 temp file in the same directory, renamed over the target on success. */
export function writeAtomic(path: string, bytes: Buffer): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    fchmodSync(fd, 0o600);
    writeSync(fd, bytes);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {
      /* no temp file to remove */
    }
    throw err;
  }
}
