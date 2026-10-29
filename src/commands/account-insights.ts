/**
 * `curviate account overview` and `curviate account metrics`: one Account's
 * performance read and its daily profile metrics, from what Curviate stored
 * (no LinkedIn call). Kept apart from `account.ts` (connection management).
 */
import { defineCommand } from "citty";
import type { Curviate } from "@curviate/sdk";
import { READ_SINGLE_FLAGS, readOnly } from "../lib/global-flags.js";
import { renderSuccess } from "../lib/output.js";
import { fail, listFlag, outputOpts, rootClient, type RootFlags } from "../lib/root-command.js";
import { GRAMMAR_ARGS, WINDOW_ARGS, grammarParams, renderOverview, windowParams, type AnalyticsFlags } from "./analytics.js";
import { print, table } from "../lib/table.js";

type Flags = AnalyticsFlags & RootFlags;
type Row = Record<string, unknown>;

async function runOverview(c: Curviate, f: Flags): Promise<void> {
  const q: Row = { ...windowParams(f), ...grammarParams(f) };
  if (f.motions !== undefined) q["motion_id"] = listFlag("motions", f.motions);
  if (f.origin !== undefined) q["origin"] = listFlag("origin", f.origin);
  try {
    const body = (await c.accounts.overview(String(f.accountId ?? ""), q as never)) as unknown as Row;
    return outputOpts(f).json ? renderSuccess(body, outputOpts(f), process) : renderOverview(body);
  } catch (err) {
    await fail(err, f);
  }
}

async function runMetrics(c: Curviate, f: Flags): Promise<void> {
  const { from, to, timezone } = windowParams(f);
  try {
    const body = (await c.accounts.metrics(String(f.accountId ?? ""), { from, to, timezone } as never)) as unknown as { items?: Row[] };
    if (outputOpts(f).json) return renderSuccess(body, outputOpts(f), process);
    print(table(["DATE", "CONNECTIONS", "FOLLOWERS", "VIEWERS 90D", "SEARCH/WEEK", "POST IMPR 7D", "SSI"],
      (body.items ?? []).map((d) => [d["date"], d["connections"], d["followers"], d["profile_viewers_90d"], d["search_appearances_week"], d["post_impressions_7d"], (d["ssi"] as Row | null)?.["score"]])));
  } catch (err) {
    await fail(err, f);
  }
}

const online = (fn: (c: Curviate, f: Flags) => Promise<void>) => async ({ args }: { args: unknown }) => {
  const f = args as Flags;
  await fn(await rootClient(f), f);
};

const ACCOUNT_ID = { type: "positional" as const, description: "The Account (acc_...)." };

export const accountOverviewCommand = defineCommand({
  meta: {
    name: "overview",
    description:
      "One Account's overview over a window: profile and status, latest metrics, outcomes so far (acceptance, reply, InMail reply), budget rows used today, its Motions, and flags with the next command to run. Each Contact counts once per Account.",
    risk: "read",
    output: ["A compact table by default; --json (or piped) prints the API body."],
    seeAlso: ["curviate account metrics", "curviate analytics get"],
    examples: ["curviate account overview acc_YOUR_ACCOUNT_ID", "curviate account overview acc_YOUR_ACCOUNT_ID --range 90d --compare previous_period"],
  },
  args: {
    ...readOnly(READ_SINGLE_FLAGS),
    accountId: ACCOUNT_ID,
    ...WINDOW_ARGS,
    motions: { type: "string" as const, description: "Only these Motions, comma list (mot_...)." },
    origin: { type: "string" as const, description: "Who sent the actions: a comma list of motion, unibox, api; direct is an alias for unibox and api." },
    ...GRAMMAR_ARGS,
  },
  run: online(runOverview),
});

export const accountMetricsCommand = defineCommand({
  meta: {
    name: "metrics",
    description: "One Account's daily profile metrics, one row per day: connections, followers, profile viewers (90 days), search appearances (week), post impressions (7 days), SSI and its pillars.",
    risk: "read",
    examples: ["curviate account metrics acc_YOUR_ACCOUNT_ID --from 2026-10-01 --to 2026-10-28"],
  },
  args: { ...readOnly(READ_SINGLE_FLAGS), accountId: ACCOUNT_ID,
    from: { type: "string" as const, description: "First day, YYYY-MM-DD, inclusive, in --timezone." },
    to: { type: "string" as const, description: "Last day, YYYY-MM-DD, inclusive, in --timezone." },
    timezone: WINDOW_ARGS.timezone,
  },
  run: online(runMetrics),
});
