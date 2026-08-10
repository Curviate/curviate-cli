/**
 * Type declarations for check-clean.mjs, the anti-leak guard.
 *
 * check-clean.mjs is a plain-JS script (no build step; it runs directly via
 * `node scripts/check-clean.mjs`), so TypeScript has no way to infer its
 * exported shape on its own. This sibling `.d.mts` file is TS's standard
 * pairing convention for a `.mjs` implementation — picked up automatically
 * for any `import ... from "./check-clean.mjs"` — so test/check-clean-guard.test.ts
 * can import it under `strict` without an implicit-any error, while the
 * runtime file itself stays plain JS with JSDoc (no build step added).
 */

export interface LeakPattern {
  label: string;
  pattern: RegExp;
}

export interface Finding {
  /** Path relative to the scanned root. */
  rel: string;
  /** 1-based line number. */
  line: number;
  label: string;
  /** The offending line, trimmed and capped in length. */
  text: string;
}

export interface ScanResult {
  filesScanned: number;
  linesScanned: number;
  findings: Finding[];
  /** Relative paths of files that existed but could not be read. */
  unreadable: string[];
}

export type Verdict =
  | { ok: true; reason: "clean" }
  | { ok: false; reason: "empty-scan" | "unreadable" | "leaks" };

export interface CollectFilesOptions {
  skipDirs?: Set<string>;
  scanExts?: Set<string>;
  scanDotfiles?: Set<string>;
  root?: string;
}

export interface ScanDirectoryOptions {
  patterns?: LeakPattern[];
  skipDirs?: Set<string>;
  scanExts?: Set<string>;
  scanDotfiles?: Set<string>;
  selfExcludeRel?: string;
  maxLineLen?: number;
}

export const pkgRoot: string;
export const SKIP_DIRS: Set<string>;
export const SCAN_EXTS: Set<string>;
export const SCAN_DOTFILES: Set<string>;
export const PATTERNS: LeakPattern[];

export function collectFiles(dir: string, opts?: CollectFilesOptions): Promise<string[]>;
export function scanDirectory(root: string, opts?: ScanDirectoryOptions): Promise<ScanResult>;
export function verdict(result: ScanResult): Verdict;
