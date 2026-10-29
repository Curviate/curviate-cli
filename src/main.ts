/**
 * The command registry, importable without running the CLI (the manifest test
 * walks it). `cli.ts` is the entry point that dispatches.
 */
import { defineCommand } from "citty";
import { lazy } from "./commands/descriptions.js";
import { createRequire } from "node:module";
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

export const main = defineCommand({
  meta: {
    name: "curviate",
    version: pkg.version,
    description: "Official command-line interface for the Curviate API.",
    seeAlso: [
      "Skill plugin (judgement, playbooks): https://github.com/curviate/curviate-plugin",
      "Reference: https://docs.curviate.com/reference/cli",
    ],
  },

  // Subcommand registry, names and descriptions are static for help rendering;
  // the handler implementation is loaded lazily on first invocation.
  subCommands: {
    setup: lazy("setup", () => import("./commands/setup.js").then((m) => m.setupCommand)),
    doctor: lazy("doctor", () => import("./commands/doctor.js").then((m) => m.doctorCommand)),
    login: lazy("login", () => import("./commands/login.js").then((m) => m.loginCommand)),
    config: lazy("config", () => import("./commands/config.js").then((m) => m.configCommand)),

    account: lazy("account", () => import("./commands/account.js").then((m) => m.accountCommand)),
    motion: lazy("motion", () => import("./commands/motion.js").then((m) => m.motionCommand)),
    enrollment: lazy("enrollment", () => import("./commands/enrollment.js").then((m) => m.enrollmentCommand)),
    contact: lazy("contact", () => import("./commands/contact.js").then((m) => m.contactCommand)),
    "do-not-contact": lazy("do-not-contact", () => import("./commands/do-not-contact.js").then((m) => m.doNotContactCommand)),
    unibox: lazy("unibox", () => import("./commands/unibox.js").then((m) => m.uniboxCommand)),
    network: lazy("network", () => import("./commands/network.js").then((m) => m.networkCommand)),
    analytics: lazy("analytics", () => import("./commands/analytics.js").then((m) => m.analyticsCommand)),
    notification: lazy("notification", () => import("./commands/notifications.js").then((m) => m.notificationsCommand)),
    export: lazy("export", () => import("./commands/export.js").then((m) => m.exportCommand)),
    billing: lazy("billing", () => import("./commands/billing.js").then((m) => m.billingCommand)),
    tier: lazy("tier", () => import("./commands/tier.js").then((m) => m.tierCommand)),
    team: lazy("team", () => import("./commands/team.js").then((m) => m.teamCommand)),
    incoming: lazy("incoming", () => import("./commands/incoming.js").then((m) => m.incomingCommand)),
    beta: lazy("beta", () => import("./commands/beta-consent.js").then((m) => m.betaCommand)),
    webhook: lazy("webhook", () => import("./commands/webhook.js").then((m) => m.webhookCommand)),
    // The LinkedIn building blocks. Reserved product groups
    // (unibox, network, analytics, team) land
    // between `enrollment` and `webhook` with their owning specs.
    core: lazy("core", () => import("./commands/core.js").then((m) => m.coreCommand)),
  },

  async run() {
    // Root invocation with no subcommand: the root help (dispatch() reaches
    // here only when no subcommand keyword was given).
    const { showHelp } = await import("./lib/examples.js");
    await showHelp(main, ["curviate"]);
  },
});
