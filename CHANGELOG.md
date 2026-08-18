# Changelog

All notable changes to `@curviate/cli` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html):
a new command or flag is a minor; a breaking command/flag/exit-code change is a major; a fix is a patch.

## [Unreleased]

## [0.24.0] - 2026-08-18

### Changed

- **Corrected flag-to-body-field drift across `search`, `sales-nav`, and
  `recruiter`.** Named filter flags were hand-mapped to request-body field
  names with no compiler coupling, so several server-side field
  renames/removals left flags pointing at fields the body schema now rejects
  with a 400. Every one of these previously produced a 400, so nothing that
  worked is being taken away:
  - `search people`: `--company` -> `current_company` (was: `company`)
  - `search companies`: `--has-job-offers` -> `has_job_postings` (was:
    `has_job_offers`); `--network-distance` **removed** (field no longer
    accepted on this endpoint)
  - `search companies --filters` help text corrected: the request body is
    `.strict()` and rejects unknown fields with a 400, it does not
    validate-and-strip them
  - `sales-nav search people`: `--groups` -> `group` (was: `groups`, plural)
  - `sales-nav search companies`: `--technologies` / `--recent-activities` /
    `--network-distance` **removed** (none is an accepted field on this
    endpoint)
  - `recruiter search people`: `--function` -> `job_function` (was:
    `function`); `--locale` **removed** (no accepted field exists for it)
  - Adds a guard test that checks every command's real body output against
    the accepted request-body properties in the SDK's OpenAPI fixture, so a
    future rename/removal reds a test instead of shipping silently.
- **`@curviate/sdk` dependency floor raised to `^0.23.0`** (was `^0.22.0`),
  matching the SDK regeneration the fixes above were verified against.

### Removed

- `--locale` (recruiter search people), `--technologies` and
  `--recent-activities` (sales-nav search companies). All three previously
  produced a 400 on every call; a script passing them now fails at argument
  parsing instead. Breaking to the command surface even though the flags
  were non-functional, hence a minor bump rather than a patch.

## [0.23.3] - 2026-08-17

### Changed

- **`@curviate/sdk` dependency floor raised to `^0.22.0`** (was `^0.21.0`).
  A caret range on a `0.x` version is locked to that minor, so without this
  bump the CLI would have stayed on the previous SDK types. The new SDK minor
  is a regeneration against the production API document: the Recruiter and
  Sales Navigator profile section arrays now declare their item shapes, and
  every paginated endpoint's 400 description names a malformed cursor. No CLI
  behavior changes; typecheck, lint, and the full test suite are unaffected.

## [0.23.2] - 2026-08-13

### Changed

- **`@curviate/sdk` dependency floor raised to `^0.21.0`** (was `^0.20.1`).
  The new SDK minor carries two changes that are breaking for a typed
  consumer of the SDK directly (`total_count` and a search result's
  `profile_url` are now nullable; profile section arrays gained a described
  shape), but this CLI does not read any of those fields directly, so no CLI
  behavior changes. Typecheck, lint, and the full test suite are unaffected.

### Fixed

- **`profile` reported every past role as the person's current job, with no
  job title and a malformed company name.** The `current_position` projection
  read three field names that do not exist on the wire: `position` for the
  title, `company` as if it were a name string, and `end` for the end date.
  The visible result was `title: null` on every profile, a company object
  emitted into `company_name` where the field is documented as a string, and
  `is_current: true` for roles that ended years ago. It now reads `job_title`,
  `company.name`, and `ended_on`. A role is current when `ended_on` is absent,
  which is the only signal the platform provides. `company_id` is also
  populated now, from `company.id`, instead of always being null.

  If you consumed `current_position.is_current`, treat every previous reading
  of `true` as unverified: it was returned unconditionally.

## [0.23.1] - 2026-08-10

### Fixed

- **A global flag placed before the subcommand was rejected, and any flag
  value beginning with `-` was rejected.** `curviate --api-key <key> account
  list` exited 2 with "unknown command", and a value like `--api-key
  -something` exited 2 with "unknown flag". Both shared one root cause: the
  dispatcher's flag scan never tracked which tokens it had already consumed
  as another flag's value, so it re-inspected a value token as if it were
  fresh input, misreading a flag's value as the subcommand name in the first
  case and re-scanning a dash-prefixed value as its own (unknown) flag in the
  second. Fixing the scan surfaced a second, more serious defect on the same
  path: once a leading global flag was correctly found, the token AFTER it
  was dropped entirely on the way to the resolved command, so the flag's
  value silently never reached the request at all (a stored profile or
  environment variable answered instead, with no error). All three are
  fixed. Global flags now work in any position, and a flag value starting
  with `-` (an API key, a negative `--limit`, a message beginning with a
  dash) is bound exactly as typed.

## [0.23.0] - 2026-08-10

A security and correctness release. Upgrade promptly if `--account` is ever
set from anything other than a literal you typed yourself (an environment
variable, a config profile, or agent- or model-generated text): every
published version through 0.22.0 interpolated it into the request path with
no validation at all, so a value carrying a slash, `..`, a question mark, a
hash, or a percent sign could redirect a request, including a write, to a
different endpoint on the API host. This release also lets `--account` take a
connected account's name, not just its id.

### Fixed

- **`--account` could redirect a request to a different endpoint.**
  `inbox mark-read` on `--account 'x/../../../v1/accounts'` built
  `PATCH /v1/accounts/chats/chat_1` instead of touching the account the caller
  named. `--account 'a?x=1'` injected a query string into the middle of the
  path. Neither needed a literal `..`: the URL Standard percent-decodes when it
  decides whether a segment is a double-dot path segment, so `%2e%2e` walked up
  the path with no slash in the value at all. Every account-scoped command was
  reachable this way, since all of them build the request URL from `--account`.
  The value is now checked before any request is built, and a value that could
  redirect one is refused with `[INVALID_PATH_SEGMENT]` (exit `2`) naming the
  character it contains, rather than being sent.

- **`group get` / `group members` never actually accepted a group URL,
  despite documenting it.** The help and this file both claimed the server
  extracted the numeric id from a full `https://www.linkedin.com/groups/...`
  URL passed through verbatim; it does not, and cannot: the URL's own slashes
  split it into several path segments and the request landed on a route that
  does not exist. The numeric id is now extracted client-side, the same way
  member, company, chat, and job URLs already are. A bare numeric id is
  unaffected.

### Added

- **`--account` accepts a connected account's name, not just its id.** A value
  that is not shaped like an account id is looked up against
  `accounts.list`: an exact name match wins outright, otherwise a unique
  prefix match resolves. A name matching more than one connected account
  exits with `[ACCOUNT_AMBIGUOUS]` (exit `2`) rather than guessing, since
  acting on the wrong live persona cannot be undone. A name matching none
  exits with `[ACCOUNT_NAME_NOT_FOUND]` (exit `4`) and lists what is
  connected. On an API key with more connected accounts than the resolver
  reads (250 per page, 10 pages), a name lookup exits with
  `[ACCOUNT_LIST_TRUNCATED]` (exit `2`) instead of matching against a list
  that might be missing the very account the name would have matched; pass
  the id instead, which needs no lookup. An id-shaped value still costs no
  extra request. `--preview` never issues the lookup, consistent with it
  never calling the API.

### Changed

- **`@curviate/sdk` dependency bumped to `^0.20.1`.** ^0.20.0 still resolves
  the vulnerable 0.20.0 build on a fresh install or an old lockfile; 0.20.1 is
  a hard floor at the fix. Percent-encoding of every other command's path
  parameters (chat, job, group, company and member ids, and so on) is the
  SDK's job as of 0.20.0, not this CLI's: a previous CLI-side guard that
  inspected each call's leading string argument has been removed, because it
  could not know which argument actually became a path segment and was wrong
  in both directions, missing a path parameter passed inside an object and
  rejecting a body field that never reached a path (`post save <share URL>`
  was one such false rejection). `--account` is guarded separately, above,
  because it is the one value this CLI genuinely understands the meaning of.

## [0.22.0] - 2026-08-07

