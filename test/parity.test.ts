/**
 * SDK parity: every SDK public resource method is wired to exactly one CLI
 * command, or named in KNOWN_GAP_METHODS (REST + SDK only by product ruling).
 * The manifest maps a CLI path to "namespace.method"; the SDK's method set is
 * read off a client instance, so a method the SDK adds fails here until it has a
 * command or a ruling. Convenience routes (`profile me`, `profile ... --posts`,
 * ...) reuse a canonical command's method and carry no entry.
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Manifest — CLI command path → "namespace.method"
// ---------------------------------------------------------------------------
//
// Format: "cli command path" → "sdkNamespace.methodName"
// The left side is documentation only; the right side is machine-checked.
// `webhook verify`, `login`, and `config *` are intentionally absent — they
// call no SDK resource method (offline HMAC / local config management).

const PARITY_MANIFEST: Record<string, string> = {
  // accounts (5)
  "account list":       "accounts.list",
  "account get":        "accounts.get",
  "account seats":      "accounts.listSeats",
  "account update":     "accounts.update",
  "account disconnect": "accounts.disconnect",
  "account warm-up on|off": "accounts.updateSafetyPolicy",

  // webhooks (6)
  "webhook create": "webhooks.create",
  "webhook list":   "webhooks.list",
  "webhook events": "webhooks.listEvents",
  "webhook get":    "webhooks.get",
  "webhook update": "webhooks.update",
  "webhook delete": "webhooks.delete",

  // drafts (7). `draft create` / `draft update` also call uploadAttachment for files over 5 MiB.
  "draft create":  "drafts.create",
  "draft list":    "drafts.list",
  "draft get":     "drafts.get",
  "draft update":  "drafts.update",
  "draft delete":  "drafts.delete",
  "draft publish": "drafts.publish",
  "draft create/update --attach (over 5 MiB)": "drafts.uploadAttachment",

  // auth (5) — mounted under the `account` noun (intent-shaped tree)
  "account link":                 "auth.intent",
  "account checkpoint solve":     "auth.solveCheckpoint",
  "account checkpoint request":   "auth.requestCheckpoint",
  "account checkpoint poll":      "auth.pollCheckpoint",
  "account connect-session poll": "auth.getSession",

  // messaging (13) — split across the `inbox` and `message` nouns
  "inbox list":             "messaging.listChats",
  "inbox get":              "messaging.getChat",
  "inbox messages":         "messaging.listMessages",
  "inbox mark-read":        "messaging.markChatRead",
  "inbox search":           "messaging.searchChats",
  "message new":            "messaging.startChat",
  "message send":           "messaging.sendMessage",
  "message get":            "messaging.getMessage",
  "message edit":           "messaging.editMessage",
  "message delete":         "messaging.deleteMessage",
  "message react":          "messaging.addReaction",
  "message attachment":     "messaging.getAttachment",
  "message inmail":         "messaging.sendInMail",

  // users (9) — mounted under the `profile` noun (+ inmail-balance under message)
  "profile get":            "users.get",
  "profile relations":      "users.listRelations",
  "profile followers":      "users.listFollowers",
  "profile following":      "users.listFollowing",
  "profile follow":         "users.follow",
  "profile unfollow":       "users.unfollow",
  "profile update":         "users.update",
  "profile endorse":        "users.endorseSkill",
  "message inmail-balance": "users.getInMailCredits",

  // profile (4) — new account-scoped insight namespace, distinct from `users` above
  "profile subscription": "profile.subscription",
  "profile analytics":    "profile.analytics",
  "profile visitors":     "profile.visitors",
  "profile ssi":          "profile.ssi",

  // invites (6) — mounted under the `connect` noun
  "connect send":     "invites.send",
  "connect sent":     "invites.listSent",
  "connect received": "invites.listReceived",
  "connect accept":   "invites.accept",
  "connect decline":  "invites.decline",
  "connect cancel":   "invites.cancel",

  // search (9)
  "search":                    "search.fromUrl",
  "search people":             "search.people",
  "search companies":          "search.companies",
  "search posts":               "search.posts",
  "search jobs":                "search.jobs",
  "search parameters":          "search.getParameters",
  "search groups":               "search.groups",
  "search services":             "search.services",
  "search service-parameters":   "search.getServiceParameters",

  // posts (12) — `comment list` wraps posts.listComments (the comment group)
  "post get":            "posts.get",
  "post create":         "posts.create",
  "post react":          "posts.react",
  "post reactions":      "posts.listReactions",
  "post delete":         "posts.delete",
  "post unreact":        "posts.unreact",
  "post saved":          "posts.listSaved",
  "post save":           "posts.save",
  "post unsave":         "posts.unsave",
  "post user-posts":     "posts.listUserPosts",
  "post user-reactions": "posts.listUserReactions",
  "comment list":        "posts.listComments",

  // salesNavigator (12)
  "sales-nav search people":       "salesNavigator.searchPeople",
  "sales-nav search companies":    "salesNavigator.searchCompanies",
  "sales-nav search parameters":   "salesNavigator.getParameters",
  "sales-nav search":              "salesNavigator.searchFromUrl",
  "sales-nav message new":         "salesNavigator.startChat",
  "sales-nav profile":             "salesNavigator.getProfile",
  "sales-nav save-lead":           "salesNavigator.saveLead",
  "sales-nav account-lists":       "salesNavigator.accountLists",
  "sales-nav lead-lists":          "salesNavigator.leadLists",
  "sales-nav browse-account-list": "salesNavigator.browseAccountList",
  "sales-nav browse-lead-list":    "salesNavigator.browseLeadList",
  "sales-nav save-account":        "salesNavigator.saveAccount",

  // recruiter (23)
  "recruiter profile":             "recruiter.getProfile",
  "recruiter message new":         "recruiter.startChat",
  "recruiter search people":       "recruiter.searchPeople",
  "recruiter search parameters":   "recruiter.searchParameters",
  "recruiter search":              "recruiter.searchFromUrl",
  "recruiter talent-search":       "recruiter.searchTalentPool",
  "recruiter projects":            "recruiter.listProjects",
  "recruiter project":             "recruiter.getProject",
  "recruiter project update":      "recruiter.updateProject",
  "recruiter pipeline":            "recruiter.listPipeline",
  "recruiter project-job get":     "recruiter.getProjectJob",
  "recruiter project-job create":  "recruiter.createProjectJob",
  "recruiter project-job budget":  "recruiter.getProjectJobBudget",
  "recruiter project-job update":  "recruiter.updateProjectJob",
  "recruiter save-candidate":      "recruiter.saveCandidate",
  "recruiter applicants":          "recruiter.listApplicants",
  "recruiter jobs":                "recruiter.listJobs",
  "recruiter job create":          "recruiter.createJob",
  "recruiter job publish":         "recruiter.publishJob",
  "recruiter job close":           "recruiter.closeJob",
  "recruiter job get":             "recruiter.getJob",
  "recruiter applicant":           "recruiter.getApplicant",
  "recruiter applicant resume":    "recruiter.downloadResume",

  // jobs (10)
  "job get":              "jobs.get",
  "job list":             "jobs.list",
  "job create":           "jobs.create",
  "job update":           "jobs.update",
  "job budget":           "jobs.getBudget",
  "job publish":          "jobs.publish",
  "job close":            "jobs.close",
  "job applicants":       "jobs.listApplicants",
  "job applicant get":    "jobs.getApplicant",
  "job applicant resume": "jobs.downloadResume",

  // companies (14)
  "company get":                 "companies.get",
  "company employees":           "companies.employees",
  "company posts":               "companies.posts",
  "company jobs":                "companies.jobs",
  "company invitable-followers": "companies.invitableFollowers",
  "company follow-invite":       "companies.followInvite",
  "company reply":               "companies.sendMessage",
  "company managed":             "companies.managed",
  "company followers":           "companies.followers",
  "company chats":               "companies.chats",
  "company chat":                "companies.chat",
  "company messages":            "companies.messages",
  "company message":             "companies.message",
  "company search-chats":        "companies.searchChats",

  // inboxes (2) — Beta inbox-discovery namespace
  "inboxes list":  "inboxes.list",
  "inboxes chats": "inboxes.listChats",

  // comments (9)
  "comment add":       "comments.create",
  "comment reply":     "comments.reply",
  "comment edit":      "comments.edit",
  "comment delete":    "comments.delete",
  "comment replies":   "comments.listReplies",
  "comment react":     "comments.addReaction",
  "comment reactions": "comments.listReactions",
  "comment unreact":   "comments.removeReaction",
  "comment user":      "comments.listUserComments",

  // motions (13)
  "motion create":  "motions.create",
  "motion list":    "motions.list",
  "motion get":     "motions.get",
  "motion update":  "motions.update",
  "motion delete":  "motions.delete",
  "motion start":   "motions.start",
  "motion pause":   "motions.pause",
  "motion resume":  "motions.resume",
  "motion archive": "motions.archive",
  "motion preview": "motions.preview",
  "motion get --version": "motions.getSequenceVersion",
  "motion add":     "motions.addContacts",
  "motion remove":  "motions.removeContacts",

  // enrollments (11): `enrollment signal` is the CLI alias of `event` and sends to events.
  "enrollment list":     "enrollments.list",
  "enrollment get":      "enrollments.get",
  "enrollment stop":     "enrollments.stop",
  "enrollment pause":    "enrollments.pause",
  "enrollment resume":   "enrollments.resume",
  "enrollment event":    "enrollments.events",
  "enrollment reassign": "enrollments.reassign",
  "enrollment bulk":     "enrollments.bulk",
  "enrollment retry":    "enrollments.retry",

  // groups (3) — new account-scoped namespace
  "group list":    "groups.list",
  "group get":     "groups.get",
  "group members": "groups.members",

  // feed (1) — new account-scoped namespace
  "feed home": "feed.home",

  // notifications (3), account scope — LinkedIn cards (`core notification`). The root `notification list`
  // (Curviate's own, `client.notifications.list`) shares the method name, so it carries no entry here.
  "notification list":      "notifications.list",
  "notification delete":    "notifications.delete",
  "notification show-less": "notifications.showLess",

  // notifications, root (3): `notification archive|unarchive` reuse `update` (read) and carry no entry.
  "notification count":    "notifications.unreadCount",
  "notification read":     "notifications.update",
  "notification read-all": "notifications.markAllRead",

  // connectRequests (3) — mounted under `account`
  "account connect-request create": "connectRequests.create",
  "account connect-request get":    "connectRequests.get",
  "account connect-request cancel": "connectRequests.cancel",

  // network (3)
  "network list":   "network.connections.list",
  "network status": "network.syncStatus",
  "network resync": "network.resync",

  // unibox (8). `unibox messages|reply|mark` call messaging.* (convenience routes, no entry).
  "unibox list":     "unibox.list",
  "unibox get":      "unibox.get",
  "unibox unread":   "unibox.unreadCount",
  "unibox refresh":  "unibox.refresh",
  "unibox tag":      "unibox.tagContact",
  "unibox enroll":   "unibox.enroll",
  "unibox accounts": "unibox.accounts.list",
  "unibox consent":  "unibox.accounts.update",

  // analytics (5) + exports (3) + account overview/metrics (2)
  "analytics get":               "analytics.motions.list",
  "analytics get --motion":      "analytics.motions.get",
  "analytics get --view activity": "analytics.activity",
  "analytics events list":       "analytics.events.list",
  "analytics export":            "analytics.export",
  "analytics export --job":      "exports.create",
  "export get":                  "exports.get",
  "export download":             "exports.download",
  "account overview":            "accounts.overview",
  "account metrics":             "accounts.metrics",

  // webhooks (6 more), incoming (8), beta (2)
  "webhook variables":                   "webhooks.variables",
  "webhook test":                        "webhooks.test",
  "webhook redeliver":                   "webhooks.redeliver",
  "webhook rotate":                      "webhooks.rotateSecret",
  "webhook deliveries":                  "webhooks.deliveries.list",
  "webhook deliveries <delivery_id>":    "webhooks.deliveries.get",
  "incoming create":   "incomingEvents.create",
  "incoming list":     "incomingEvents.list",
  "incoming get":      "incomingEvents.get",
  "incoming update":   "incomingEvents.update",
  "incoming delete":   "incomingEvents.delete",
  "incoming rotate":   "incomingEvents.rotate",
  "incoming capture":  "incomingEvents.capture",
  "incoming arrivals": "incomingEvents.arrivals",
  "beta status": "tenant.beta.get",
  "beta update": "tenant.beta.set",

  // teams (15). `team switch` reuses teams.list; `team leave` reuses removeMember.
  "team list":           "teams.list",
  "team create":         "teams.create",
  "team get":            "teams.getCurrent",
  "team update":         "teams.updateCurrent",
  "team logo set":       "teams.setLogo",
  "team logo remove":    "teams.removeLogo",
  "team members":        "teams.listMembers",
  "team role":           "teams.updateMember",
  "team remove":         "teams.removeMember",
  "team invites create": "teams.createInvites",
  "team invites list":   "teams.listInvites",
  "team invites resend": "teams.resendInvite",
  "team invites revoke": "teams.revokeInvite",
  "team seats lend":     "billing.seats.lend",
  "team seats return":   "billing.seats.return",

  // billing (2)
  "billing invoices":     "billing.invoices.list",
  "billing invoices pdf": "billing.invoices.pdf",

  // doNotContact (5)
  "do-not-contact list":   "doNotContact.list",
  "do-not-contact get":    "doNotContact.get",
  "do-not-contact add":    "doNotContact.add",
  "do-not-contact update": "doNotContact.update",
  "do-not-contact remove": "doNotContact.remove",

  // tier (1)
  "tier": "tier.get",

  // contacts (13). `contact lists add|remove` and `contact tags add|remove` reuse updateMany (no entry).
  "contact list":               "contacts.list",
  "contact get":                "contacts.get",
  "contact create":             "contacts.upsert",
  "contact update":             "contacts.update",
  "contact delete":             "contacts.delete",
  "contact delete --ids":       "contacts.deleteMany",
  "contact tags add":           "contacts.updateMany",
  "contact enrich":             "contacts.enrich",
  "contact export":             "contacts.export",
  "contact import":             "contacts.imports.create",
  "contact imports list":       "contacts.imports.list",
  "contact imports get":        "contacts.imports.get",
  "contact imports get --outcome": "contacts.imports.rows",

  // contactLists (5), tags (3)
  "contact lists list":    "contactLists.list",
  "contact lists get":     "contactLists.get",
  "contact lists create":  "contactLists.create",
  "contact lists update":  "contactLists.update",
  "contact lists delete":  "contactLists.delete",
  "contact tags list":     "tags.list",
  "contact tags update":   "tags.update",
  "contact tags delete":   "tags.delete",
};

/**
 * Pre-existing SDK methods with no CLI command yet — see the file-header
 * doc comment. Each entry here must be a real, currently-uncovered SDK
 * method (checked below) — this is a documented backlog, not a loophole.
 */
