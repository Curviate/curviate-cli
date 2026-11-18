/**
 * `curviate company`: your Team's own record of a company, by LinkedIn's
 * numeric company id. Stored data only (`curviate.companies.*`): no LinkedIn
 * call. The LinkedIn company page itself is `curviate core company`.
 */
import { defineCommand } from "citty";
import type { Curviate } from "@curviate/sdk";
import { DESCRIPTIONS } from "./descriptions.js";
import { READ_SINGLE_FLAGS, WRITE_SINGLE_FLAGS, readOnly } from "../lib/global-flags.js";
import { renderSuccess } from "../lib/output.js";
import { buildPreviewOutput } from "../lib/preview.js";
import { readableObject } from "../lib/paginate.js";
import { fail, listFlag, outputOpts, rootClient, usage, type RootFlags } from "../lib/root-command.js";

type Flags = RootFlags & { id?: string; set?: string | string[]; unset?: string | string[] };

const KEY = /^[A-Za-z0-9_]{1,64}$/;
const companyId = (f: Flags) => {
  const id = String(f.id ?? "").trim();
  if (!/^\d+$/.test(id)) usage("the company id is LinkedIn's numeric company id (the `id` of `curviate core company <handle>`), for example 1234567.");
  return id;
};

/** `--set key=value` (a JSON value is parsed, anything else is text) and `--unset key`, into one `extra` merge. */
function extraBody(f: Flags): { extra: Record<string, unknown> } {
  const extra: Record<string, unknown> = {};
  for (const pair of listFlag("set", f.set)) {
    const eq = pair.indexOf("=");
    const k = eq < 0 ? "" : pair.slice(0, eq);
    if (!KEY.test(k)) usage("--set takes key=value; the key is 1 to 64 letters, digits or _.");
    const raw = pair.slice(eq + 1);
    if (raw === "") usage(`--set ${k}=: an empty value is refused; use --unset ${k} to remove the key.`);
    let v: unknown = raw;
    try {
      v = JSON.parse(raw);
    } catch {
      /* text */
    }
    extra[k] = v;
  }
  for (const k of listFlag("unset", f.unset)) {
    if (!KEY.test(k)) usage("--unset takes a key: 1 to 64 letters, digits or _.");
    extra[k] = null;
  }
  if (!Object.keys(extra).length) usage("pass --set key=value or --unset key, at least one.");
  return { extra };
}

const online = (fn: (c: Curviate, f: Flags) => Promise<void>) => async ({ args }: { args: unknown }) => {
  const f = args as Flags;
  await fn(await rootClient(f), f);
};

const ID = { type: "positional" as const, description: "LinkedIn's numeric company id, for example 1234567." };

const getCmd = defineCommand({
  meta: {
    name: "get",
    description:
      "What your Team holds for one company: the stored record (name, industry, website, size, headcount growth, location, read_at; all null when it was never read) and your own company fields. " +
      "No LinkedIn call, no budget. Every role may read it.",
    risk: "read",
    seeAlso: ["curviate company fields", "curviate core company"],
    errors: { RESOURCE_NOT_FOUND: "no Lead of your Team works at this company and your Team never read it." },
    examples: ["curviate company get 1234567"],
  },
  args: { ...readOnly(READ_SINGLE_FLAGS), id: ID },
  run: online(async (c, f) => {
    const id = companyId(f);
    try {
      renderSuccess(readableObject(await c.companies.get(id)), outputOpts(f), process);
    } catch (err) {
      await fail(err, f);
    }
  }),
});

const fieldsCmd = defineCommand({
  meta: {
    name: "fields",
    description:
      "Set or remove your Team's own fields for one company, merged by key: set once for every Lead who works there and read in a Sequence as {{company.extra.<key>}}. " +
      "Keys left out stay. At most 100 keys and 32 KiB once merged.",
    risk: "write",
    rules: {
      changes: "The company's fields in your Team; every Campaign text using {{company.extra.<key>}} reads the new value from its next send.",
      visible_to: "Your Team.",
      budget_rows: [],
      retry: "Safe to repeat: the same values again.",
      undo: "Run it again with the previous values, or --unset the key.",
    },
    errors: { RESOURCE_NOT_FOUND: "no Lead of your Team works at this company and your Team never read it.", INVALID_REQUEST: "a key outside the pattern, or the fields would pass 100 keys or 32 KiB once merged." },
    seeAlso: ["curviate company get", "curviate campaign lint"],
    examples: ["curviate company fields 1234567 --set tier=A --set owner=\"Ana Lopez\"", "curviate company fields 1234567 --unset owner"],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    id: ID,
    set: { type: "string" as const, description: "key=value, repeatable. A JSON value (a number, true, a list) is stored as JSON, anything else as text." },
    unset: { type: "string" as const, description: "A key to remove, repeatable or a comma list." },
  },
  run: async ({ args }: { args: unknown }) => {
    const f = args as Flags;
    const id = companyId(f);
    const body = extraBody(f);
    if (f.preview) return void process.stdout.write(JSON.stringify(buildPreviewOutput({ method: "companies.update", args: { company_id: id }, body })) + "\n");
    const c = await rootClient(f);
    try {
      renderSuccess(readableObject(await c.companies.update(id, body)), outputOpts(f), process);
    } catch (err) {
      await fail(err, f);
    }
  },
});

export const companyRecordCommand = defineCommand({
  meta: { name: "company", description: DESCRIPTIONS.companyRecord },
  subCommands: { get: getCmd, fields: fieldsCmd },
  async run() {
    const { showHelp } = await import("../lib/examples.js");
    await showHelp(companyRecordCommand, ["curviate", "company"]);
  },
});
