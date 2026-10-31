/**
 * `curviate beta`: the Team's persisted beta consent. Without it a gated
 * operation needs `--beta` on each call (the `X-Curviate-Beta` header).
 */
import { defineCommand } from "citty";
import type { Curviate } from "@curviate/sdk";
import { DESCRIPTIONS } from "./descriptions.js";
import { READ_SINGLE_FLAGS, WRITE_SINGLE_FLAGS, readOnly } from "../lib/global-flags.js";
import { renderSuccess } from "../lib/output.js";
import { buildPreviewOutput } from "../lib/preview.js";
import { fail, outputOpts, rootClient, usage, type RootFlags } from "../lib/root-command.js";

type Flags = RootFlags & { enabled?: string };

async function runStatus(c: Curviate, f: Flags): Promise<void> {
  try {
    renderSuccess(await c.tenant.beta.get(), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

async function runUpdate(c: Curviate, f: Flags): Promise<void> {
  if (f.enabled !== "true" && f.enabled !== "false") usage("--enabled takes true or false.");
  const body = { beta_enabled: f.enabled === "true" };
  if (f.preview) return void process.stdout.write(JSON.stringify(buildPreviewOutput({ method: "tenant.beta.set", args: {}, body })) + "\n");
  try {
    renderSuccess(await c.tenant.beta.set(body), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

const online = (fn: (c: Curviate, f: Flags) => Promise<void>) => async ({ args }: { args: unknown }) => {
  const f = args as Flags;
  await fn(await rootClient(f), f);
};

const statusCmd = defineCommand({
  meta: { name: "status", description: "Whether beta operations run for your Team without --beta.", risk: "read", examples: ["curviate beta status"] },
  args: readOnly(READ_SINGLE_FLAGS),
  run: online(runStatus),
});

const updateCmd = defineCommand({
  meta: {
    name: "update",
    description: "Turn the Team's beta consent on or off. Owners only. On: beta operations run without --beta for every key of the Team.",
    risk: "write",
    rules: {
      changes: "Sets the Team's beta consent.",
      visible_to: "Your Team.",
      budget_rows: [],
      retry: "Safe to repeat: the same setting again.",
      undo: "Run it with the other value.",
    },
    errors: { INSUFFICIENT_ROLE: "only an Owner can change it." },
    examples: ["curviate beta update --enabled true"],
  },
  args: { ...WRITE_SINGLE_FLAGS, enabled: { type: "string" as const, required: true, description: "true or false." } },
  run: online(runUpdate),
});

export const betaCommand = defineCommand({
  meta: { name: "beta", description: DESCRIPTIONS.beta },
  subCommands: { status: statusCmd, update: updateCmd },
  async run() {
    const { showHelp } = await import("../lib/examples.js");
    await showHelp(betaCommand, ["curviate", "beta"]);
  },
});