// Seat add/cancel/revert are REST + SDK only by product ruling: no CLI
// command, ever. A deliberate gap rather than a backlog item.
const KNOWN_GAP_METHODS: readonly string[] = [
  // The deprecated SDK alias of `enrollments.events` (until 2027-01-19); `enrollment signal` sends to events.
  "enrollments.signal",
  // Team access lands with the teams commands.
  "accounts.setTeamAccess",
  "accounts.addSeats",
  "accounts.cancelSeat",
  "accounts.revertSeatCancellation",
  // safety commands land with their own spec
  "accounts.getSafetyPolicy",
  // Dashboard v2 surface: open until each group's commands land; the group
  // deletes its rows. Empty before the next release.
  // invoices
  // do-not-contact
];

// ---------------------------------------------------------------------------
// SDK method enumeration via client instance prototype inspection
// ---------------------------------------------------------------------------

/**
 * Build the full set of SDK methods in "namespace.method" form by
 * constructing a Curviate client and inspecting each resource namespace's
 * prototype. The stub API key is never used for network calls.
 */
async function buildSdkMethodSet(): Promise<Set<string>> {
  const { Curviate } = await import("@curviate/sdk");
  const client = new Curviate({ apiKey: "rdc_live_parity_test_stub" });

  // Every namespace the SDK exposes, read off the instance, so a new namespace
  // fails here until its commands land (a hand list missed whole namespaces).
  const methods = new Set<string>();
  const walk = (prefix: string, obj: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(obj)) {
      if (key === "config" || key === "ctx" || !value || typeof value !== "object") continue;
      const proto = Object.getPrototypeOf(value) as Record<string, unknown>;
      const ns = prefix ? `${prefix}.${key}` : key;
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === "constructor") continue;
        if (typeof (value as Record<string, unknown>)[name] === "function") methods.add(`${ns}.${name}`);
      }
      walk(ns, value as Record<string, unknown>);
    }
  };
  walk("", client as unknown as Record<string, unknown>);
  walk("", client.account("stub_account_id") as unknown as Record<string, unknown>);
  return methods;
}

