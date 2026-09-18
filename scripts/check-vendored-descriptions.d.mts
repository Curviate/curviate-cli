/**
 * Type declarations for check-vendored-descriptions.mjs, the field-by-field
 * drift guard between the vendored CLI fixture and the SDK fixture it was
 * copied from.
 *
 * check-vendored-descriptions.mjs is a plain-JS script (no build step; it
 * runs directly via `node scripts/check-vendored-descriptions.mjs`), so
 * TypeScript has no way to infer its exported shape on its own. This
 * sibling `.d.mts` file is TS's standard pairing convention for a `.mjs`
 * implementation — picked up automatically for any
 * `import ... from "./check-vendored-descriptions.mjs"` — so
 * test/check-vendored-descriptions-guard.test.ts can import it under
 * `strict` without an implicit-any error, while the runtime file itself
 * stays plain JS (no build step added). Mirrors check-fixture-pin.d.mts.
 */

export type DescriptionDiffRow = ["MISSING" | "STALE" | "EXTRA", string, string];

export function diffDescriptions(sdkFixturePath: string, cliFixturePath: string): DescriptionDiffRow[];
