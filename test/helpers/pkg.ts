import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The package root (test/helpers/ is two levels below it). */
export const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
