/**
 * Display helpers for config values.
 *
 * API keys are ALWAYS redacted before display. No raw key value may appear
 * in any stdout, stderr, or JSON output from `config list`.
 */

/**
 * Redact an API key for display.
 *
 * Shows bullets and the last 4 characters, so the user can tell which key is
 * stored without revealing it. A key under 16 characters shows none: 4 of 8
 * would be half the key.
 *
 * Examples:
 *   "rdc_live_ABCDEFGHIJ1234" -> "••••1234"
 *   key under 16 characters   -> "••••••••"
 *   undefined                 -> "<unset>"
 */
export function redactKeyForDisplay(key: string | undefined): string {
  if (!key) return "<unset>";
  // The last 4 only, and only when that is at most a quarter of the key.
  if (key.length < 16) return "••••••••";
  return "••••" + key.slice(-4);
}
