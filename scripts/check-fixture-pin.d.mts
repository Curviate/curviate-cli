/**
 * Type declarations for check-fixture-pin.mjs, the vendored-OpenAPI-fixture
 * drift guard.
 *
 * check-fixture-pin.mjs is a plain-JS script (no build step; it runs
 * directly via `node scripts/check-fixture-pin.mjs`), so TypeScript has no
 * way to infer its exported shape on its own. This sibling `.d.mts` file is
 * TS's standard pairing convention for a `.mjs` implementation — picked up
 * automatically for any `import ... from "./check-fixture-pin.mjs"` — so
 * test/check-fixture-pin-guard.test.ts can import it under `strict` without
 * an implicit-any error, while the runtime file itself stays plain JS with
 * JSDoc (no build step added).
 */

export interface FixturePinResult {
  ok: boolean;
  reason: "match" | "mismatch" | "hash-mismatch" | "unresolved";
  declared: string | null;
  vendored: string | null;
  recordedHash: string | null;
  actualHash: string | null;
}

export const pkgRoot: string;

export function checkFixturePin(root?: string): Promise<FixturePinResult>;

export function fixtureHash(sdkVersion: string, fileBuf: Buffer): string;