Two correctness fixes for the same underlying failure: a command that answers
a different question than the one you asked, without saying so.

### Changed

- **A trailing argument a command cannot use is now an error (exit 2), not
  something to ignore.** `curviate profile me relations` used to return your
  own profile at exit 0 with nothing on stderr, so a caller reading `.items`
  found nothing and concluded the account had no connections. Any unusable
  trailing token behaved the same way, so a typo such as `profile me
  reltaions` was swallowed just as quietly. The check now runs on the command
  that is actually about to execute, whatever route reached it, and the
  message names what you typed, how many positional arguments it takes, and
  its own `--help`. When the stray token is a real sibling command, the
  message names the form you meant, so `profile me relations` points you at
  `profile relations`. **This can turn an invocation that used to exit 0 into
  an exit 2.** It never turned into the answer you wanted, so a script
  relying on it was already getting the wrong data; the fix makes that
  visible.

- **Punctuation swept out of the published copy and the printed help.** The
  README, this changelog, and the help and error strings in `src/` used
  typographic characters with no plain-ASCII equivalent on the keyboard: em and
  en dashes, the single-glyph ellipsis, arrows. An id placeholder now elides
  with `acc_...`, a range reads `1-100`, and a mapping reads
  `write->read`. No release note changed what it claims; the changelog's word
  stream is byte-identical to before. Two non-ASCII characters stay on purpose:
  the redaction mask `config list` prints, and the literal emoji that documents
  `message react`'s own argument.

### Fixed

- **`notices[]` now survives projection.** 0.21.1 taught the renderer to show
  a response's notices, but the slim projection and `--fields` both run
  before it, and several of them rebuilt the response from a fixed list of
  keys that never included `notices`. So on `account list`, `connect sent`,
  `connect received`, and on any single-object response under `--fields`, the
  array was destroyed before it could be shown. The notice is now carried
  across projection at the single point every command's output passes
  through, so it reaches you regardless of the command or the flags. A
  response without notices renders exactly as before.

### Added

- **`pnpm check:copy`**, a pre-publish copy-quality gate over the npm-page copy
  (README, changelog, package description), chained into `prepack` next to the
  existing internal-reference scan. It fails the pack on any non-ASCII
  typographic character and reports, without failing, wording from the generic
  marketing register. The printed help and error strings keep their own gate,
  `test/copy-tells.test.ts`, which walks the TypeScript AST so it judges string
  literals and never comments; that test now covers the full character set
  rather than the em dash alone.

## [0.21.1] - 2026-08-06

### Fixed

- **A response's `notices[]` array is no longer silently dropped.** Both
  render paths now surface it: JSON mode already passed it through, and human
  mode now prints it above the results it qualifies, covering a filter value
  that took the id fast path (field + value) and a page whose results are
  anonymised upstream (no field/value). Previously a caller got an empty or
  unexplained result set with nothing telling them why.
- **`--all` (NDJSON streaming) now surfaces per-page notices too.** stdout
  stays pure one-object-per-line data; a page's notices are written to
  stderr through the same renderer the human-mode path uses, so a long-running
  `--all` consumer sees the same explanation a single-page call would.
- **`visibility` is back in the default (non-verbose) `search people` fields.**
  It was missing from the default field allowlist even though the server
  always sends it, so a row for a hidden or unresolved profile looked
  identical to a normal one unless you passed `--verbose`.

## [0.21.0] - 2026-08-04

A correctness release for every argument that reads from stdin. Upgrade
immediately if you are on 0.20.0: on that version the documented quick-start
login silently stored a placeholder instead of your API key, so the very first
command after it failed and blamed your key.

### Fixed

- **`curviate login --api-key -` now stores the piped key.** It previously
  reported success and exited 0 while writing the literal string
  `__curviate_stdin__` into your config, so every later command answered 401 and
  attributed the failure to your API key. That is the first command in the
  quick-start, so a new install failed on first contact with a misleading cause.

- **Eleven further arguments documented as accepting `-` now read stdin.** Each
  compared its raw value against `-`, but the dispatcher had already substituted
  an internal placeholder by that point, so the branch was unreachable and the
  placeholder was consumed as your data. Affected: `--filters` on the eight
  search and list commands, and `--body` on the three recruiter and webhook
  commands, which answered `--filters is not valid JSON` or
  `--body only accepts '-'` to a caller who had passed exactly that.

### Changed

- **A bare `-` is only special on an argument that declares a stdin contract.**
  Every other argument now receives a literal `-`, restored between the parser
  and the handler. Previously the substitution was indiscriminate, so a bare `-`
  became the internal placeholder at any argument, including places where it
  then travelled to the wire as a value. If you were relying on `-` being read
  from stdin on an argument whose help text does not describe that behaviour, it
  no longer is; the arguments that document the contract are unchanged.

- **The internal placeholder can no longer leave the process.** The request
  transport and the config writer both refuse it as a defence in depth backstop,
  and report what to do instead, so no future argument can leak it into a
  request or a config file.

## [0.20.0] - 2026-08-03

A safety and correctness release. Upgrade promptly: it closes a path by which a
mistyped command sent a message, and it is the first release in which
`curviate webhook verify` works at all.

### Fixed

- **An unknown subcommand under `message` no longer becomes a send.**
  `curviate message search "sophie"` did not error. `message` accepts both
  subcommands and a bare `message <chat_id> "<text>"` form, and an unregistered
  first token fell through to the bare form, so it bound `chatId="search"`,
  `text="sophie"` and **sent a message**. That applied to any unknown or
  mistyped subcommand: with `search` it 404s, but with a real chat id in that
  position, or a paste that lands one there, it messaged a real person.

  An unknown subcommand now exits 2 with usage and issues **no request at all**.
  The legitimate `curviate message <chat_id> "<text>"` form is unchanged, and
  `curviate message send <chat_id> "<text>"` is always available for a chat id
  the check does not recognise.

  To search your messages, the command is `curviate inbox search`.

- **A mistyped `connect` subcommand no longer sends a connection invitation.**
  Same shape: `curviate connect <id>` sends an invitation, so `connect snet`
  (for `sent`) invited whoever owns the slug `snet`. A first argument that is a
  near-miss of a `connect` subcommand is now refused with a suggestion. If the
  slug really was intended, pass the full profile URL or the provider id.

- **`curviate webhook verify` now verifies real deliveries.** It inherited a
  defect from `@curviate/sdk`: the platform sends the event name in `event` and
  the SDK required a `type` field no delivery has ever carried, so verification
  failed on 100% of genuine webhooks and reported `malformed_header`, pointing
  at the header and the secret when both were correct. Fixed by the `@curviate/sdk`
  0.19.0 dependency bump. A body that verifies but cannot be parsed now reports
  `malformed_payload`.

- **`webhook verify --body` accepts the raw body inline, as a file path, or on
  stdin.** Every documented invocation failed before this: the flag value was
  handed straight to the filesystem, so inline JSON was opened as a filename
  (`ENOENT`/`ENAMETOOLONG`), and `--body -` opened the internal placeholder the
  argument parser substitutes for a bare dash. Only a file path ever worked, and
  the failure surfaced as exit `1` with a raw filesystem error rather than a
  usage error. A body is now recognised by its leading `{`, `-` reads stdin on
  every platform, and anything unreadable exits `2` naming all three accepted
  forms. A trailing newline added by a shell redirect, `curl -o`, or an editor
  save is ignored; newlines inside the body are preserved.

- **`webhook verify --help` named the wrong signature header.** It said
  `X-Curviate-Signature`; the platform sends `Curviate-Signature`, so a reader
  who copied the name read for a header that is never present. The same help
  also claimed `--header` falls back to stdin, which it never did. Both flags
  are now marked required, so omitting one is a usage error instead of a
  signature failure that points at a secret which was never wrong.

- **`group list` help said `--profile`; the flag is `--target`.** `--profile` is
  the global config-profile selector, so following the help text selected a
  config profile and silently returned your own groups instead of the target
  member's.

- **`job publish` and `recruiter job publish` help said `--budget-*`.** The glob
  is not a flag anyone can type; the help now names `--budget-amount`,
  `--budget-currency`, and `--budget-scope`.

