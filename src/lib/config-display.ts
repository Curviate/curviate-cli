/**
 * Display helpers for config values.
 *
 * API keys are ALWAYS redacted before display. No raw key value may appear
 * in any stdout, stderr, or JSON output from `config list`.
 */

/**
 * Redact an API key for display.
 *
 * Shows the first 8 characters (the prefix) followed by bullets and the
 * last 4 characters, so the user can identify which key is stored without
 * revealing it.
 *
 * Examples:
 *   "rdc_live_ABCDEFGHIJ1234" -> "rdc_live_••••1234"
 *   short key                 -> "••••••••"
 *   undefined                 -> "<unset>"
 */
export function redactKeyForDisplay(key: string | undefined): string {
  if (key === undefined || key === null) return "<unset>";
  if (key.length <= 8) return "••••••••";
  return key.slice(0, 8) + "••••" + key.slice(-4);
}
