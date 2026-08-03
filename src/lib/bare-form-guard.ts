/**
 * Guards for the two command groups whose bare positional form performs a WRITE.
 *
 * ## The hazard
 *
 * A command group that declares BOTH `subCommands` and a positional `run()`
 * fallback has an ambiguous first token. The dispatcher descends into a
 * subcommand when the token names one, and otherwise runs the bare form; so a
 * token that is *meant* as a subcommand but isn't registered silently becomes
 * the bare form's first argument.
 *
 * For a read that is a wasted round trip. For a write it is an action the user
 * never asked for: `message search "sophie"` bound `chatId="search"`,
 * `text="sophie"` and called the send path, and `connect snet` would send a
 * connection invitation to whoever owns the slug `snet`. Two groups are
 * write-bearing this way, `message` and `connect`, and both are guarded here.
 *
 * ## Two different guards, because the two argument spaces differ
 *
 * `message`'s bare positional is a **chat id**, a machine-generated opaque
 * value (`2-<base64>`, `COMPANY_<n>_<suffix>`, or a thread URL). None of those
 * can be confused with a command word, so the guard is a shape test and it
 * catches every unknown subcommand, not just near-misses.
 *
 * `connect`'s bare positional may be a LinkedIn **public slug**, which is a
 * lowercase word and therefore shaped exactly like a mistyped subcommand. A
 * shape test would reject legitimate input, so that guard is a near-miss test
 * against the group's own subcommand names instead.
 *
 * Both guards gate ONLY the bare form. `message send <chat_id> "<text>"` and a
 * full profile URL respectively are always available, so neither guard can
 * permanently block a legitimate write.
 */

/**
 * A token shaped like a command word: lowercase, hyphen-separated segments,
 * starting with a letter. Matches `search`, `list`, `inmail-balance`, `sned`.
 *
 * Deliberately does NOT match any chat-id form: `2-…` starts with a digit,
 * `COMPANY_…` has uppercase and an underscore, and a thread URL has `:` and `/`.
 */
const COMMAND_WORD_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** True when `token` reads as a command name rather than an opaque identifier. */
export function looksLikeCommandWord(token: string): boolean {
  return COMMAND_WORD_RE.test(token);
}

/**
 * Damerau-Levenshtein distance (Levenshtein plus adjacent transposition).
 *
 * Transposition has to count as ONE edit, not two, because the typos that
 * matter here are transpositions: `snet` for `sent`, `accpet` for `accept`,
 * `recieved` for `received`. Plain Levenshtein scores those 2 and would let
 * them through a distance-1 threshold.
 */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  // (m+1) x (n+1) matrix.
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i]![0] = i;
  for (let j = 0; j <= n; j++) d[0]![j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(
        d[i - 1]![j]! + 1, // deletion
        d[i]![j - 1]! + 1, // insertion
        d[i - 1]![j - 1]! + cost, // substitution
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, d[i - 2]![j - 2]! + 1); // transposition
      }
      d[i]![j] = best;
    }
  }
  return d[m]![n]!;
}

/**
 * The subcommand `token` was most likely meant to be, or null when it does not
 * plausibly name one.
 *
 * The threshold scales with the name's length so a short name cannot swallow
 * half the identifier space: names under 6 characters admit a single edit
 * (`sent` accepts `snet`/`sen`/`send`, not `agent`), longer names admit two
 * (`received` accepts `recieved`/`recevied`). A token that is a strict prefix
 * of a subcommand also counts, since a truncated command is a typo too.
 *
 * Exact matches never reach here, because the dispatcher routes those into the
 * subcommand before the bare form is considered.
 */
export function nearestSubcommand(token: string, subcommandNames: string[]): string | null {
  let best: { name: string; distance: number } | null = null;

  for (const name of subcommandNames) {
    const threshold = name.length < 6 ? 1 : 2;
    // A strict prefix of at least 2 characters reads as a truncation.
    const isPrefix = token.length >= 2 && token.length < name.length && name.startsWith(token);
    const distance = isPrefix ? 1 : editDistance(token, name);
    if (distance > threshold) continue;
    if (best === null || distance < best.distance) best = { name, distance };
  }

  return best?.name ?? null;
}

/**
 * A LinkedIn chat id, in every form the messaging surface hands out:
 *   - `2-<base64>`, what `inbox list` / `inboxes chats` return
 *   - `COMPANY_<numeric>_<suffix>`, a company-page mailbox
 *   - a messaging thread URL, which the caller normalizes before this check
 *
 * Used only for the diagnostic: the guard's actual test is
 * `looksLikeCommandWord`, which is the safer direction (an unfamiliar chat-id
 * shape passes through rather than being blocked).
 */
export function isKnownChatIdShape(token: string): boolean {
  return /^2-/.test(token) || /^COMPANY_/.test(token);
}