- **Em dashes removed from all CLI output** (error messages, help text, usage
  blocks), including the `no API key` error.

### Changed

- `@curviate/sdk` dependency bumped to `^0.19.0`. If you also call the SDK
  directly, note that its webhook event discriminant moved from `event.type` to
  `event.event`; see the SDK's 0.19.0 changelog.

### Added

- Two mechanical guards in the test suite, both derived from the live command
  tree rather than a hand-maintained list, so this class of defect cannot
  quietly return:
  - a fall-through audit that forces an explicit safe/read-only/write-bearing
    verdict on every command group that mixes subcommands with a positional
    fallback, and
  - a help-vs-args check that fails when any command's help text names a flag
    that command does not declare (resolving cross-references, so a reference
    to another command's flag is checked against that command).

- Two further mechanical guards, in the same spirit:
  - an em-dash check that walks the TypeScript syntax tree, so it inspects
    string and template literals only and leaves comments exempt structurally
    rather than by a fragile line-based heuristic, and
  - a pre-publish binary gate that runs every documented `webhook verify --body`
    form against a recorded delivery: the exact body bytes and the exact
    signature header the platform put on the wire, replayed verbatim and never
    re-signed. Tampering with a single field is still rejected, so the gate
    proves the verdict as well as the plumbing.

## [0.19.0] - 2026-07-29

A minor release closing the remaining SDK-parity gap: 25 new commands across seven
existing command groups plus three brand-new command groups. No breaking changes,
built against `@curviate/sdk` 0.18.1 (unchanged; every new command was already
covered by the published SDK, so no SDK bump was required).

### Added

- **`inbox search`**: search chats via `messaging.searchChats`.
- **`search groups`, `search services`, `search service-parameters`**: new search
  surfaces for groups, services, and service search parameters.
- **`post saved`, `post save`, `post unsave`**: list, save, and unsave posts.
- **`company managed`, `company followers`, `company chats`, `company chat`,
  `company messages`, `company message`, `company search-chats`**: company-inbox
  and managed-company read/write surface.
- **`profile subscription`, `profile analytics`, `profile visitors`, `profile ssi`**:
  account-scoped profile insight subcommands (subscription status, post/profile
  analytics, visitor list, Social Selling Index).
- **`group` command group**, new top-level group closing the LinkedIn Groups gap.
- **`feed`, `feed home`**: new command group to read the connected account's
  LinkedIn home feed as agent-actionable posts.
- **`notification`, `notification list`, `notification delete`,
  `notification show-less`**: new command group to read and act on LinkedIn
  notification cards.

Parity with the SDK surface is now 145/0 (no known gaps).

## [0.18.1] - 2026-07-18

A patch aligning `company reply` with the company-inbox chat-id cutover. No breaking changes, built against `@curviate/sdk` 0.18.1.

### Fixed

- **`company reply <id> <chat_id> "<text>"`** now takes the normal `2-...` conversation
  id that `company chats` returns; the endpoint resolves the page mailbox internally from
  the company identifier, so the earlier `COMPANY_` chat-id requirement is gone. `--preview`
  now always prints a "Will send as company page `<id>`" notice derived from the resolved
  identifier (previously it went silent for a bare `2-...` id). Reply-only and admin-gated,
  otherwise unchanged.

## [0.18.0] - 2026-07-17

A minor release adding the `company reply` command. No breaking changes, built against `@curviate/sdk` 0.18.0.

### Added

- **`company reply <id> <chat_id> "<text>" [--attach <file>...]`** (write, admin-gated,
  `--preview` accepted). Replies to an existing company-inbox conversation as the page,
  via the SDK's `companies.sendMessage`. `<chat_id>` must be a `COMPANY_` chat id from
  `inboxes chats`, not the `2-...` id the `company` reads return; it passes through verbatim
  (no client-side pre-check) and a non-`COMPANY_` id is rejected by the API with a guiding
  400 naming the fix. Reply-only: it cannot start a new conversation on the page's behalf.
  `<id>` accepts a URL, slug, or numeric id, resolved to the numeric id first (including
  under `--preview`, so the preview renders the request that would be sent). Pass `-` as
  the text to read the reply body from stdin. See also `inboxes chats` and `message send`
  (the personal equivalent, which also accepts a `COMPANY_` chat id).

## [0.17.0] - 2026-07-17

A minor release adding the `company follow-invite` and `company invitable-followers`
commands. No breaking changes, built against `@curviate/sdk` 0.17.0.

### Added

- **`company follow-invite <id> --invitee <AC...> [--invitee <AC...> ...]`** (write, admin-gated,
  `--preview` accepted). Invites the connected account's 1st-degree connections to follow an
  administered company page. `--invitee` is repeatable, at least one required, max 50 per
  request. All-or-nothing: for an all-valid request you get one outcome per requested invitee,
  in request order (`status: "invited" | "already_invited" | "ineligible" | "not_found"`); if
  any invitee id is invalid the whole request rejects with a 404, not a partial result.
  Re-inviting an already-invited member is a safe no-op, the same `invitation_id`, never a
  duplicate. `<id>`
  accepts a URL, slug, or numeric id, resolved to the numeric provider_id first (including
  under `--preview`, so the preview renders the actual request that would be sent).
- **`company invitable-followers <id> [--limit] [--cursor] [--all]`** (paginated read). Lists
  the connections eligible to be invited to follow a company page you administer, the read
  that seeds `company follow-invite`. Items carry no name or headline; hydrate a candidate via
  `profile <id>` first. `invite_token` is always re-encoded as base64 in CLI output (the raw
  value can carry bytes unsafe to print in a terminal), in every output mode.

## [0.16.0] - 2026-07-17

A minor release adding the `inboxes` command group. No breaking changes,
built against `@curviate/sdk` 0.16.0.

### Added

- **New `inboxes` command group (Beta), the reply-as-a-page workflow.**
  `inboxes list [--kind personal|company] [--company-id <id>]` discovers the
  account's personal inbox plus, when the company product is attached, one
  entry per company page (id like `COMPANY_83734124_PRIMARY`), a flat,
  non-paginated read (rejects `--all`). `inboxes chats <inbox_id> [--limit]
  [--cursor] [--all]` lists a single inbox's conversations, cursor-paginated
  like every other list command. Every returned chat id is send-ready: reply
  with the existing `message send <chat_id> "<text>"`. A company inbox's
  chat id (e.g. `COMPANY_83734124_2-...`) sends AS THE PAGE, no separate flag
  needed. Company inboxes are reply-only and cannot start a new conversation.
  Distinct from the existing `inbox` command group (a friendlier front door
  to the account's own message-thread inbox: `messaging.listChats`/`getChat`/
  `markChatRead`/`messages`). `inboxes` (plural) wraps the newer
  inbox-*discovery* resource, so both groups coexist without a naming
  collision.
- **`PREMIUM_CONFLICT` and `REAUTH_REQUIRED` mapped to exit code 8**
  (account/connection state) in the error to exit table, the two new SDK
  error codes surfacing from `account link`'s underlying `auth.intent` call:
  a seat resolving to both individual-Premium tiers at once, and a
  scope-changing reconnect attempted with a cookie instead of credentials.
- **`message send` names the acting identity on a company-page reply.**
  When the response's `sent_as.kind` is `"company"`, the default output
  (not just `--verbose --json`) now prints `Sent as <name> (company page)`
  to stderr right after the send (the data itself was already on the
  response; this makes it visible without inspecting raw JSON). A personal
  send prints nothing new.
- **`message send --preview` echoes the acting identity for a `COMPANY_`
  chat id.** Prints `Will send as a company page` to stderr, derived purely
  from the chat id's own prefix so `--preview` still makes zero network
  calls. A personal chat id prints nothing new.
- **`--limit` on `inbox list`, `inbox messages`, and `inboxes chats` is now
  validated client-side against the server's accepted range (1-25).** A
  value outside that range now exits 2 with `error: --limit must be
  between 1 and 25 (default 20); got <value>.` before any network call,
  instead of round-tripping to the server for the same 400. `--help` on
  all three now states the range explicitly.

## [0.15.2] - 2026-07-12

A patch release fixing an interactive-terminal hang on `account link`.

### Fixed

- **`account link --password-stdin` / `--li-at-stdin` no longer hang on an
  interactive terminal.** These flags previously read stdin to EOF, which a
  human paste + Enter never produces on a TTY; the command hung
  indefinitely and the pasted secret echoed on-screen. The read is now
  mode-aware: piped/redirected stdin (non-TTY) is unchanged (read to EOF,
  trimmed); an interactive TTY now prints a single cue line, then reads one
  no-echo line; paste + Enter resolves immediately, including a paste whose
  clipboard content ends in a trailing newline. An empty line still falls
  through to the normal resolution order (env var, then the password
  prompt / `li_at` fail-fast).
- **`--preview` never blocks on a terminal read.** Under `--preview`, the
  interactive stdin read is suppressed entirely, matching every other
  preview-mode command.

## [0.15.1] - 2026-07-11

A patch release of agent-experience (AX) and developer-experience (DX)
improvements: clearer errors and help, a modest default pacing on `--all`
streams, one back-compatible reaction-signature unification, and a
`profile endorse` fix. No breaking changes.

### Added

- **Successor hints for removed/renamed commands.** Reaching for a command that
  moved or was removed in 0.15.0 (`post list`, `post comment`/`comments`,
  `connect respond`, `profile connections`, `account connect-link`/`reconnect-link`/`reconnect`,
  `inbox sync`/`sync-chat`, `recruiter add-candidate`/`project-jobs`/`sync`,
  `sales-nav sync`, `webhook state-diff`, `company followers`) now prints a
  one-line "did you mean" pointer to the replacement instead of a bare
  "unknown command". The exit code is unchanged (2).
- **`--all` NDJSON-mode notice.** When `--all` streaming engages, a one-line
  notice on stderr makes the format switch explicit (`--all` streams NDJSON,
  one object per line, not the `{items, cursor}` envelope), so an agent
  pattern-matching the plain-mode shape does not mis-parse the stream.
- **`--page-delay <ms>` and default `--all` pacing.** `--all` now pauses a
  modest default between page fetches, keeping a long stream under the platform
  rate gate. `--page-delay <ms>` overrides it (pass `0` to disable).
- **`job list --state ALL`.** A best-effort client-side union across every state
  (DRAFT/OPEN/CLOSED/REVIEW/SUSPENDED): each state is queried, re-filtered
  against its own state, then merged and de-duplicated by id. There is no
  unified cursor; each state is walked independently and `--max-pages` applies
  per state.
- **`--fields` unknown-field warning.** Projecting a field that matches nothing
  on the response now emits one stderr warning naming the unmatched fields and
  listing the available keys, instead of silently returning `{}`. The output is
  unchanged; the known fields still project.

### Changed

- **Reaction commands unified on the positional form.** `post react <post_id>
  <reaction>` and `message react <chat_id> <message_id> <emoji>` now take the
  reaction/emoji as a positional argument, matching `comment react`/`unreact`
  and `post unreact`. The previous `--reaction` and `--emoji` flags still work as
  deprecated aliases (no breaking removal). A missing value is now a usage error
  (exit 2) rather than a silent empty reaction.
- **Constraint discoverability in help.** `job create`/`job update` help now
  states the 200-character minimum on `--description` explicitly, and
  `job publish --budget-amount` notes it must be non-negative.
- **List-lag notes.** `post user-posts`, `comment list`, `inbox messages`, and
  `connect sent`/`received` help now note that a very recent create/delete may
  take a few minutes to appear or clear (LinkedIn-side indexing), and that a
  direct `get` reflects a change immediately.

### Fixed

- **`profile endorse <slug|url>`** now resolves the handle to the member's
  provider id before endorsing (via a contact-safe profile read), matching
  `profile follow`/`unfollow`. Previously a slug or URL 404'd because the
  endorse endpoint accepts only the provider id; the provider-id form was
  unaffected.

## [0.15.0] - 2026-07-11

Full v2 API-surface parity, the coupled release with `@curviate/sdk` 0.15.0. A large
**breaking** minor (pre-1.0): the CLI is re-pointed onto the v2-only API, drops the
commands whose endpoint no longer exists, relocates several verbs, and adds commands for
the new v2 methods. Every command noun kept its intent-shaped name; only the wiring,
removed orphans, relocations, and additions changed.

### Removed (BREAKING)

Commands whose underlying v2 endpoint no longer exists:

- **`account connect-link`**, **`account reconnect-link`**, **`account reconnect`**: the hosted-link and in-place re-auth flows. Connect a new account with `account link`; poll a hosted session with `account connect-session poll`.
- **`company followers`**
- **`inbox sync`**, **`inbox sync-chat`**: message history now syncs implicitly.
- **`post list`**
- **`recruiter sync`**, **`recruiter add-applicant`**, **`recruiter reject-applicant`**, **`recruiter job checkpoint`**
- **`sales-nav sync`**
- **`webhook state-diff`**

Flags with no v2 request-side home, dropped entirely (not defined, parsed, or forwarded), with no replacement:

- **`profile --notify`**: signal-a-view has no v2 request field.
- **`message inmail --surface`**: the v2 send-InMail body carries no surface/type discriminator.
- **`post create --video-thumbnail`**: v2 posts carry media only via `--attach`.
- **`search people|companies|posts|jobs --url`**: from-URL search is now the bare `search <url>` form.

### Changed (BREAKING)

Renames and relocations:

- **`post comment`** / **`post comments`** (and `post react --comment-id`) -> the new **`comment`** group (`comment add`, `comment reply`, `comment react`, and the rest). Comment threads are first-class.
- **`connect respond --accept` / `--decline`** -> **`connect accept <id>`** / **`connect decline <id>`**; the combined `respond` is removed.
- **`recruiter add-candidate`** -> **`recruiter save-candidate <project_id> --stage-id <id> --candidate-id <id>`** (full body reshape).
- **`recruiter project-jobs`** -> **`recruiter project-job get <project_id>`** (cardinality fix: a project has at most one attached posting; single-object read, no pagination).
- **`recruiter job applicants`** -> **`recruiter applicants <project_id>`** (the applicant list is project-scoped, not job-scoped; `--channel-id` still required).
- **`profile connections`** -> **`profile relations`**.
- **`profile endorse --skill`** -> **`profile endorse --endorsement-id`**, value semantics unchanged (still the target's `endorsement_id`, obtained from their skills section via `profile <id> --sections skills`); the old flag name misleadingly suggested a skill name.

CLI-visible shape changes:

- **`job publish`** now requires **`--mode`** (`FREE | PROMOTED | PROMOTED_PLUS`); `PROMOTED`/`PROMOTED_PLUS` additionally require the full `--budget-*` triple.
- **`recruiter job create`** now requires **`--project-name`** and takes the full v2 job body; `--employment-status` replaces the pre-v2 `--employment-type` on this command, alongside the company / workplace / location flags.
- **`recruiter message new`** is now **JSON-only** (file/voice/video attachments ride the body as base64, no multipart) and requires **`--subject`** and **`--signature`**.

Dependency and request grammar:

- **`@curviate/sdk` bumped to `0.15.0`.**
- **Account-first path grammar.** Every account-scoped request now addresses the account in the URL path instead of a query/body field. This is handled entirely inside the SDK, no CLI syntax changes, but every command's underlying request moved.

### Added

New **`comment`** command group (the comment-thread surface):

- `comment list <post_id>`, `comment add`, `comment reply`, `comment edit`, `comment delete`, `comment replies`, `comment react`, `comment reactions`, `comment unreact`, `comment user`.

Job-posting management, the **`job`** family:

- `job list`, `job create`, `job update`, `job budget`, `job publish`, `job close`, `job applicants`, `job applicant get`, and `job applicant resume` (binary résumé download via `-o`).

Profile:

- `profile update`, `profile follow`, `profile unfollow`, `profile following` (alongside `profile followers`).

Posts:

- `post delete`, `post unreact`, `post user-posts`, `post user-reactions`.

Search and inbox:

- `search <url>` (run a pasted search / saved-search / lead-list URL directly), `inbox mark-read`.

Recruiter (project-centric surface):

- `recruiter projects`, `recruiter project`, `recruiter project update`, `recruiter pipeline`, `recruiter project-job get|create|budget|update`, `recruiter talent-search`, `recruiter save-candidate`, `recruiter applicants`, `recruiter applicant get|resume`, plus `recruiter job close` and `recruiter search <url>`.

Sales Navigator:

- `sales-nav search <url>`, plus the v2 list surface: `sales-nav account-lists`, `lead-lists`, `browse-account-list`, `browse-lead-list`, `save-account`.

Account:

- **`account link --account-id <acc_...>`** (optional, non-breaking): re-authenticate an existing account **in place** (reconnect): passing the id makes `account link` an in-place reconnect of that account; omit it for an ordinary fresh connect (unchanged, no `account_id` is sent). This is the reconnect path now that the hosted `account reconnect` / `account reconnect-link` commands are removed.

Exit-code mapping:

- **`ACCOUNT_ALREADY_LINKED`** and **`LINKEDIN_OPERATION_NOT_SUPPORTED`** are now present in `EXIT_CODE_MAP` (exit `8`, account / connection state, grouped with `ACCOUNT_RESTRICTED`/`RESOURCE_ACCESS_RESTRICTED`); previously `ACCOUNT_ALREADY_LINKED` was already a valid SDK `ErrorCode` but had no exit-code entry, and `LINKEDIN_OPERATION_NOT_SUPPORTED` is a new SDK code (a permanent LinkedIn platform limitation for the attempted operation, e.g. listing a non-self user's following list). Both were silently falling through to the default exit `1`; the exhaustiveness test now covers them.
- **`CONNECTION_REQUEST_CONFLICT`** (exit `8`, account / connection state, the documented "already invited or already connected" contract on a `connect` retry) and **`RATE_LIMITED`** (exit `6`, rate-limited, a general/unscoped rate-limit signal alongside `RATE_LIMIT_ACCOUNT`/`RATE_LIMIT_TENANT`/`PLATFORM_RATE_LIMIT`/`LINKEDIN_RATE_LIMITED`) are new SDK error codes, both now present in `EXIT_CODE_MAP`. Picked up via the refreshed `@curviate/sdk` 0.15.0 tarball dependency (pnpm-lock.yaml integrity hash only).

### Fixed

- **`company <id> employees` / `company <id> posts` / `company <id> jobs` (id-first form) no longer silently returns the base company profile.** The router bound `<id>` and dropped the trailing sub-resource word, so the id-first form quietly returned the company profile with exit 0. It now routes the id-first form to the sub-resource (equivalent to `company <sub> <id>`), or exits 2 with an actionable error on a genuinely unexpected extra argument, never a silent wrong result. The guard is applied uniformly across every bare-form command group.
- **`company employees|posts|jobs <slug>` (or a company URL) now works.** The three sub-resources previously required the numeric company id and erred on a handle; they now auto-resolve a slug/URL to the numeric id the same way the bare `company <slug>` retrieve does (a numeric id still passes straight through; a genuinely unresolvable identifier surfaces the not-found error).
- **`profile follow <slug>` / `profile unfollow <slug>` (or a member URL) now work.** The follow endpoint accepts only a provider id, so a slug returned "not found"; both commands now resolve the identifier to the member's provider id first, the same auto-resolution `profile`, `connect`, and `message` already do.
- **`company posts` / `search posts` slim `--json` output no longer emits a permanently-null `post_urn`/`posted_at` and silently drops the post's own id (D13).** Both endpoints share the identical v2 item schema (`{id, share_url, text, author, reaction_count, comment_count, repost_count, is_repost, attachments, reactions, permissions}`), `post_urn` was never a real key and `posted_at` doesn't exist on this resource at all. Slim output now surfaces the real `id`; `--fields` projects the real v2 keys. `share_url`/`repost_count`/`is_repost`/`attachments`/`reactions`/`permissions`/the full `author` object remain verbose-only.
- **`company <id>` slim `--json` output no longer emits permanently-null `employee_count`/`employee_count_range`/`followers_count`/`foundation_date`, and drops the entirely-fictitious `messaging` field.** The real v2 company-profile response nests headcount data at `insights.headcount` / `insights.headcount_range.from` (the range has no upper bound at all, documented open-ended-high, so no `to` is invented), the establishment date is a bare year at `establishment_year` (not a date string), the follower count key is singular, and there is no `messaging` field anywhere on this resource. Slim output now surfaces real `employee_count` / `employee_count_range` (`{from}` only) values; **`foundation_date` is renamed `establishment_year`** and **`followers_count` is renamed `follower_count`** (both now real, non-null); `messaging` is removed outright. `headquarters` (synthesized from `locations`) now reads the real `country_code`/`postal_code` location keys, the fictitious `country` key never existed and always projected null, and is renamed `country_code`; `postal_code` is added. `area` (region/state, e.g. "Washington") stays; it's real and often populated (verified live), even though the SDK's OpenAPI-generated types don't declare it for this endpoint.
- **`job get` / `recruiter job get` slim `--json` output no longer emits a permanently-null `company_id`/`applicants_counter`, and `job get` (Core) no longer emits a permanently-null `published_at`.** `company_id` is synthesized from the nested `company.id` (neither shape has a top-level `company_id`); `applicants_counter` is renamed to `applications_count` (the real key on both shapes); `published_at` falls back to `created_at` on the Core shape, which has no `published_at` field at all (the Recruiter shape's own `published_at` is real and unaffected).
- **`profile me` / `profile <id>` slim `--json` output no longer emits permanently-null `provider_id`/`network_distance`/`is_premium`/`current_position`, restores `headline` sourced from its real location, and drops the entirely-fictitious `occupation`/`organizations` fields.** Both commands are backed by the identical real v2 user-profile response; there is no top-level `provider_id` (the real identifier is `id`), no top-level `network_distance`/`is_premium` (both nested under `specifics`), and no top-level `work_experience` (the real array is `specifics.experience`, which fed the `current_position` synthesis, also permanently null until now). `provider_id` now sources from `id`; `network_distance` and `is_premium` now source from `specifics.network_distance`/`specifics.is_premium`; `current_position` is synthesized from `specifics.experience[0]`. **`profile me`'s `email` is renamed `emails`** (the real field is a plural array, not a singular string). **`headline` <- `description`**: on a v2 read, LinkedIn serves the profile headline in the `description` wire field (a separate `bio` field carries the About-section paragraph); initially assumed to have no v2 source and dropped, then restored once the real source was confirmed live (3-way evidence: a written headline read back via `description` byte-for-byte, the same result from the M3 matrix probe, and `--verbose` showing headline-shaped text in `description` across live profiles). `occupation` and `organizations` are removed outright, neither has a v2 source; the real user-profile response has no occupation-summary field and no administered-organizations field of any kind. (`profile me`'s slim output drops from 10 fields to 9; `profile <id>`'s drops from 9 to 8.)
- **`job list --state` now re-filters returned items against their own `state` (D10).** LinkedIn's upstream state filter is best-effort; it commonly returns items whose own `state` doesn't match the request. `--json` output (and `--all` streaming) now only contains items whose own `state` actually matches (`--state OPEN` maps to the response's `LISTED`, the one value that differs between the request and response vocabularies); dropped items produce a stderr note with the count. The re-filter is page-local and never touches the pagination cursor, so `--all` still walks the same unfiltered upstream pages; it may fetch more pages than the filtered item count implies. The `--state` help text now says so.

### Notes: no user action required

- **`post react --as-organization`**: unchanged at the flag level; only the internal wire key was renamed, so the flag behaves exactly as before.

## [0.14.0] - 2026-07-07

Webhooks surface cascade, the coupled release with `@curviate/sdk` 0.14.0. Additive minor.

### Added

- **`webhook get <id>`**: get a single webhook owned by the calling tenant (`webhooks.get`). Read command; `--preview` is a usage error (nothing to mutate), matching `webhook state-diff`.

### Changed

- **`@curviate/sdk` bumped to `^0.14.0`.** The SDK's webhook event catalogue expanded 21 -> 27 (`chat.updated`, `chat.deleted`, `connection.new`, `account.initial_sync.*`, and account-lifecycle renames) and its `CurviateEvent` union re-keyed to match; this CLI never imports `CurviateEvent` directly, so `webhook verify`'s offline HMAC verification is unaffected; only the dependency range changed.

## [0.13.0] - 2026-07-05

Accounts/Auth surface migration, the coupled release with `@curviate/sdk` 0.13.0. This is a
**breaking** minor (pre-1.0): the account connection and checkpoint commands were reshaped to
match the new account-in-path grammar.

### Added

- **`account reconnect-link <account_id>`**: mint a one-time hosted **re-authorization** link for an existing disconnected account (the hosted counterpart of `account reconnect`). Same open+wait UX as `account connect-link`: on an interactive TTY the URL auto-opens and the command waits for the account to reconnect (exit `0` resolved, `9` expired/failed, `12` on a wait-window timeout); non-interactively it prints the url + session_id and returns immediately. Optional `--expires-in-seconds` / `--redirect-url`.
- **`account update --metadata '<json>'`**: set the account's custom metadata (a flat JSON object that replaces the store wholesale). **`account update --clear-proxy`**: clear the custom proxy (revert to automatic proxy protection).
- **New connect/checkpoint response fields ride through `--json` output** (coupled with the SDK 0.13.0 connect-fix regen, the CLI duck-types the response, so the fields pass through verbatim with no code change):
  - `recovered` (boolean) on `account link` and `account checkpoint solve` completions, `true` when the connect reclaimed a LinkedIn identity already present on the workspace rather than connecting a brand-new one.
  - the completed-account `status` is widened to `active | reconnect_needed | restricted | disconnected` (a recovered identity often reports needing a reconnect); the CLI reads `status` as a free-form string, so the wider set is unaffected.
  - `challenge_type` (`mobile_app_approval`) + `recovery_hint` on an `account checkpoint poll` that returns `status: "expired"` (a mobile-approval timeout).
  Surfacing `recovered` in the human-readable (non-`--json`) success line is a deferred UX follow-up; it would need consistent treatment across the direct-link, interactive-solve, and standalone-solve completion paths.

### Changed (BREAKING)

- **Checkpoint commands are now account-in-path (positional), not `--checkpoint`.**
  - `account checkpoint submit --checkpoint <id> --code <c>` -> **`account checkpoint solve <account_id> --code <c>`**.
  - `account checkpoint resend --checkpoint <id>` -> **`account checkpoint request <account_id>`**.
  - `account checkpoint poll --checkpoint <id>` -> **`account checkpoint poll <account_id>`** (the `--checkpoint` flag becomes the account_id positional; `--wait`/`--timeout` unchanged).
  - Update scripts: replace `checkpoint submit --checkpoint X --code Y` with `checkpoint solve X --code Y`, `checkpoint resend --checkpoint X` with `checkpoint request X`, and `checkpoint poll --checkpoint X` with `checkpoint poll X`.
- **`account refresh <account_id>` removed**: accounts restart and re-sync automatically now; there is no replacement command. Status freshness comes from the account-status webhook, the nightly reconcile, and `account get`.
- **`account connect-link` is create-only**; the `--purpose` and `--account-id` flags are removed; it only mints a link to connect a **new** account. Use `account reconnect-link <account_id>` for hosted re-auth of an existing account.
- **`account update` reshaped**; the managed `--country` / `--ip` flags are removed (a managed location is now chosen at connect time). The command now takes `--metadata` and/or a custom proxy (`--proxy-*` / `--clear-proxy`).
- **`account link` / `account reconnect` require `--user-agent` for cookie auth**; connecting by session cookie (`--auth-method cookie`) without a `--user-agent` fails fast at exit `2` (it stays optional for `--auth-method credentials`). Under `--preview` the check is skipped (a render never exits).
- SDK-parity manifest (`test/parity.test.ts`) repoints the checkpoint entries (`solve`/`request`/`poll`) and swaps `account refresh` -> `account reconnect-link`; the manifest and SDK method count stay at 93 (`accounts` stays 12 methods).

### Fixed

- **`account connect-session poll` now interpolates the session id correctly.** It previously passed the session id as an object to the SDK, producing a request path of `/v1/accounts/connect-sessions/[object Object]` (broken `--wait` loops). It now passes the id as a string. A regression test asserts the interpolated path is `/v1/accounts/connect-sessions/<session_id>`, never `[object Object]`.

### Changed

- `@curviate/sdk` dependency bumped to `^0.13.0`, the coupled release carrying the reshaped `accounts` surface (see the SDK's own CHANGELOG). The CLI duck-types the SDK, so its commands are covered by the parity manifest against that release.

## [0.12.0] - 2026-07-05

### Added

- **`company employees <id>`**: list people who currently work at the company (facade over people search with the company filter). `--keywords` and `--location` narrow the result; pagination flags apply. `<id>` must be the company's numeric provider_id (the `id` field of `company <id>`).
- **`company posts <id>`**: list the company's posts (facade over post search). Pagination flags apply; post `text` prints verbatim.
- **`company jobs <id>`**: list the company's open job postings (facade over job search). `--keywords` narrows the result. An empty list is a valid result (the company currently has no open postings), not an error.
- **`company followers <id>`**: list the company's followers (native, the same seam that backs `profile <id> --followers`). Requires the acting account to administer the target company page; a non-admin company returns the exit code for `RESOURCE_ACCESS_RESTRICTED` (new, see below).
- All four new subcommands support `--all` (NDJSON page streaming) alongside the existing pagination flags, and reject `--preview` (exit `2`) like every other read command.
- `--account` is now required on `company <id>` (retrieve); the underlying endpoint always requires `account_id`; previously the command silently fell back to an unscoped call.
- **Sales Navigator v2 list surface, 5 new subcommands.** `sales-nav account-lists --account <id>` and `sales-nav lead-lists --account <id>` list the operator's saved-account/saved-lead lists (`--limit`/`--cursor`/`--all` paginate). `sales-nav browse-account-list <list_id> --account <id> [--filter --sort-by --sort-order]` and `sales-nav browse-lead-list <list_id> --account <id> [--spotlight --sort-by --sort-order]` browse the saved items in one list, genuine paginated reads, so they keep all pagination flags. `sales-nav save-account <company_id> --list <id> --account <id>` saves a company into an account list (write, `--preview` supported, no pagination flags in `--help`). All five call the SDK's new `salesNavigator` methods (`accountLists`/`leadLists`/`browseAccountList`/`browseLeadList`/`saveAccount`), no re-implementation of the HTTP call.

### Changed (BREAKING)

- **`company <id>` now routes to the SDK's `companies.get()`** instead of the retired `profiles.getCompany()`, an internal repoint (the hard-moved server endpoint), not a CLI UX change: flags, output shape, and slim projection are unchanged. `--account` becoming required (above) is the one user-visible behavior change.
- SDK-parity manifest (`test/parity.test.ts`) repoints `company get` -> `companies.get` and gains `company employees` / `company posts` / `company jobs` / `company followers`; the manifest and SDK method count both move from 84 to 88.
- `@curviate/sdk` dependency bumped to `^0.12.0`, the released build carrying the `companies` resource and the v2 `salesNavigator` list-surface cascade (see the SDK's own CHANGELOG).
- **`sales-nav save-lead` re-signed for the v2 save-lead surface.** The old `save-lead <user_id> [--list-id <id>]` (list optional) is **retired, no alias**; the v2 op always saves into a specific list. The replacement is `save-lead <user_id> --list <id>`: `--list` is now **required** and the flag is renamed from `--list-id`. Update scripts: `save-lead <id> --list-id <l>` -> `save-lead <id> --list <l>`.
- SDK-parity manifest gains the 5 new `sales-nav` v2 subcommands; the manifest and SDK method count both move from 88 to 93 (`salesNavigator` 7->12 methods).

### Fixed

- **`RESOURCE_ACCESS_RESTRICTED`**: a new SDK error code (the non-admin mapping for `company followers`) is now present in `EXIT_CODE_MAP` (exit `8`, grouped with `ACCOUNT_RESTRICTED`); the exhaustiveness test would otherwise have silently mapped it to the default `1`.

## [0.11.0] - 2026-07-04

### Added

- **Safe credential entry** for `account link` / `account reconnect` / `account update`: env-var fallbacks (an explicit flag always wins over its env var), `--password-stdin` / `--li-at-stdin` flags to read a secret from stdin, and a masked TTY prompt with a non-TTY fail-fast when a credential is required but not supplied any other way. A 5-way conflict matrix rejects supplying the same credential through more than one channel. The four secret-bearing flags carry a shell-history/`ps`-visibility warning, and `--preview` masks credential values instead of ever rendering them in cleartext.
- **Guided checkpoint follow-through** on `account link` / `account reconnect`. A `202 checkpoint_required` response now resolves in-process on an interactive TTY: code prompt, retry loop on a `422`, chained-challenge follow-through, a codeless mobile-app-approval poll sub-loop, and a resend hint, instead of just printing the envelope. A non-interactive session (either stream not a TTY, or `--no-interactive`) still prints the envelope and exits with the new `12` (`AUTH_NEEDED`) code, a pending checkpoint, not an error.
- **`account checkpoint poll --wait`**: an adaptive-cadence loop (1000ms, then 1500ms for 30s, then 3000ms) that blocks until the checkpoint resolves (exit `0`), expires/fails (exit `9`), or the wait window elapses while still pending (exit `12`, still resolvable later). `--wait` is off by default (the single-poll behavior is unchanged). `--timeout <ms>` overrides the wall-clock bound (default: the checkpoint's own expiry) and fails fast at exit `2` on a non-numeric value, before any call. `checkpoint submit`'s one-shot path also now detects a chained `checkpoint_required` response and exits `12` instead of rendering it as a plain success.
- **`account checkpoint resend --checkpoint <id>`**: re-sends the pending challenge notification, mirroring `checkpoint submit` / `poll` (body-addressed, `WRITE_SINGLE_FLAGS`, `--preview` supported, no `--code` since there's nothing to submit). Exits `0` on any `200` regardless of the response's `resent` boolean; `false` is an honest answer, not a command failure.
- **`account connect-link` browser handoff.** The command now completes the hosted-link round trip instead of only minting a URL: on an interactive TTY it auto-opens the URL and waits on the same adaptive cadence as `checkpoint poll --wait` for the account to connect (resolved -> prints the connected account and exits `0`; expired/failed -> exit `9`; wait window elapses while still pending -> exit `12`). A non-interactive session (non-TTY, or `--no-interactive`) never opens a browser and never blocks; it prints the URL, a relay instruction, and the `session_id`, then returns immediately.
- **`account connect-session poll --session <id>`**: the standalone counterpart to the above: a single poll by default (prints the body, exits `0` regardless of status), or the same adaptive wait loop with `--wait`. `--open`/`--no-open` and `--wait`/`--no-wait` are TTY-adaptive; `--timeout <ms>` overrides the wait bound (default: time remaining to the session's own expiry).
- Pagination flags (`--limit`/`--cursor`/`--all`/`--max-pages`) are now suppressed on the 8 `account` subcommands that mutate or resolve exactly one resource (`link`, `connect-link`, `reconnect`, `refresh`, `update`, `disconnect`, `checkpoint submit`, `checkpoint poll`); they had no meaning on a one-row response. `account list` is unaffected. `link` / `reconnect` help text gains a one-line note about the checkpoint-required path.
- SDK-parity manifest (`test/parity.test.ts`) gains `account checkpoint resend` -> `accounts.resendCheckpoint` and `account connect-session poll` -> `accounts.getConnectSession`; both were held back pending the SDK's own `0.11.0` regen; the manifest and the SDK method count both move from 82 to 84.

### Fixed

- **Flag-dispatch bug:** the unknown-flag check always stripped a leading `no-` prefix before matching against the declared-flag set, so a flag literally declared with that prefix (e.g. `--no-interactive`) was misread as negating an undeclared name and rejected as unknown on every invocation. The full declared name is now checked first; the `no-` strip is only a fallback for citty's own implicit negation of an undeclared `no-*` flag.

### Changed

- `@curviate/sdk` dependency bumped to `^0.11.0`.

## [0.10.0] - 2026-07-03

### Added

- `job get <url|id>`: a new top-level `job` command retrieving one public LinkedIn job posting's full detail. Accepts a job URL (`https://www.linkedin.com/jobs/view/<id>`) or a bare numeric id; a job URL is resolved to its numeric id client-side; anything else passes through and the API is the final validator. Slim-default output: `object`, `id`, `title`, `company`, `company_id`, `location`, `state`, `applicants_counter`, `published_at`, `description`; `description` stays in the default output since retrieving it is the point of the command. Pass `--verbose` for the full response (adds `cost`, `created_at`, `hiring_team`). An unknown job id exits with the not-found exit code. This is a read command; `--preview` is a usage error, matching every other single-object read.
- `recruiter job get <url|id>`: the Recruiter-lens sibling of `job get`, joining the existing `recruiter job` command group. Retrieves any public job posting (not only postings you manage), unlike `recruiter jobs`, which lists your own. Same URL/id resolution and slim/verbose projection as the top-level command; requires the Recruiter add-on tier (exit `5` without it).
- README gained a new numbered example chaining `search jobs` into `job get`, and a "Get any public job posting through the Recruiter lens" example in the Recruiter section.

### Changed

- `@curviate/sdk` dependency bumped to `^0.10.0`.
- `recruiter job get --help` does not advertise `--limit`/`--cursor`/`--all`/`--max-pages`; a single-object read, consistent with the other Recruiter single-reads (`profile`, `project`, `applicant`). `--fields` and `--verbose` are unchanged and available.

## [0.9.0] - 2026-07-03

### Added

- `account list` and `account get` gain a compact **slim-default** output; pass `--verbose` for the full API response. Slim `account list` items: `account_id`, `status`, `auth_method`, `full_name`, `headline`, `seat_id`, `connected_at`. Slim `account get`: the same seven fields plus `last_checked_at` and `quotas`. Six cached account-detail fields (`username`, `premium_id`, `public_identifier`, `substrate_created_at`, `signatures`, `groups`) are verbose-only on both commands; they are `null`/`[]` on an account that hasn't been enriched yet, never a missing key. `--all` NDJSON streaming on `account list` applies the same slim projection per item unless `--verbose` is passed.
- `account get` gains `seat_id` in its slim output (previously only `account list` carried it), the seat the account occupies, `null` for an admin seatless account.

### Changed

- `@curviate/sdk` dependency bumped to `^0.9.0`.
- `account get --help` no longer advertises `--limit`/`--cursor`/`--all`/`--max-pages`; a single-object read, those flags never applied. `--fields` is unchanged and still available. `account list` is unaffected (a genuine list read, keeps all pagination flags).

## [0.8.0] - 2026-07-02

### Added

- `recruiter reject-applicant` gained `--message` and `--notify-at` flags. The applicant is only notified of the rejection when `--message` is provided (the prior behavior, no notification, is unchanged when both are omitted). `--notify-at` schedules the notification (a UNIX-milliseconds timestamp) and requires `--message`; passing `--notify-at` alone, or a non-numeric value, is a usage error (exit `2`).
- README gained dedicated "Sales Navigator" and "Recruiter" sections with numbered, runnable examples covering every in-scope command: searching and getting profiles, saving a lead, starting a chat, listing/searching Recruiter people and hiring projects, the job create -> publish -> checkpoint lifecycle, listing/getting applicants, downloading a resume, and rejecting an applicant with and without a notification.

### Changed

- **Help output cleanup:** Recruiter and Sales Navigator write commands (`add-candidate`, `add-applicant`, `reject-applicant`, `job create`/`publish`/`checkpoint`, `save-lead`, `message new`) and single-object read commands (`profile`, `project`, `applicant`, `applicant resume`) no longer advertise `--limit`/`--cursor`/`--all`/`--max-pages` in `--help`; those flags only ever applied to list/search commands, which keep them unchanged. Single-object reads keep `--fields`.
- Corrected the `search parameters --type` flag description on both `recruiter` and `sales-nav`; it previously suggested example values (`LOCATION`, `INDUSTRY`, `TITLE`) that the API does not accept for either surface; it now lists the real accepted values.
- Polished the `message new --to` flag description on both surfaces with the expected provider-ID format and a note that it is not resolved from a URL or slug.
- Updated `@curviate/sdk` dependency to `^0.8.0`. No resource method signatures changed (per the SDK 0.8.0 changelog); Recruiter's job-lifecycle endpoints (applicant get/reject/resume, applicant list, job publish/checkpoint, Recruiter profile) are now fully implemented server-side instead of returning `501`.

## [0.7.2] - 2026-07-01

### Changed

- Updated `@curviate/sdk` dependency to `^0.7.0`. The `recruiter message new` command output now reflects the aligned start-chat response `{ object, chat_id, message_id }` (the SDK dropped the `attendee_ids` echo and now surfaces `message_id`). The command sends the request unchanged (`attendees_ids` plus recruiter-specific flags); it renders the server response verbatim, so no command flags change.

## [0.7.1] - 2026-07-01

### Fixed

- `recruiter message new`: the `--to` recipient ID is now sent as `attendees_ids` (plural) in the request body, matching the updated server contract. A prior version used the old `attendee_ids` (singular) field name which the API no longer accepts.

### Changed

- Updated `@curviate/sdk` dependency to `^0.6.0`.

## [0.7.0] - 2026-07-01

### Added

- `search`: named filter flags that previously required raw `--filters` JSON:
  - **companies**: `--has-job-offers`, `--headcount <buckets>` (comma-separated
    size buckets `1-10 ... 5001-10000`; `10001+` reports a usage error).
  - **jobs**: `--title <ids>`, `--presence`, `--benefits`, `--commitments`,
    `--has-verifications`, `--under-10-applicants`, `--in-your-network`,
    `--fair-chance-employer`, `--location-within-area <miles>`.
  - **people**: `--connections-of`, `--followers-of` (comma-separated -> array).
  - **posts**: `--posted-by-member`, `--posted-by-company`, `--posted-by-me`,
    `--mentioning-member`, `--mentioning-company`, `--author-industry`,
    `--author-company`, `--author-keywords`.

### Fixed

- `search jobs` slim `company_name` was always `null`, now derived from the
  nested `company.name` (handles postings with no linked company). `--verbose`
  still returns the raw response unchanged.
- `search parameters --type`, `search jobs --seniority`/`--job-type`, and
  `search posts --content-type` help text now lists the correct/complete
  enumerations (no behavior change).

### Changed

- Updated `@curviate/sdk` dependency to `^0.5.0`.

## [0.6.1] - 2026-07-01

### Added

- `search people --title` (-> `advanced_keywords.title` keyword, nested-merged),
  `--industry`, `--profile-language`; `--filters` deep-merge (named flags win).
- `search jobs --location` -> `region` (single id) + `--region` alias +
  `--date-posted <days>` (number).
- `search posts --date-posted` hyphen->underscore normalize.
- `--all` truncation emits `{"object":"stream_truncated",...}` JSON.

### Changed

- Updated `@curviate/sdk` dependency to `^0.4.1`.

## [0.6.0] - 2026-06-30

### Added

- `inbox list --unread`: filter the inbox to chats with unread messages.
- `messages` now accepts `--before` and `--after` to page a conversation by
  timestamp window.
- `sync-chat --wait`: poll until a chat sync completes instead of returning
  immediately.
- `message new --to` and `message inmail --to` now resolve a **LinkedIn profile
  URL or vanity slug** (e.g. `linkedin.com/in/<slug>`) to the recipient, in
  addition to provider ids and member URNs.
- Thread-URL `chat_id` normalization: a pasted conversation URL is normalized to
  the underlying chat id wherever a `chat_id` is accepted.
- Write commands that take a TEXT positional accept `-` to read the value from
  stdin (pipe message bodies in).
- `connect`: slim default projection + write-flag suppression + help text
  (Invites-AX co-release).

### Changed

- Pagination flags are suppressed from the help output of non-list commands.
- Updated `@curviate/sdk` dependency to `^0.4.0` (regenerated types:
  `primary_locale` on profile, account-sync `status` field).

## [0.5.0] - 2026-06-29

### Added

- `message inmail --surface classic`: send an InMail from the account's own premium
  InMail credits (in addition to `sales_nav` and `recruiter`). Use this to reach an
  out-of-network member from a LinkedIn Premium/Core account.
- `message inmail --to` now accepts a member **provider id** (`ACoAAA...`) as well as a
  member URN (`urn:li:member:<id>`). The server resolves the recipient either way.

## [0.4.1] - 2026-06-29

### Changed

- Updated `@curviate/sdk` dependency to `^0.2.1`, which fixes `message delete` and
  `message react` failing with an unexpected `account_id` parameter rejection. The SDK
  now correctly omits `account_id` for those two operations.

## [0.4.0] - 2026-06-28

### Added

- `profile me` slim now includes `current_position` (synthesized from `work_experience[0]`
  when `--sections experience` is passed), achieving parity with `profile <id>` slim.

### Fixed

- `repository.url` in `package.json` normalized to the npm-canonical `git+https://` prefix.

## [0.3.0] - 2026-06-28

### Added

- `profile me` and `profile get` now return a slim 9-field projection by default (`id`, `first_name`, `last_name`, `headline`, `location`, `industry`, `profile_url`, `picture_url`, `current_position`); pass `--verbose` to get the full response.
- `profile get` synthesizes `current_position` from `work_experience[0]` when present.
- `profile get` and `profile me` accept `--sections` to request specific LinkedIn profile sections from the API.
- `profile get --posts --is-company` resolves a company slug to an account ID automatically (non-numeric IDs call `getCompany` first).
- `company get` now returns a slim 12-field projection by default (including `headquarters` and `messaging`); pass `--verbose` to get the full response.
- `login` persists `--base-url` to the named profile; re-login without `--base-url` preserves the existing base URL.

### Fixed

- `company` command now exits 2 with an error when `--sections` is passed (unsupported flag for that surface).
- `slimProfile` work_experience field mapping corrected (`position`->`title`, `company`->`company_name`); `is_current` now derived from `end == null`; `company_id` is always `null` (the experience-entry ID is not a company ID).

### Changed

- Updated `@curviate/sdk` dependency to `^0.2.0` (adds `getMe` `linkedin_sections`, normalized `OwnProfile`, `Chat.subject`).

## [0.2.0] - 2026-06-24

### Fixed

- `message inmail` now requires and forwards the `--surface` flag (was silently dropped).
- `connect respond` now requires and forwards `--shared-secret` (was silently dropped).
- `recruiter message new` uses the correct field name `attendee_ids` (was `attendees`).
- `recruiter job create` now forwards the full job body via JSON and scalar flags (was a no-op).

### Added

- `search` and `recruiter search` / `sales-navigator search` accept `--filters` for raw JSON filter objects and named filter flags (`--title`, `--company`, `--location`, `--school`, `--industry`) for common parameters.
- `search` and `recruiter search` / `sales-navigator search` accept `--url` (profile URL filter) and `--keywords`.

## [0.1.0] - 2026-06-22

### Added

- Initial public release, full SDK-surface parity CLI over the Curviate API.
- `curviate` root command with `--help` and `--version`.
- Global flags: `--account`, `--json`, `--fields`, `--limit`, `--cursor`, `--all`,
  `--max-pages`, `--preview`, `--base-url`, `--timeout`, `--api-key`, `--profile`.
- SDK-client factory: resolves config and constructs a `Curviate` instance.
- Lazy command loading for a fast cold start.
- White-label leak gate (`scripts/check-clean.mjs`) wired as `prepack`.
- Build-output smoke gate (`scripts/verify-dist.mjs`).
