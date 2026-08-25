/**
 * Type declarations for check-sdk-pin.mjs, the construction-level SDK
 * coupling guard.
 *
 * check-sdk-pin.mjs is a plain-JS script (no build step; it runs directly
 * via `node scripts/check-sdk-pin.mjs`), so TypeScript has no way to infer
 * its exported shape on its own. This sibling `.d.mts` file is TS's standard
 * pairing convention for a `.mjs` implementation — picked up automatically
 * for any `import ... from "./check-sdk-pin.mjs"` — so
 * test/check-sdk-pin-guard.test.ts can import it under `strict` without an
 * implicit-any error, while the runtime file itself stays plain JS with
 * JSDoc (no build step added).
 */

export interface SdkPinResult {
  ok: boolean;
  reason: "match" | "mismatch" | "not-exact" | "unresolved";
  declared: string;
  resolved: string | null;
}

export const pkgRoot: string;

export function checkSdkPin(root?: string): Promise<SdkPinResult>;
