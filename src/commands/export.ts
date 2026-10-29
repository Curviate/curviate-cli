/**
 * `curviate export`: a background export job (started by `curviate analytics
 * export --job`): read its status, download its file. Only the person who
 * started it can; the file expires 24 hours after it is ready.
 */
import { defineCommand } from "citty";
import type { Curviate } from "@curviate/sdk";
import { DESCRIPTIONS } from "./descriptions.js";
import { GLOBAL_FLAGS, READ_SINGLE_FLAGS, readOnly } from "../lib/global-flags.js";
import { renderSuccess } from "../lib/output.js";
import { fail, outputOpts, rootClient, usage, type RootFlags } from "../lib/root-command.js";
import { downloadBinary } from "../lib/client.js";
import { writeExport } from "../lib/export-file.js";

type ExportFlags = RootFlags & { id?: string; output?: string };

const ERRORS = {
  EXPORT_NOT_READY: "the export is queued, running or failed: read its status with `curviate export get <export_id>`.",
  EXPORT_EXPIRED: "the file expired 24 hours after it was ready: run the export again.",
  EXPORT_REMOVED: "the export was removed because a Contact was deleted: run it again.",
};

async function runGet(c: Curviate, f: ExportFlags): Promise<void> {
  try {
    renderSuccess(await c.exports.get(String(f.id ?? "")), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

async function runDownload(c: Curviate, f: ExportFlags): Promise<void> {
  if (f.output === undefined && process.stdout.isTTY) usage("pass -o <file> to save the export, or redirect stdout.");
  try {
    const bytes = await downloadBinary(() => c.exports.download(String(f.id ?? "")));
    await writeExport(f.output, new Uint8Array(bytes as ArrayBuffer));
  } catch (err) {
    await fail(err, f);
  }
}

const online = (fn: (c: Curviate, f: ExportFlags) => Promise<void>) => async ({ args }: { args: unknown }) => {
  const f = args as ExportFlags;
  await fn(await rootClient(f), f);
};

const ID = { type: "positional" as const, description: "The export id (exp_...), from `curviate analytics export --job`." };

const getCmd = defineCommand({
  meta: {
    name: "get",
    description: "One export job: status (queued, running, ready, failed, expired, removed), rows, bytes and when the file expires.",
    risk: "read",
    errors: { RESOURCE_NOT_FOUND: "no export with this id that you started." },
    examples: ["curviate export get exp_YOUR_EXPORT_ID"],
  },
  args: { ...readOnly(READ_SINGLE_FLAGS), id: ID },
  run: online(runGet),
});

const downloadCmd = defineCommand({
  meta: {
    name: "download",
    description: "Download a ready export's file, byte for byte, to a file (mode 0600) or stdout.",
    risk: "read",
    errors: ERRORS,
    output: ["The file's bytes only: CSV, JSON, NDJSON or a ZIP of several tables."],
    examples: ["curviate export download exp_YOUR_EXPORT_ID -o analytics.zip"],
  },
  args: {
    "api-key": GLOBAL_FLAGS["api-key"],
    profile: GLOBAL_FLAGS.profile,
    team: GLOBAL_FLAGS.team,
    "base-url": GLOBAL_FLAGS["base-url"],
    timeout: GLOBAL_FLAGS.timeout,
    id: ID,
    output: { type: "string" as const, alias: "o", description: "File to write (mode 0600), or - for stdout." },
  },
  run: online(runDownload),
});

export const exportCommand = defineCommand({
  meta: { name: "export", description: DESCRIPTIONS.export },
  subCommands: { get: getCmd, download: downloadCmd },
  async run() {
    const { showHelp } = await import("../lib/examples.js");
    await showHelp(exportCommand, ["curviate", "export"]);
  },
});
