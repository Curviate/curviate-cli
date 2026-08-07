# @curviate/cli

Official command-line interface for the [Curviate API](https://docs.curviate.com).

Built for coding agents and power users: JSON output on pipes, structured exit codes,
and shell-native composition with `jq`, `xargs`, and `curl`.

## Install

**Global install** (recommended for interactive use):

```bash
npm install -g @curviate/cli
```

**One-off via npx** (no install required):

```bash
npx @curviate/cli --help
```

Requires Node.js 18 or later.

## Authentication

**Option 1: interactive login** (stores a profile in `~/.config/curviate/`):

```bash
curviate login
```

**Option 2: environment variable** (preferred in CI and agent loops):

```bash
export CURVIATE_API_KEY=<your-api-key>
curviate account list
```

**Option 3: per-command flag**:

```bash
curviate --api-key <your-api-key> account list
```

> **Security note:** a key passed via `--api-key` is visible to other users on
> the machine through `ps`/process listings and is recorded in your shell
> history. Prefer `curviate login` or the `CURVIATE_API_KEY` environment
> variable; reserve `--api-key` for one-off, low-trust contexts.

Get your API key from the [Curviate dashboard](https://docs.curviate.com).

## Usage

```
curviate [command] [subcommand] [flags]

Global flags available on every command:
  --account      Target a specific account ID
  --api-key      Override the API key for this invocation
  --profile      Use a named profile from ~/.config/curviate/
  --json         Force JSON output even when stdout is a TTY
  --fields       Comma-separated list of fields to include in JSON output
  --limit        Maximum number of results to return per page
  --cursor       Pagination cursor from a previous response
  --all          Fetch all pages (streams results)
  --max-pages    Cap on the number of pages fetched with --all
  --preview      Show what would happen without sending any write request
  --base-url     Override the API base URL (for testing)
  --timeout      Request timeout in milliseconds (default: 30000)
```

For full command reference see [docs.curviate.com](https://docs.curviate.com).

## Examples

These examples show how coding agents compose the CLI in real workflows.

### 1. Find people and send connection requests

Search for matching profiles, preview the invitations, then send them once satisfied:

```bash
# Look first: a search is a read, so it just runs (no --preview on reads)
curviate search people \
  --keywords "AI engineer" \
  --location "Berlin" \
  --limit 10 \
  --json

# Preview a single write before sending, then pipe IDs into connect, one request per person
curviate connect "$SOME_ID" --note "Hi, I'd love to connect." --preview

curviate search people --keywords "AI engineer" --location "Berlin" --all \
  | jq -r '.id' \
  | head -5 \
  | xargs -I{} curviate connect {} --note "Hi, I'd love to connect."
```

### 2. Triage the inbox and extract unread threads

Pull the inbox as JSON, filter unread chats, and surface the most recent message from each:

```bash
curviate inbox list --json --all \
  | jq '[.[] | select(.unread == true) | {chat_id, sender: .last_message.sender, preview: .last_message.text[0:80]}]'
```

### 3. Warm up a prospect by reacting to their recent posts

Read recent posts from a profile, then react to each, which is useful for ambient warm-up before outreach:

```bash
PROFILE_URL="https://www.linkedin.com/in/example"

curviate profile "$PROFILE_URL" --posts --fields post_id --json \
  | jq -r '.[].post_id' \
  | xargs -I{} curviate post react {} --reaction like
```

### 4. Check tier entitlement before a Sales Navigator sweep

Exit code `5` means the account lacks the required add-on. Branch on it in a script:

```bash
curviate sales-nav search people --keywords "VP Engineering" --json \
  || {
    code=$?
    if [ "$code" -eq 5 ]; then
      echo "Sales Navigator add-on required. Upgrade at https://docs.curviate.com"
    else
      echo "Search failed with exit code $code"
      exit "$code"
    fi
  }
```

### 5. Verify an inbound webhook signature offline

Validate a webhook payload before processing it, with no network call:

```bash
# Pipe the raw request body from stdin; pass the signature header and secret as flags
cat webhook-payload.json \
  | curviate webhook verify \
      --secret "$CURVIATE_WEBHOOK_SECRET" \
      --header "$CURVIATE_SIG_HEADER" \
      --body -
```

Exit `0` means the signature is valid and the parsed event is written to stdout as JSON.
Exit `2` means the signature is invalid or the replay window has expired.

### 6. Export all accounts to a CSV (agent-friendly pipeline)

List every connected account, select key fields, and format as CSV with `jq`:

```bash
curviate account list --all --json \
  | jq -r '["id","name","status"], (.[] | [.id, .name, .status]) | @csv' \
  > accounts.csv
```

### 7. Search jobs, then fetch full detail on the top result

`job get` accepts either a job URL or the bare numeric id, including the `job_urn` field a
job-search result already returns:

```bash
curviate search jobs --keywords "founding engineer" --location "Berlin" --account acc_1 --json \
  | jq -r '.items[0].job_urn' \
  | xargs -I{} curviate job get {} --account acc_1 --json

# A pasted job URL works identically:
curviate job get "https://www.linkedin.com/jobs/view/4428113858" --account acc_1
```

## Company

Company commands (`curviate company ...`) are Core-tier reads. `company <id>` accepts a public
handle (the slug in `linkedin.com/company/<handle>`) or a numeric id; the four sub-resource
commands require the company's **numeric provider id**, the `id` field `company <id>` returns.
`--account` (or a configured default account) is required on all of them.

### 1. Retrieve a company, then list its employees

```bash
curviate company t-systems --account acc_1 --json | jq -r '.id' \
  | xargs -I{} curviate company employees {} --keywords "engineer" --limit 10 --account acc_1 --json
```

### 2. Page through a company's posts and jobs

```bash
curviate company posts 112013061 --limit 5 --account acc_1 --json
curviate company jobs 112013061 --all --account acc_1 --json   # streams every page
```

## Sales Navigator

Sales Navigator commands (`curviate sales-nav ...`) require an account with the Sales Navigator
add-on tier attached. A call against an account without it fails with **exit code `5`** and a
`TIER_NOT_ACTIVE` error body naming the required tier (`sales_nav`); branch on the exit code the
same way as example 4 above. Write commands (`save-lead`, `save-account`, `message new`) accept
`--preview` to render the request without sending it.

### 1. Search Sales Navigator profiles, then get one full profile

```bash
curviate sales-nav search people \
  --keywords "VP Engineering" \
  --account acc_1 \
  --limit 5 \
  | jq -r '.items[0].id' \
  | xargs -I{} curviate sales-nav profile {} --account acc_1
```

### 2. Save a lead to a specific lead list

Preview first, then send. `--list` is required; the save always targets a specific list.

```bash
curviate sales-nav save-lead ACwAAA1234567 \
  --account acc_1 \
  --list 987654 \
  --preview

curviate sales-nav save-lead ACwAAA1234567 --account acc_1 --list 987654
```

### 3. Start a new Sales Navigator chat

```bash
curviate sales-nav message new \
  --to ACwAAA1234567 \
  --account acc_1 \
  "Hi, I'd love to connect about an opportunity at our company."
```

### 4. Search Sales Navigator companies

```bash
curviate sales-nav search companies \
  --keywords "series B fintech" \
  --account acc_1 \
  --limit 5 --json \
  | jq -r '.items[] | "\(.id)\t\(.name)"'
```

### 5. List saved-account and saved-lead lists

```bash
curviate sales-nav account-lists --account acc_1
curviate sales-nav lead-lists --account acc_1
```

### 6. Browse a saved-account list, filtered to starred accounts

```bash
curviate sales-nav browse-account-list 987654 \
  --account acc_1 \
  --filter STARRED \
  --sort-by NAME \
  --json \
  | jq -r '.items[] | "\(.id)\t\(.display_name)"'
```

### 7. Browse a saved-lead list, spotlighting recent job changes

```bash
curviate sales-nav browse-lead-list 456789 \
  --account acc_1 \
  --spotlight RECENT_POSITION_CHANGE \
  --json \
  | jq -r '.items[] | "\(.id)\t\(.display_name)"'
```

### 8. Save a company into an account list

```bash
curviate sales-nav save-account 112013061 \
  --account acc_1 \
  --list 987654 \
  --preview

curviate sales-nav save-account 112013061 --account acc_1 --list 987654
```

## Recruiter

Recruiter commands (`curviate recruiter ...`) require an account with the Recruiter add-on tier
attached. A call against an account without it fails with **exit code `5`** and a `TIER_NOT_ACTIVE`
error body naming the required tier (`recruiter`). The surface is project-centric: most
operations are scoped to a hiring project id. Write commands (`save-candidate`, `project update`,
`project-job create`/`update`, `job create`/`publish`/`close`, `message new`) accept `--preview`
to render the request without sending it.

### 1. List hiring projects

```bash
curviate recruiter projects --account acc_1 --limit 20 --json \
  | jq -r '.items[] | "\(.id)\t\(.name)"'
```

### 2. Inspect a project, its pipeline, and its attached job posting

`recruiter project-job get` returns the single job posting attached to a project (a
`RESOURCE_NOT_FOUND` / exit `4` when none is attached).

```bash
curviate recruiter project "$PROJECT_ID" --account acc_1 --json
curviate recruiter pipeline "$PROJECT_ID" --account acc_1 --json
curviate recruiter project-job get "$PROJECT_ID" --account acc_1 --json
```

### 3. Create a job posting draft, then publish it

`recruiter job create` requires `--project-name` (the hiring project the posting opens) and takes
the v2 job body. `recruiter job publish` is project-scoped and requires `--mode`
(`FREE | PROMOTED | PROMOTED_PLUS`); the paid modes also require the full `--budget-*` triple.

```bash
curviate recruiter job create \
  --account acc_1 \
  --project-name "Backend Hiring 2026" \
  --job-title "Senior Backend Engineer" \
  --description "Remote-first team building the core platform." \
  --employment-status FULL_TIME \
  --json

curviate recruiter job publish "$PROJECT_ID" "$JOB_ID" --account acc_1 --mode FREE --json
```

### 4. List applicants in a project, then get one applicant's detail

`recruiter applicants` is project-scoped and requires `--channel-id` (the project's own
JOB_POSTING talent-pool channel). Applicant detail and résumé are also project-scoped.

```bash
curviate recruiter applicants "$PROJECT_ID" --channel-id "$CHANNEL_ID" --account acc_1 --limit 10 --json \
  | jq -r '.items[0].id' \
  | xargs -I{} curviate recruiter applicant "$PROJECT_ID" {} --account acc_1
```

### 5. Download an applicant's resume

```bash
curviate recruiter applicant resume "$PROJECT_ID" APPLICANT_ID --account acc_1 -o resume.pdf
```

### 6. Save a candidate to a project pipeline stage

```bash
curviate recruiter save-candidate "$PROJECT_ID" \
  --account acc_1 \
  --stage-id "$STAGE_ID" \
  --candidate-id AEM789
```

### 7. Search Recruiter people

```bash
curviate recruiter search people \
  --keywords "senior backend engineer" \
  --account acc_1 \
  --limit 5 --json \
  | jq -r '.items[] | "\(.id)\t\(.full_name // .headline)"'

# A pasted Recruiter search / talent-pool URL runs directly:
curviate recruiter search "https://www.linkedin.com/talent/search?..." --account acc_1 --json
```

### 8. Get a Recruiter-enriched profile, then start a chat with them

`recruiter message new` is JSON-only and requires `--subject` and `--signature`.

```bash
curviate recruiter profile "https://www.linkedin.com/in/example" --account acc_1 --json

curviate recruiter message new \
  --to AEM789 \
  --account acc_1 \
  --subject "A role you'd be a great fit for" \
  --signature "- Alex, Talent Team" \
  "Hi, I came across your profile and think you'd be a great fit for a role we're hiring for."
```

### 9. List your postings, and get any public job posting through the Recruiter lens

Unlike `recruiter jobs` (which lists postings you manage), `recruiter job get` retrieves the full
detail of *any* public LinkedIn job posting, the Recruiter-seated counterpart to the top-level
`job get` command:

```bash
curviate recruiter jobs --account acc_1 --limit 10 --json \
  | jq -r '.items[] | "\(.id)\t\(.title)\t\(.state)"'

curviate recruiter job get "https://www.linkedin.com/jobs/view/4428113858" --account acc_1 --json
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Unexpected error |
| 2 | Usage / argument error |
| 3 | Authentication or authorization failure |
| 4 | Resource not found |
| 5 | Feature requires an add-on or higher plan |

## License

MIT. See [LICENSE](LICENSE).
