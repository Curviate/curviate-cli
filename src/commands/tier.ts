/**
 * `curviate tier`: the Team's Tier and what it includes now (`GET /v1/billing/tier`).
 * Every role may read it. JSON is the API's object; human mode is one line per field.
 */
import { defineCommand } from "citty";
import { DESCRIPTIONS } from "./descriptions.js";
import { READ_SINGLE_FLAGS, readOnly } from "../lib/global-flags.js";
import { renderSuccess } from "../lib/output.js";
import { readableObject } from "../lib/paginate.js";
import { fail, outputOpts, rootClient, type RootFlags } from "../lib/root-command.js";

type Until = { tier: string; expires_at?: string | null; effective_at?: string; requested_at?: string | null } | null;
type Tier = {
  tier: string | null;
  bought_tier: string | null;
  period: string | null;
  trial: Until;
  override: Until;
  pending: Until;
  features: string[];
  early_access: Array<{ tier: string; requested_at: string | null }>;
};

const at = (u: Until, key: "expires_at" | "effective_at") => (u ? `${u.tier}${u[key] ? ` until ${u[key]}` : ""}` : "none");

export function humanTier(t: Tier): string {
  return [
    `tier           ${t.tier ?? "none"}`,
    `bought         ${t.bought_tier ?? "none"}${t.period ? ` (${t.period})` : ""}`,
    `trial          ${at(t.trial, "expires_at")}`,
    `override       ${at(t.override, "expires_at")}`,
    `pending        ${t.pending ? `${t.pending.tier} from ${t.pending.effective_at}` : "none"}`,
    `features       ${t.features.length ? t.features.join(", ") : "none"}`,
    `early access   ${t.early_access.map((e) => `${e.tier} (${e.requested_at ? `requested ${e.requested_at}` : "not requested"})`).join(", ") || "none"}`,
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
