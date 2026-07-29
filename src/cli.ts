import { defineCommand } from "citty";
import { createRequire } from "node:module";
import { dispatch } from "./dispatch.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Read version from package.json at runtime (single source of truth).
const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkg = require(resolve(__dirname, "../package.json")) as {
  version: string;
  name: string;
};

// ---------------------------------------------------------------------------
// Lazy-loaded subcommand loaders.
// Each loader imports the command module ONLY when the subcommand is invoked.
// Resolving --help, --version, or an unknown subcommand path does NOT trigger
// any of these imports and does NOT construct a Curviate client.
// ---------------------------------------------------------------------------

const main = defineCommand({
  meta: {
    name: "curviate",
    version: pkg.version,
    description: "Official command-line interface for the Curviate API.",
  },

  // Subcommand registry — names and descriptions are static for help rendering;
  // the handler implementation is loaded lazily on first invocation.
  subCommands: {
    login: () =>
      import("./commands/login.js").then((m) => m.loginCommand),
    config: () =>
      import("./commands/config.js").then((m) => m.configCommand),

    // ---------------------------------------------------------------------------
    // Noun groups — lazy-loaded on first invocation.
    // ---------------------------------------------------------------------------
    profile: () =>
      import("./commands/profile.js").then((m) => m.profileCommand),
    company: () =>
      import("./commands/company.js").then((m) => m.companyCommand),
    job: () =>
      import("./commands/job.js").then((m) => m.jobCommand),
    connect: () =>
      import("./commands/connect.js").then((m) => m.connectCommand),
    search: () =>
      import("./commands/search.js").then((m) => m.searchCommand),
    inbox: () =>
      import("./commands/inbox.js").then((m) => m.inboxCommand),
    inboxes: () =>
      import("./commands/inboxes.js").then((m) => m.inboxesCommand),
    message: () =>
      import("./commands/message.js").then((m) => m.messageCommand),
    post: () =>
      import("./commands/post.js").then((m) => m.postCommand),
    comment: () =>
      import("./commands/comment.js").then((m) => m.commentCommand),
    account: () =>
      import("./commands/account.js").then((m) => m.accountCommand),
    webhook: () =>
      import("./commands/webhook.js").then((m) => m.webhookCommand),
    "sales-nav": () =>
      import("./commands/sales-nav.js").then((m) => m.salesNavCommand),
    recruiter: () =>
      import("./commands/recruiter.js").then((m) => m.recruiterCommand),
    group: () =>
      import("./commands/group.js").then((m) => m.groupCommand),
    feed: () =>
      import("./commands/feed.js").then((m) => m.feedCommand),
    notification: () =>
      import("./commands/notification.js").then((m) => m.notificationCommand),
  },

  async run() {
    // Root invocation with no subcommand: print the top-level usage via citty.
    // dispatch() reaches here only when no subcommand keyword was given.
    const { runMain } = await import("citty");
    await runMain(main, { rawArgs: ["--help"] });
  },
});

// Custom dispatcher (see src/dispatch.ts) — works around citty 0.1.6's
// positional+subCommand routing collision so bare intent-shaped forms
// (`connect <slug>`, `profile <url>`, `message <chat> "text"`) and subcommands
// both route correctly. Do NOT replace with a plain `runMain(main)`.
void dispatch(main, process.argv.slice(2));
