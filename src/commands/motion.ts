/**
 * `curviate motion`: Motions and their Sequences (api/040, cli/011 FR-002).
 * Root-scoped (`curviate.motions.*`). Enrollments are the root `enrollment`
 * group.
 *
 * Documents: a Motion file (`motion create|update --file`) is checked before
 * any request, the Motion fields against the vendored request schema
 * (lib/document.ts, `<path>: <rule>`), then its `sequence` with the SDK's
 * `validateSequence` (compiler-format lines, lib/sequence-report.ts). A pasted
 * `motion get` output loses its read-only keys with a warning (cli/011 FR-012).
 * `lint` and `init` are offline.
 */
import { defineCommand } from "citty";
import { writeFile } from "node:fs/promises";
import type { Curviate, CurviateError } from "@curviate/sdk";
import { DESCRIPTIONS } from "./descriptions.js";
import { GLOBAL_FLAGS, READ_SINGLE_FLAGS, WRITE_SINGLE_FLAGS, readOnly } from "../lib/global-flags.js";
import { renderSuccess, writeNdjsonItem } from "../lib/output.js";
import { buildPreviewOutput } from "../lib/preview.js";
import { streamAll, pageDelayFromFlags, readCursorFlag, readMaxPagesFlag, readablePage, rejectPaginationModifiersWithoutAll } from "../lib/paginate.js";
import { documentSchema, parseDocument, readFileFlag, reportIssues, validate } from "../lib/document.js";
import { intFlag } from "../lib/int-flag.js";
import { compilerLines } from "../lib/sequence-report.js";
import { sendInChunks } from "../lib/chunks.js";
import { fail, listFlag, outputOpts, rootClient, usage, type RootFlags } from "../lib/root-command.js";
import connectAndConverse from "../templates/connect-and-converse.json";
import engageThenConnect from "../templates/engage-then-connect.json";
import nurtureConnections from "../templates/nurture-connections.json";

/** Contact ids per add/remove request: `x-curviate-limits.items` of both operations (test-held equal to the fixture). */
export const BULK_MAX_IDS = 1000;

export const TEMPLATES: Record<string, unknown> = {
  "connect-and-converse": connectAndConverse,
  "engage-then-connect": engageThenConnect,
  "nurture-connections": nurtureConnections,
};

const STATUSES = ["draft", "scheduled", "active", "paused", "completed", "archived"];

type MotionFlags = RootFlags & {
  id?: string;
  file?: string;
  status?: string;
  version?: string;
  "if-revision"?: string;
  sample?: string;
  contact?: string | string[];
  account?: string;
  template?: string;
  output?: string;
  limit?: string;
  cursor?: string;
  all?: boolean;
  "max-pages"?: string;
  "page-delay"?: string;
};

type Body = Record<string, unknown>;

function preview(method: string, args: Record<string, unknown>, body: unknown = {}): void {
  process.stdout.write(JSON.stringify(buildPreviewOutput({ method, args, body: body as Body })) + "\n");
}

/** `--file`'s path as the findings name it: `-` for stdin. */
const shownFile = (f: MotionFlags) => (f.file === "-" ? "-" : (f.file ?? "-"));

/**
 * The Sequence verdict printed in the compiler format on stderr, and in JSON
 * mode the server's refusal shape on stdout. Errors exit 2 (SEQUENCE_INVALID),
 * nothing sent; warnings print and never block.
 */
async function checkSequence(f: MotionFlags, text: string, sequence: unknown, prefix: string): Promise<{ warnings: unknown[] }> {
  const { validateSequence } = await import("@curviate/sdk");
  const verdict = validateSequence(sequence);
  const lines = compilerLines(shownFile(f), text, verdict, prefix);
  if (verdict.errors.length) {
    const first = verdict.errors[0]!;
    const message = `${first.path}: ${first.rule}${verdict.errors.length > 1 ? ` and ${verdict.errors.length - 1} more` : ""}`;
    if (outputOpts(f).json) process.stdout.write(JSON.stringify({ error: { code: "SEQUENCE_INVALID", message, errors: verdict.errors }, warnings: verdict.warnings }) + "\n");
    process.stderr.write(lines.map((l) => `${l}\n`).join(""));
    process.exit(2);
  }
  process.stderr.write(lines.map((l) => `${l}\n`).join(""));
  return verdict;
}

