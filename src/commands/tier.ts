/**
 * `curviate tier`: whether the Team holds the plan and what it has now (`GET /v1/billing/tier`).
 * Every role may read it. JSON is the API's object; human mode is one line per field.
 */
import { defineCommand } from "citty";
import { DESCRIPTIONS } from "./descriptions.js";
import { READ_SINGLE_FLAGS, readOnly } from "../lib/global-flags.js";
import { renderSuccess } from "../lib/output.js";
import { readableObject } from "../lib/paginate.js";
import { fail, outputOpts, rootClient, type RootFlags } from "../lib/root-command.js";

type Until = { tier: string; expires_at?: string | null } | null;
type Tier = {
  tier: string | null;
  bought_tier: string | null;
  period: string | null;
  trial: Until;
  override: Until;
  features: string[];
};

const at = (u: Until) => (u ? `${u.tier}${u.expires_at ? ` until ${u.expires_at}` : ""}` : "none");

export function humanTier(t: Tier): string {
  return [
    `tier           ${t.tier ?? "none"}`,
    `bought         ${t.bought_tier ?? "none"}${t.period ? ` (${t.period})` : ""}`,
    `trial          ${at(t.trial)}`,
    `override       ${at(t.override)}`,
    `features       ${t.features.length ? t.features.join(", ") : "none"}`,
    `email          ${t.tier ? "included; it sends once a Mailbox is connected (`curviate mailbox list`, `curviate doctor`)" : "needs the plan"}`,
  ].join("\n") + "\n";
}

export const tierCommand = defineCommand({
  meta: {
    name: "tier",
    description: DESCRIPTIONS.tier,
    risk: "read",
    examples: ["curviate tier", "curviate tier --json"],
  },
  args: readOnly(READ_SINGLE_FLAGS),
  async run({ args }) {
    const f = args as RootFlags;
    const c = await rootClient(f);
    try {
      const t = readableObject(await c.tier.get()) as unknown as Tier;
      const opts = outputOpts(f);
      if (opts.json || f.fields) renderSuccess(t, opts, process);
      else process.stdout.write(humanTier(t));
    } catch (err) {
      await fail(err, f);
    }
  },
});
