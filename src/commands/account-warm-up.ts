/**
 * `curviate account warm-up on|off <account>`: the Account's warm-up switch,
 * one `PATCH /v1/{account_id}/safety-policy` with `warm_up: { enabled }`.
 */
import { defineCommand } from "citty";
import { WRITE_SINGLE_FLAGS } from "../lib/global-flags.js";
import { renderSuccess } from "../lib/output.js";
import { buildPreviewOutput } from "../lib/preview.js";
import { fail, outputOpts, rootClient, type RootFlags } from "../lib/root-command.js";

type Flags = RootFlags & { accountId?: string };
type WarmUp = { enabled?: boolean; state?: string; factor?: number; dormant?: boolean };

async function run(f: Flags, enabled: boolean): Promise<void> {
  const accountId = String(f.accountId ?? "");
  if (f.preview) {
    process.stdout.write(JSON.stringify(buildPreviewOutput({ method: "accounts.updateSafetyPolicy", args: { accountId }, body: { warm_up: { enabled } } })) + "\n");
    return;
  }
  const c = await rootClient(f);
  try {
    const policy = await c.accounts.updateSafetyPolicy(accountId, { warm_up: { enabled } });
    if (outputOpts(f).json) return renderSuccess(policy, outputOpts(f), process);
    const w = (policy as { warm_up?: WarmUp }).warm_up ?? {};
    process.stdout.write(`Warm-up ${w.enabled ? "on" : "off"} for ${accountId}: state ${w.state ?? "unknown"}, factor ${w.factor ?? "unknown"}${w.dormant ? ", dormant" : ""}.\n`);
  } catch (err) {
    await fail(err, f);
  }
}

const switchCommand = (name: "on" | "off") => defineCommand({
  meta: {
    name,
    description: name === "on"
      ? "Turn the Account's warm-up on: the ramp holds its ceilings below the limits after a connect or a quiet spell. Prints the resulting warm-up."
      : "Turn the Account's warm-up off: the connect and quiet ramps no longer apply (recovery after a LinkedIn restriction still does). Prints the resulting warm-up.",
    risk: "write",
    rules: {
      changes: `The Account's warm-up switch is set ${name}; every budget row's effective ceiling follows.`,
      visible_to: "Everyone using this workspace's key. Nothing is posted on LinkedIn.",
      budget_rows: [],
      retry: "Safe to repeat: the switch ends in the same state.",
      undo: `Run \`curviate account warm-up ${name === "on" ? "off" : "on"} <account>\`.`,
      blast_radius: "One Account's pace.",
    },
    seeAlso: ["curviate account get"],
    examples: [`curviate account warm-up ${name} acc_YOUR_ACCOUNT_ID`],
  },
  args: { ...WRITE_SINGLE_FLAGS, accountId: { type: "positional" as const, description: "The Account (acc_...)." } },
  async run({ args }) {
    await run(args as Flags, name === "on");
  },
});

export const accountWarmUpCommand = defineCommand({
  meta: { name: "warm-up", description: "Turn an Account's warm-up ramp on or off." },
  subCommands: { on: switchCommand("on"), off: switchCommand("off") },
  async run() {
    process.stderr.write("Usage: curviate account warm-up on|off <account>\n");
  },
});
