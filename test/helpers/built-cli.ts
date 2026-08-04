/**
 * Shared helper for tests that must exercise the BUILT bin (`dist/cli.js`)
 * rather than an imported handler.
 *
 * ## Why a freshness check, not `existsSync`
 *
 * The older bin tests build only when `dist/cli.js` is absent. That is fine for
 * a test whose subject never changes, and actively misleading for a regression
 * test: after editing `src/`, a stale `dist/` makes the run report on the old
 * build. A red-then-green cycle then proves nothing — the "green" is the same
 * artifact as the "red".
 *
 * So: rebuild whenever any file under `src/` is newer than `dist/cli.js`.
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** test/helpers/ -> two levels up is the package root. */
export const pkgRoot = resolve(__dirname, "../..");
export const cliPath = resolve(pkgRoot, "dist", "cli.js");

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const mtime = entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

/**
 * Build `dist/cli.js` if it is missing or older than the newest source file,
 * and return its absolute path.
 */
export function ensureFreshBuild(): string {
  const srcNewest = newestMtime(resolve(pkgRoot, "src"));
  const distMtime = existsSync(cliPath) ? statSync(cliPath).mtimeMs : 0;
  if (distMtime < srcNewest) {
    execSync("node_modules/.bin/tsup", { cwd: pkgRoot, stdio: "ignore" });
  }
  return cliPath;
}