// ---------------------------------------------------------------------------
// Parity tests
// ---------------------------------------------------------------------------

describe("SDK parity", () => {
  it("every manifest entry maps to a real SDK method", async () => {
    const sdk = await buildSdkMethodSet();
    expect(Object.entries(PARITY_MANIFEST).filter(([, m]) => !sdk.has(m)).map(([c, m]) => `"${c}" -> "${m}"`)).toEqual([]);
  });

  it("each KNOWN_GAP_METHODS entry is a real SDK method no command covers yet", async () => {
    const sdk = await buildSdkMethodSet();
    const covered = new Set(Object.values(PARITY_MANIFEST));
    expect(KNOWN_GAP_METHODS.filter((m) => !sdk.has(m) || covered.has(m))).toEqual([]);
  });

  it("every SDK method is covered by exactly one manifest entry, or is a known gap", async () => {
    const sdk = await buildSdkMethodSet();
    const by = new Map<string, string[]>();
    for (const [c, m] of Object.entries(PARITY_MANIFEST)) by.set(m, [...(by.get(m) ?? []), c]);
    expect([...sdk].filter((m) => !by.has(m) && !KNOWN_GAP_METHODS.includes(m))).toEqual([]);
    expect([...by].filter(([, paths]) => paths.length > 1).map(([m, paths]) => `${m} -> ${paths.join(", ")}`)).toEqual([]);
  });
});
