/** `curviate domain check`: a sending domain's DNS health. Root-scoped (`curviate.domains.check`), one API call. */
import { defineCommand } from "citty";
import { DESCRIPTIONS } from "./descriptions.js";
import { READ_SINGLE_FLAGS, readOnly } from "../lib/global-flags.js";
import { renderSuccess } from "../lib/output.js";
import { buildPreviewOutput } from "../lib/preview.js";
import { readableObject } from "../lib/paginate.js";
import { fail, outputOpts, rootClient, usage, type RootFlags } from "../lib/root-command.js";

type Flags = RootFlags & { domain?: string; now?: boolean };

const checkCmd = defineCommand({
  meta: {
    name: "check",
    description:
      "A sending domain's checks as last run (daily): mx, spf, dkim, dmarc and tracking, each pass, fail or unknown (a failed lookup, or a DKIM selector not known yet, is never a fail), with the tracking record to add and any blocklists. " +
      "--now runs them now: DNS lookups only, nothing is sent and no Mailbox is contacted. A check warns and never stops sending. A domain none of your Team's Mailboxes is on is DOMAIN_NOT_FOUND.",
    risk: "read",
    output: ["The domain with its checks. Without --now the answer is the last daily run; with --now, the run just made."],
    errors: { DOMAIN_NOT_FOUND: "none of your Team's Mailboxes is on this domain (another Team's domain answers the same)." },
    seeAlso: ["curviate mailbox list"],
    examples: ["curviate domain check acme.example", "curviate domain check acme.example --now"],
  },
  args: {
    ...readOnly(READ_SINGLE_FLAGS),
    domain: { type: "positional" as const, description: "The domain, for example acme.example: the part of a Mailbox address after the @." },
    now: { type: "boolean", description: "Run the checks now instead of reading the last daily run." },
  },
  async run({ args }) {
    const f = args as Flags;
    const domain = String(f.domain ?? "").trim();
    if (domain === "") usage("name the domain, for example acme.example.");
    if (f.preview) {
      process.stdout.write(JSON.stringify(buildPreviewOutput({ method: "domains.check", args: { domain }, body: f.now ? { now: true } : {} })) + "\n");
      return;
    }
    const c = await rootClient(f);
    try {
      renderSuccess(readableObject(await c.domains.check(domain, { now: f.now === true })), outputOpts(f), process);
    } catch (err) {
      await fail(err, f);
    }
  },
});

export const domainCommand = defineCommand({
  meta: { name: "domain", description: DESCRIPTIONS["domain"] },
  subCommands: { check: checkCmd },
  async run() {
    const { showHelp } = await import("../lib/examples.js");
    await showHelp(domainCommand, ["curviate", "domain"]);
  },
});
