/**
 * `curviate account warm-up on|off <account>`: the Account's warm-up switch,
 * one `PATCH /v1/{account_id}/safety-policy` with `warm_up: { enabled }`.
 */
import { defineCommand } from "citty";
import { WRITE_SINGLE_FLAGS } from "../lib/global-flags.js";
import { renderSuccess } from "../lib/output.js";
import { buildPreviewOutput } from "../lib/preview.js";
import { intFlag } from "../lib/int-flag.js";
import { fail, outputOpts, rootClient, usage, type RootFlags } from "../lib/root-command.js";

type Flags = RootFlags & { accountId?: string; preset?: string; start?: string; step?: string; every?: string };
type WarmUp = { enabled?: boolean; state?: string; factor?: number; dormant?: boolean; preset?: string | null; day?: number | null };

/** `on`'s ramp flags as `warm_up` keys; the server checks that Custom has all three. */
function ramp(f: Flags): Record<string, unknown> {
  const w: Record<string, unknown> = {};
  if (f.preset !== undefined) {
    if (f.preset !== "gradual" && f.preset !== "custom") usage("--preset takes gradual or custom.");
    w["preset"] = f.preset;
  }
  if (f.start !== undefined) w["start"] = intFlag("start", f.start, 5, 90);
  if (f.step !== undefined) w["step"] = intFlag("step", f.step, 1, 50);
  if (f.every !== undefined) w["every"] = intFlag("every", f.every, 1, 7);
  return w;
}

async function run(f: Flags, enabled: boolean): Promise<void> {
  const accountId = String(f.accountId ?? "");
  const warm_up = { enabled, ...(enabled ? ramp(f) : {}) };
  if (f.preview) {
    process.stdout.write(JSON.stringify(buildPreviewOutput({ method: "accounts.updateSafetyPolicy", args: { accountId }, body: { warm_up } })) + "\n");
    return;
  }
  const c = await rootClient(f);
  try {
    const policy = await c.accounts.updateSafetyPolicy(accountId, { warm_up } as never);
    if (outputOpts(f).json) return renderSuccess(policy, outputOpts(f), process);
    const w = (policy as { warm_up?: WarmUp }).warm_up ?? {};
    const at = w.preset ? `, ${w.preset}${w.day != null ? ` day ${w.day}` : ""}` : "";
    process.stdout.write(`Warm-up ${w.enabled ? "on" : "off"} for ${accountId}: state ${w.state ?? "unknown"}, factor ${w.factor ?? "unknown"}${at}${w.dormant ? ", dormant" : ""}.\n`);
  } catch (err) {
    await fail(err, f);
  }
}

const switchCommand = (name: "on" | "off") => defineCommand({
  meta: {
    name,
    description: name === "on"
      ? "Turn the Account's warm-up on: its limits ramp from now in its sending days, Gradual (30% on day 1 to 100% on day 14) or Custom (--start percent on day 1, plus --step points every --every sending days). Prints the resulting warm-up."
      : "Turn the Account's warm-up off (the default): full limits at once; recovery after a LinkedIn restriction still applies. Prints the resulting warm-up.",
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
    examples: [
      `curviate account warm-up ${name} acc_YOUR_ACCOUNT_ID`,
      ...(name === "on" ? ["curviate account warm-up on acc_YOUR_ACCOUNT_ID --preset custom --start 20 --step 10 --every 2"] : []),
    ],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    accountId: { type: "positional" as const, description: "The Account (acc_...)." },
    ...(name === "on"
      ? {
          preset: { type: "string" as const, description: "gradual (default: 30% on day 1 to 100% on day 14) or custom." },
          start: { type: "string" as const, description: "Custom: the percentage on day 1, 5 to 90." },
          step: { type: "string" as const, description: "Custom: percentage points added each time, 1 to 50." },
          every: { type: "string" as const, description: "Custom: sending days between steps, 1 to 7." },
        }
      : {}),
  },
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
