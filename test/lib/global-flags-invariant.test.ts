/**
 * The narrowed global-flag sets must not drop a flag that is global.
 *
 * `WRITE_FLAGS`, `READ_SINGLE_FLAGS` and `WRITE_SINGLE_FLAGS` exist to hide
 * flags that are MEANINGLESS on a given command shape (`--cursor` on a
 * mutation, `--limit` on a one-row read). They do that by hand-listing keys,
 * which makes them silently lossy in the other direction: a flag that applies
 * to every command has to be remembered in three more places, and forgetting
 * one produces a flag that works on some commands and is an "unknown flag"
 * usage error on others, for no reason a caller can infer.
 *
 * `--beta` arrived and was initially missing from all three, which is what
 * this file exists to stop repeating. It is not about pagination flags: those
 * are DELIBERATELY absent and are asserted absent below, so this guard cannot
 * be satisfied by simply spreading GLOBAL_FLAGS everywhere.
 */
import { describe, expect, it } from "vitest";
import {
  GLOBAL_FLAGS,
  WRITE_FLAGS,
  READ_SINGLE_FLAGS,
  WRITE_SINGLE_FLAGS,
} from "../../src/lib/global-flags.js";

/**
 * Flags every command must accept regardless of shape: authentication,
 * transport, output mode, and the per-call beta override. None of these has
 * anything to do with whether a response is a list or a single row.
 */
const UNIVERSAL = [
  "api-key",
  "profile",
  "base-url",
  "timeout",
  "json",
  "verbose",
  "preview",
  "beta",
] as const;

/** Deliberately absent from a mutation's help: they describe reading a list. */
const PAGINATION = ["limit", "cursor", "all", "max-pages", "page-delay"] as const;

const VARIANTS: Array<[string, Record<string, unknown>]> = [
  ["WRITE_FLAGS", WRITE_FLAGS],
  ["READ_SINGLE_FLAGS", READ_SINGLE_FLAGS],
  ["WRITE_SINGLE_FLAGS", WRITE_SINGLE_FLAGS],
];

describe("narrowed global-flag sets keep every universal flag", () => {
  it.each(VARIANTS)("%s declares all of them", (_name, variant) => {
    const missing = UNIVERSAL.filter((f) => !Object.prototype.hasOwnProperty.call(variant, f));
    expect(
      missing,
      "these flags apply to every command, so a variant that omits one makes " +
        "it an unknown-flag usage error on that command shape alone",
    ).toEqual([]);
  });

  it.each(VARIANTS)("%s still omits the pagination flags", (_name, variant) => {
    // The other half of the invariant. Without this, the guard above could be
    // satisfied by making every variant a copy of GLOBAL_FLAGS, which would
    // put `--cursor` in a mutation's help and defeat the whole point.
    const leaked = PAGINATION.filter((f) => Object.prototype.hasOwnProperty.call(variant, f));
    expect(leaked).toEqual([]);
  });

  it("every universal flag really is declared in GLOBAL_FLAGS", () => {
    // POSITIVE CONTROL: the list above is checked against the source of truth,
    // so a typo'd name ("beeta") cannot make the assertions vacuous by being
    // absent from everything including GLOBAL_FLAGS itself.
    const unknown = UNIVERSAL.filter(
      (f) => !Object.prototype.hasOwnProperty.call(GLOBAL_FLAGS, f),
    );
    expect(unknown).toEqual([]);
    expect(UNIVERSAL.length).toBeGreaterThan(5);
  });
});
