import { it, expect } from "vitest";
import { redactKeyForDisplay } from "../../src/lib/config-display.js";

// The end-to-end "a key never reaches stdout/stderr" greps (with positive controls) live in the login, setup and
// account-credentials tests; this is the one display rule they share.
it.each([
  ["rdc_live_ABCDEFGHIJ1234", "••••1234"], // last 4 of a long key only
  ["rdc_live_ABC123", "••••••••"], // nothing of a key under 16 chars
  ["abc", "••••••••"],
  [undefined, "<unset>"],
])("redactKeyForDisplay(%j) = %s", (key, shown) => {
  expect(redactKeyForDisplay(key)).toBe(shown);
});