/** A Motion file, checked whole before any request: read-only keys dropped, fields against the schema, then the Sequence. */
async function readMotionFile(f: MotionFlags, command: "motion create" | "motion update"): Promise<{ body: Body; text: string }> {
  const text = await readFileFlag("file", f.file ?? "", { others: f });
  const doc = parseDocument("file", text);
  const schema = documentSchema(command);
  let body = doc as Body;
  if (doc && typeof doc === "object" && !Array.isArray(doc)) {
    const readOnlyKeys = schema["x-curviate-response-only"] as string[];
    const dropped = Object.keys(doc).filter((k) => readOnlyKeys.includes(k));
    if (dropped.length) {
      process.stderr.write(`warning: dropped ${dropped.join(", ")}: set by Curviate, not part of a Motion file (\`curviate motion get\` output carries them).\n`);
      body = Object.fromEntries(Object.entries(doc).filter(([k]) => !dropped.includes(k)));
    }
  }
  const issues = validate(schema, body);
  if (issues.length) reportIssues(issues, outputOpts(f).json);
  if (body["sequence"] != null) await checkSequence(f, text, body["sequence"], "/sequence");
  return { body, text };
}

/** A refusal the server lists with the compiler keys (a newer server than this CLI's SDK) prints in the same format. */
function explain(err: unknown, f: MotionFlags, text: string): void {
  const e = err as Partial<CurviateError> & { current?: { sequence_revision?: number; sequence_updated_by_user_id?: string | null; updated_at?: string } };
  if (e.code === "SEQUENCE_INVALID" && e.errors?.length) {
    process.stderr.write(compilerLines(shownFile(f), text, { errors: e.errors, warnings: [] }, "/sequence").map((l) => `${l}\n`).join(""));
  }
  if (e.code === "SEQUENCE_CONFLICT" && e.current) {
    const c = e.current;
    process.stderr.write(
      `The Sequence was saved since revision ${f["if-revision"]}: revision ${c.sequence_revision} by ${c.sequence_updated_by_user_id ?? "an unknown user"} at ${c.updated_at ?? "an unknown time"}. ` +
        `Read it with \`curviate motion get ${f.id}\` and merge, or send yours again with --if-revision ${c.sequence_revision} to replace it.\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Run functions
// ---------------------------------------------------------------------------

async function runList(c: Curviate, f: MotionFlags): Promise<void> {
  rejectPaginationModifiersWithoutAll(f, process);
  const params: Body = {};
  if (f.status !== undefined) {
    const status = listFlag("status", f.status);
    const bad = status.filter((s) => !STATUSES.includes(s));
    if (bad.length) usage(`--status takes a comma list of ${STATUSES.join(", ")}.`);
    params["status"] = status;
  }
  if (f.limit !== undefined) params["limit"] = intFlag("limit", f.limit, 1, 100);
  const cursor = readCursorFlag(f, process);
  if (cursor) params["cursor"] = cursor;
  try {
    if (f.all) {
      const page = (p: Body) => c.motions.list(p as never) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(page, params, { maxPages: readMaxPagesFlag(f, process), out: process, pageDelayMs: pageDelayFromFlags(f) })) writeNdjsonItem(process, item, f.fields);
    } else {
      renderSuccess(readablePage(await c.motions.list(params as never)), outputOpts(f), process);
    }
  } catch (err) {
    await fail(err, f);
  }
}

async function runGet(c: Curviate, f: MotionFlags): Promise<void> {
  try {
    const result = f.version === undefined
      ? await c.motions.get(f.id ?? "")
      : await c.motions.getSequenceVersion(f.id ?? "", { version: intFlag("version", f.version) });
    renderSuccess(result, outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

async function runCreate(c: Curviate, f: MotionFlags): Promise<void> {
  const { body, text } = await readMotionFile(f, "motion create");
  if (f.preview) return preview("motions.create", {}, body);
  try {
    renderSuccess(await c.motions.create(body as never), outputOpts(f), process);
  } catch (err) {
    explain(err, f, text);
    await fail(err, f);
  }
}

async function runUpdate(c: Curviate, f: MotionFlags): Promise<void> {
  const { body, text } = await readMotionFile(f, "motion update");
  // OQ-19: the precondition is sent only when asked for, never read from the file.
  if (f["if-revision"] !== undefined) body["if_sequence_revision"] = intFlag("if-revision", f["if-revision"], 0);
  if (f.preview) return preview("motions.update", { id: f.id }, body);
  try {
    renderSuccess(await c.motions.update(f.id ?? "", body as never), outputOpts(f), process);
  } catch (err) {
    explain(err, f, text);
    await fail(err, f);
  }
}

/** start, pause, resume, archive, delete: one call on one Motion. */
const lifecycle = (method: "start" | "pause" | "resume" | "archive" | "delete") => async (c: Curviate, f: MotionFlags): Promise<void> => {
  if (f.preview) return preview(`motions.${method}`, { id: f.id });
  try {
    renderSuccess(await c.motions[method](f.id ?? ""), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
};

async function runPreview(c: Curviate, f: MotionFlags): Promise<void> {
  const params: Body = {};
  if (f.sample !== undefined) params["sample"] = intFlag("sample", f.sample, 1, 20);
  if (f.contact !== undefined) params["contact_ids"] = listFlag("contact", f.contact);
  if (params["sample"] !== undefined && params["contact_ids"] !== undefined) usage("--sample and --contact cannot be combined: name the Contacts, or let Curviate sample.");
  try {
    renderSuccess(await c.motions.preview(f.id ?? "", params as never), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

/** `add` and `remove`: Contact ids in chunks of BULK_MAX_IDS, in order (FR-013). */
const membership = (kind: "add" | "remove") => async (c: Curviate, f: MotionFlags): Promise<void> => {
  const ids = listFlag("contact", f.contact);
  if (!ids.length) usage("--contact is required: one or more Contact ids (con_...).");
  if (kind === "remove" && f.account !== undefined) usage("--account applies to `curviate motion add` only.");
  if (f.account !== undefined && f.account.trim() === "") usage("--account was given an empty value. Pass an acc_... id of the Motion, or omit it to let Curviate assign one.");
  const body = (chunk: string[]) => ({ contact_ids: chunk, ...(f.account !== undefined ? { account_id: f.account } : {}) });
  const method = kind === "add" ? "addContacts" : "removeContacts";
  if (f.preview) return preview(`motions.${method}`, { id: f.id }, body(ids.slice(0, BULK_MAX_IDS)));
  const results = await sendInChunks(ids, BULK_MAX_IDS, (chunk) => c.motions[method](f.id ?? "", body(chunk) as never) as Promise<unknown>, f);
  if (results.length === 1) return renderSuccess(results[0], outputOpts(f), process);
  // Several chunks: one answer, every chunk's entries in input order.
  const merged = kind === "add"
    ? { object: "motion_contacts_result", results: results.flatMap((r) => (r as { results?: unknown[] } | null)?.results ?? []) }
    : {
        removed: results.reduce<number>((n, r) => n + ((r as { removed?: number } | null)?.removed ?? 0), 0),
        not_found: results.flatMap((r) => (r as { not_found?: unknown[] } | null)?.not_found ?? []),
      };
  renderSuccess(merged, outputOpts(f), process);
};

/** `lint`: offline. A Motion file's Sequence (under `/sequence`) or a bare Sequence document. */
export async function runLint(f: MotionFlags): Promise<void> {
  const text = await readFileFlag("file", f.file ?? "", { others: f });
  const doc = parseDocument("file", text) as Body | null;
  const motionFile = !!doc && typeof doc === "object" && !Array.isArray(doc) && !("steps" in doc) && "sequence" in doc;
  if (motionFile && doc["sequence"] === null) usage("--file: the Motion file's sequence is null; there is nothing to lint.");
  const verdict = await checkSequence(f, text, motionFile ? doc["sequence"] : doc, motionFile ? "/sequence" : "");
  if (outputOpts(f).json) process.stdout.write(JSON.stringify({ errors: [], warnings: verdict.warnings }) + "\n");
}

/** `init`: offline. A template as a Motion file, `schedule.timezone` set to this machine's. */
export async function runInit(f: MotionFlags): Promise<void> {
  const tpl = TEMPLATES[f.template ?? ""];
  if (!tpl) usage(`--template takes one of ${Object.keys(TEMPLATES).join(", ")}.`);
  const doc = structuredClone(tpl) as { schedule: { timezone: string | null } };
  doc.schedule.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const text = JSON.stringify(doc, null, 2) + "\n";
  if (f.output === undefined || f.output === "-") return void process.stdout.write(text);
  try {
    await writeFile(f.output, text, { flag: "wx" });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    usage(code === "EEXIST" ? `--output: ${f.output} already exists. Pick another path or remove it first.` : `--output: cannot write ${f.output}: ${code ?? "write error"}.`);
  }
  process.stderr.write(`Wrote ${f.output}. Next: fill contact_list_ids and account_ids, then \`curviate motion create --file ${f.output}\`.\n`);
}

// ---------------------------------------------------------------------------
// citty definitions
// ---------------------------------------------------------------------------

const online = (fn: (c: Curviate, f: MotionFlags) => Promise<void>) => async ({ args }: { args: unknown }) => {
  const f = args as MotionFlags;
  await fn(await rootClient(f), f);
};

const ID = { type: "positional" as const, description: "Motion id (mot_...)." };
const FILE_DESC = "The Motion file: a path, or - to read it from stdin. `curviate motion get` output is accepted as is.";
const SEQUENCE_ERRORS = { SEQUENCE_INVALID: "the Sequence breaks a rule; every error is listed, one line each, as `curviate motion lint` prints them." };
const ROLE_ERRORS = {
  INSUFFICIENT_ROLE: "your role cannot send from a sending Account of this Motion.",
  ACCOUNT_NOT_SHARED: "a sending Account is not shared with you.",
};
const SEE_LIFECYCLE = ["curviate motion get", "curviate enrollment list"];

const listCmd = defineCommand({
  meta: {
    name: "list",
    description: "List your Team's Motions, most recently updated first. Items carry no Sequence: read one with `curviate motion get <motion_id>`.",
    risk: "read",
    examples: ["curviate motion list", "curviate motion list --status active,paused"],
  },
  args: {
    ...readOnly(GLOBAL_FLAGS),
    status: { type: "string", description: `Comma list of ${STATUSES.join(", ")}. Default: all but archived.` },
  },
  run: online(runList),
});

const getCmd = defineCommand({
  meta: {
    name: "get",
    description: "One Motion with its current Sequence and lint warnings. With --version, that Sequence version instead, and how many Enrollments still run on it.",
    risk: "read",
    output: ["The full Motion, pasteable: `curviate motion create --file -` and `curviate motion update <motion_id> --file -` accept it as is, dropping the keys Curviate sets."],
    examples: ["curviate motion get mot_YOUR_MOTION_ID", "curviate motion get mot_YOUR_MOTION_ID --version 1"],
  },
  args: {
    ...readOnly(READ_SINGLE_FLAGS),
    id: ID,
    version: { type: "string", description: "A Sequence version number (1 or more)." },
  },
  run: online(runGet),
});

const MOTION_DOC = `{
  "name": "Q4 webinar follow-up",
  "contact_list_ids": ["cl_YOUR_LIST_ID"],
  "account_ids": ["acc_YOUR_ACCOUNT_ID"],
  "sequence": {
    "on_reply": "end",
    "steps": [
      { "id": "invite", "do": "invite.send", "with": { "note": null }, "next": "end" }
    ]
  }
}`;

const createCmd = defineCommand({
  meta: {
    name: "create",
    description: "Create a Motion from a Motion file, always as a draft: nothing runs until `curviate motion start`. The file is checked before anything is sent, its Sequence as `curviate motion lint` checks it.",
    risk: "write",
    rules: {
      changes: "Creates a draft Motion. No Contact is enrolled and nothing reaches LinkedIn until it is started.",
      visible_to: "Your Team.",
      budget_rows: [],
      retry: "A retry creates a second draft: list with `curviate motion list --status draft` first.",
      undo: "`curviate motion delete <motion_id>` deletes a draft.",
    },
    errors: { ...SEQUENCE_ERRORS, ...ROLE_ERRORS, TIER_REQUIRED: "Motions need the Automate plan." },
    seeAlso: ["curviate motion lint", "curviate motion init", "curviate motion preview"],
    document: "motion create",
    examples: [
      "curviate motion create --file motion.json",
      `curviate motion create --file - <<'EOF'\n${MOTION_DOC}\nEOF`,
    ],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    file: { type: "string", stdinArg: true, required: true, description: FILE_DESC },
  },
  run: online(runCreate),
});

const updateCmd = defineCommand({
  meta: {
    name: "update",
    description:
      "Change a Motion from a Motion file: objects (schedule, settings) merge by key, arrays and the Sequence replace whole, null clears. " +
      "After start, a structural Sequence change makes a new version; running Enrollments keep theirs. With --if-revision the save is refused when someone saved the Sequence since.",
    risk: "write",
    rules: {
      changes: "Changes the Motion. A running Motion picks the change up at each Enrollment's next Step.",
      visible_to: "Your Team, and the Contacts its next Steps reach.",
      budget_rows: [],
      retry: "Safe: the same file sends the same change. Without --if-revision the last save wins.",
      undo: "Send the previous file again (`curviate motion get <motion_id> --version <n>` reads an earlier Sequence).",
    },
    errors: {
      ...SEQUENCE_ERRORS,
      SEQUENCE_CONFLICT: "with --if-revision: someone saved the Sequence since that revision; the message names the newer revision and who saved it.",
      MOTION_STATUS_CONFLICT: "an archived Motion, or one past its end, cannot change.",
      ...ROLE_ERRORS,
    },
    seeAlso: ["curviate motion get", "curviate motion lint"],
    document: "motion update",
    examples: [
      "curviate motion update mot_YOUR_MOTION_ID --file motion.json --if-revision 3",
      `curviate motion update mot_YOUR_MOTION_ID --file - <<'EOF'\n${MOTION_DOC}\nEOF`,
    ],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    id: ID,
    file: { type: "string", stdinArg: true, required: true, description: FILE_DESC },
    "if-revision": { type: "string", description: "The sequence_revision you read (`curviate motion get`). The save is refused with SEQUENCE_CONFLICT when the stored Sequence moved past it. Omitted: the last save wins." },
  },
  run: online(runUpdate),
});

const lifecycleCmd = (name: "start" | "pause" | "resume" | "archive" | "delete", meta: Record<string, unknown>) =>
  defineCommand({
    meta: { name, ...meta, examples: [`curviate motion ${name} mot_YOUR_MOTION_ID`] },
    args: { ...WRITE_SINGLE_FLAGS, id: ID },
    run: online(lifecycle(name)),
  });

const startCmd = lifecycleCmd("start", {
  description: "Start a draft: scheduled when its start time is ahead, else active. Freezes Sequence version 1. A Motion missing what it needs is refused with every gap listed.",
  risk: "high",
  rules: {
    changes: "The Motion starts enrolling its Contacts and running its Steps from its sending Accounts, paced on its schedule.",
    visible_to: "The Contacts each Step reaches on LinkedIn.",
    budget_rows: [],
    retry: "A retry on a started Motion answers MOTION_STATUS_CONFLICT; nothing runs twice.",
    undo: "`curviate motion pause <motion_id>` stops new Steps; what was sent stays sent.",
    blast_radius: "Every Contact of its Contact lists, from every sending Account, each Step spending that Account's budgets (`curviate account get <account_id>`).",
  },
  errors: { MOTION_NOT_STARTABLE: "a gap stops it (Contact list, sending Account, timezone, Sequence); each is listed.", MOTION_STATUS_CONFLICT: "only a draft starts.", ...ROLE_ERRORS, TIER_REQUIRED: "Motions need the Automate plan." },
  seeAlso: ["curviate motion preview", "curviate motion pause"],
});

const pauseCmd = lifecycleCmd("pause", {
  description: "Pause an active or scheduled Motion: no Step runs until it is resumed. Waits keep their time.",
  risk: "write",
  rules: {
    changes: "No Step of the Motion runs while it is paused.",
    visible_to: "Your Team.",
    budget_rows: [],
    retry: "Safe: a paused Motion answers MOTION_STATUS_CONFLICT.",
    undo: "`curviate motion resume <motion_id>`.",
  },
  errors: { MOTION_STATUS_CONFLICT: "only an active or scheduled Motion pauses.", ...ROLE_ERRORS },
  seeAlso: SEE_LIFECYCLE,
});

const resumeCmd = lifecycleCmd("resume", {
  description: "Resume a paused Motion. Runs the start checks again.",
  risk: "high",
  rules: {
    changes: "The Motion's Steps run again from its sending Accounts.",
    visible_to: "The Contacts each Step reaches on LinkedIn.",
    budget_rows: [],
    retry: "A retry on a running Motion answers MOTION_STATUS_CONFLICT.",
    undo: "`curviate motion pause <motion_id>`; what was sent stays sent.",
    blast_radius: "Every open Enrollment of the Motion.",
  },
  errors: { MOTION_NOT_STARTABLE: "a gap stops it; each is listed.", MOTION_STATUS_CONFLICT: "only a paused Motion resumes.", ...ROLE_ERRORS, TIER_REQUIRED: "Motions need the Automate plan." },
  seeAlso: SEE_LIFECYCLE,
});

const archiveCmd = lifecycleCmd("archive", {
  description: "Archive a Motion: its open Enrollments end (motion_archived) and it never runs again.",
  risk: "high",
  rules: {
    changes: "Ends every open Enrollment and freezes the Motion.",
    visible_to: "Your Team.",
    budget_rows: [],
    retry: "A retry answers MOTION_STATUS_CONFLICT.",
    undo: "Cannot be undone. Create a new Motion from `curviate motion get <motion_id>` output.",
    blast_radius: "Every open Enrollment of the Motion.",
  },
  errors: { MOTION_STATUS_CONFLICT: "already archived.", ...ROLE_ERRORS },
  seeAlso: SEE_LIFECYCLE,
});

const deleteCmd = lifecycleCmd("delete", {
  description: "Delete a draft Motion with its Sequence versions. Any other status: archive it instead.",
  risk: "high",
  rules: {
    changes: "Deletes the draft and its Sequence versions.",
    visible_to: "Your Team.",
    budget_rows: [],
    retry: "A retry answers RESOURCE_NOT_FOUND.",
    undo: "Cannot be undone. Keep `curviate motion get <motion_id>` output to create it again.",
    blast_radius: "One draft Motion; it has no Enrollments.",
  },
  errors: { RESOURCE_NOT_FOUND: "no Motion with this id.", MOTION_STATUS_CONFLICT: "only a draft is deleted; archive the others.", ...ROLE_ERRORS },
  seeAlso: ["curviate motion archive", "curviate motion list"],
});

const previewCmd = defineCommand({
  meta: {
    name: "preview",
    description: "What the Motion would do, in any status: every path through its Sequence, rendered messages for sampled or named Contacts, and the budget projection. A read: never reaches LinkedIn, spends nothing.",
    risk: "read",
    examples: ["curviate motion preview mot_YOUR_MOTION_ID", "curviate motion preview mot_YOUR_MOTION_ID --sample 3"],
  },
  args: {
    ...readOnly(READ_SINGLE_FLAGS),
    id: ID,
    sample: { type: "string", description: "How many Contacts to render (default 5)." },
    contact: { type: "string", description: "A Contact id (con_...) to render; repeatable, or a comma list. Not with --sample." },
  },
  run: online(runPreview),
});

const membershipCmd = (kind: "add" | "remove") =>
  defineCommand({
    meta: {
      name: kind,
      description: kind === "add"
        ? "Enroll Contacts directly, on an Account of the Motion (--account) or one Curviate assigns. Every exclusion and filter applies; each Contact's outcome says what happened. Sent in requests of up to 1000 ids, in order."
        : "Take Contacts out of the Motion: their open Enrollments end (removed). Sent in requests of up to 1000 ids, in order.",
      risk: "high",
      rules: kind === "add"
        ? {
            changes: "Each queued Contact becomes a pending Enrollment; a running Motion reaches it on its schedule.",
            visible_to: "Your Team now; the Contacts once their Steps run.",
            budget_rows: [],
            retry: "Safe: a Contact already in the Motion answers already_enrolled. After a failed request, send the ids from the failed one on.",
            undo: "`curviate motion remove <motion_id> --contact <contact_id>`; what was sent stays sent.",
            blast_radius: "Every Contact given.",
          }
        : {
            changes: "Ends each named Contact's open Enrollments in the Motion (removed).",
            visible_to: "Your Team.",
            budget_rows: [],
            retry: "Safe: a Contact no longer in the Motion is listed in not_found.",
            undo: "`curviate motion add <motion_id> --contact <contact_id>` enrolls it again.",
            blast_radius: "Every Contact given.",
          },
      errors: { MOTION_STATUS_CONFLICT: "an archived Motion, or one past its end, takes no Contacts.", ...ROLE_ERRORS },
      seeAlso: ["curviate enrollment list"],
      examples: kind === "add"
        ? ["curviate motion add mot_YOUR_MOTION_ID --contact con_YOUR_CONTACT_ID", "curviate motion add mot_YOUR_MOTION_ID --contact con_A,con_B --account acc_YOUR_ACCOUNT_ID"]
        : ["curviate motion remove mot_YOUR_MOTION_ID --contact con_YOUR_CONTACT_ID"],
    },
    args: {
      ...WRITE_SINGLE_FLAGS,
      id: ID,
      contact: { type: "string", required: true, description: "A Contact id (con_...); repeatable, or a comma list." },
      ...(kind === "add" ? { account: { type: "string" as const, description: "Enroll them on this sending Account of the Motion (acc_...). Never defaulted: omit it and Curviate assigns one." } } : {}),
    },
    run: online(membership(kind)),
  });

const OFFLINE = { notes: ["Offline: no API call."] };

const lintCmd = defineCommand({
  meta: {
    name: "lint",
    description:
      "Check a Sequence offline with the rules the API applies: a Motion file (its sequence) or a bare Sequence document. One line per finding, `<file>:<line>:<col> error|warning <code> <path>: <message>. <hint> -> <docs_url>`; exit 2 on any error, 0 otherwise.",
    risk: "read",
    rules: OFFLINE,
    output: ["Findings on stderr. With --json (or piped), stdout carries `{errors, warnings}`, or on errors the SEQUENCE_INVALID refusal the API would send."],
    examples: ["curviate motion lint --file motion.json"],
  },
  args: {
    json: GLOBAL_FLAGS.json,
    file: { type: "string", stdinArg: true, required: true, description: "A Motion file or a Sequence document: a path, or - to read it from stdin." },
  },
  async run({ args }) {
    await runLint(args as MotionFlags);
  },
});

const initCmd = defineCommand({
  meta: {
    name: "init",
    description: `Write a Motion file from a template (${Object.keys(TEMPLATES).join(", ")}), its schedule in this machine's timezone. Fill contact_list_ids and account_ids, then create it.`,
    risk: "read",
    rules: OFFLINE,
    output: ["The Motion file on stdout, or in the --output file (never overwritten)."],
    examples: ["curviate motion init --template connect-and-converse --output motion.json"],
  },
  args: {
    template: { type: "string", required: true, description: `One of ${Object.keys(TEMPLATES).join(", ")}.` },
    output: { type: "string", alias: "o", description: "Write to this path (refused when it exists), or - for stdout (default)." },
  },
  async run({ args }) {
    await runInit(args as MotionFlags);
  },
});

export const motionCommand = defineCommand({
  meta: { name: "motion", description: DESCRIPTIONS.motion },
  subCommands: {
    list: listCmd,
    get: getCmd,
    create: createCmd,
    update: updateCmd,
    start: startCmd,
    pause: pauseCmd,
    resume: resumeCmd,
    archive: archiveCmd,
    delete: deleteCmd,
    preview: previewCmd,
    add: membershipCmd("add"),
    remove: membershipCmd("remove"),
    lint: lintCmd,
    init: initCmd,
  },
  async run() {
    const { showHelp } = await import("../lib/examples.js");
    await showHelp(motionCommand, ["curviate", "motion"]);
  },
});
