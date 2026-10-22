/**
 * Group descriptions, the one source for both the group's own help and the
 * COMMANDS list of its parent. The parent lists a lazy group from here without
 * importing it, so `curviate --help` and `curviate core --help` load no
 * command module.
 */
export const DESCRIPTIONS = {
  setup: "Connect this machine to your workspace: opens the dashboard, takes the code it shows you, and saves an API key.",
  doctor: "Check that this machine can call the API: config, credential source, workspace, reachability and connected accounts.",
  login: "Save an API key to a local profile. Run `curviate core profile me` to verify.",
  config: "Manage CLI profiles and settings.",
  account: "LinkedIn account connection management.",
  motion:
    "Motions: one Sequence run for the Contacts of your Team's Contact lists, from its sending Accounts, paced on a schedule. " +
    "Create and edit drafts, preview, start, pause, resume, archive, add or remove Contacts; lint a Sequence and write a template offline. " +
    "Your Team's data: every role reads; writes need motion-send on each sending Account, and Motions need the Automate plan.",
  enrollment:
    "Enrollments: one Contact in one Motion on one Account. List and read them; pause, resume, retry a failed Step, stop, send a custom event, reassign, or act on many at once. " +
    "Your Team's data: every role reads; writes need operate on the Enrollment's Account.",
  webhook: "Webhook management and signature verification.",
  core:
    "Curviate core: LinkedIn building blocks. Each command runs one action now, from one Account, and counts against that Account's budgets. " +
    "Nothing is queued, paced or retried for you, except a Draft scheduled with `--schedule-at`, which Curviate publishes at that time (`curviate core draft create`).",
  profile: "LinkedIn profile operations.",
  company: "Fetch a company profile by URL, slug, or numeric id, and its sub-resources.",
  job: "Classic LinkedIn job-posting operations.",
  connect: "Send or manage connection invitations. Connection requests may take 10-30 seconds to appear in the recipient's received list (LinkedIn propagation delay).",
  search: "Search people, companies, posts, and jobs. Also runs a pasted search URL directly.",
  inbox: "Read LinkedIn message inbox.",
  inboxes: "Discover LinkedIn inboxes (personal + company pages) and list their conversations. Beta. See also: `curviate core inbox` (the account's own message-thread inbox), `curviate core message send` (reply to a chat).",
  message: "Send and manage LinkedIn messages. A COMPANY_ chat id (from `curviate core inboxes chats`) sends as that company page instead of yourself; see `curviate core message send --help`.",
  post: "Create and manage LinkedIn posts.",
  comment: "Comment-thread operations (list, add, reply, edit, delete, react).",
  "sales-nav": "Beta. Sales Navigator operations. Needs the LinkedIn account's own Sales Navigator subscription; no Curviate add-on. Beta operations can require consent: a human enables beta in Settings, or pass --beta for this call.",
  recruiter: "Beta. LinkedIn Recruiter operations. Needs the LinkedIn account's own Recruiter subscription; no Curviate add-on. Beta operations can require consent: a human enables beta in Settings, or pass --beta for this call.",
  group: "Read LinkedIn groups: your own membership list, one group's detail, and its member roster.",
  feed: "Read the connected account's LinkedIn home feed as agent-actionable posts.",
  notification: "Read and act on LinkedIn notification cards.",
  draft: "Drafts and scheduled posts.",
} as const;

/** A lazy subcommand loader that carries its description, so help can list it unloaded. */
export function lazy<T>(name: keyof typeof DESCRIPTIONS, load: () => Promise<T>): (() => Promise<T>) & { description: string } {
  return Object.assign(load, { description: DESCRIPTIONS[name] });
}
