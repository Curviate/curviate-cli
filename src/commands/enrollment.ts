/**
 * `curviate enrollment`: one Contact in one Motion on one Account.
 * Root-scoped (`curviate.enrollments.*`).
 *
 * `retry` is the guarded Retry (`enrollments.retry`, acts only on a failed
 * Step), never `resume --at`, which is an unguarded jump. It then waits for
 * that Step's next record and prints it.
 */
import { defineCommand } from "citty";
import { setTimeout as sleep } from "node:timers/promises";
import type { Curviate } from "@curviate/sdk";
import { DESCRIPTIONS } from "./descriptions.js";
import { GLOBAL_FLAGS, READ_SINGLE_FLAGS, WRITE_SINGLE_FLAGS, readOnly } from "../lib/global-flags.js";
import { renderSuccess, writeNdjsonItem } from "../lib/output.js";
import { buildPreviewOutput } from "../lib/preview.js";
import { streamAll, pageDelayFromFlags, readCursorFlag, readMaxPagesFlag, readableObject, readablePage, rejectPaginationModifiersWithoutAll } from "../lib/paginate.js";
import { intFlag } from "../lib/int-flag.js";
import { fail, listFlag, outputOpts, rootClient, usage, type RootFlags } from "../lib/root-command.js";

type EnrollmentFlags = RootFlags & {
  id?: string | string[];
  name?: string;
  at?: string;
  account?: string;
  action?: string;
  motion?: string;
  contact?: string;
  status?: string;
  step?: string | string[];
  version?: string;
  "done-step"?: string;
  outcome?: string;
  reason?: string;
  variant?: string;
  relationship?: string;
  limit?: string;
  cursor?: string;
  all?: boolean;
  "max-pages"?: string;
  "page-delay"?: string;
  "wait-timeout"?: string;
};

type Record_ = Record<string, unknown>;
type HistoryEntry = { step_id?: string | null; outcome?: string; reason?: string | null; reason_message?: string | null };

/** How often `retry` reads the Enrollment while it waits. */
const POLL_MS = 2000;
/** `retry`'s default wait: the Step may sit behind pacing or a budget */
const RETRY_WAIT_MS = 10 * 60 * 1000;

function preview(method: string, args: Record_, body: unknown = {}): void {
  process.stdout.write(JSON.stringify(buildPreviewOutput({ method, args, body: body as Record_ })) + "\n");
}

/** The list filters, as `GET /v1/enrollments` and a bulk `filter` name them. Lists stay arrays. */
function filters(f: EnrollmentFlags): Record_ {
  const q: Record_ = {};
  const one = (flag: keyof EnrollmentFlags, key: string) => {
    const v = f[flag];
    if (v === undefined) return;
    if (typeof v !== "string" || v.trim() === "") usage(`--${String(flag)} was given an empty value.`);
    q[key] = v;
  };
  one("motion", "motion_id");
  one("contact", "contact_id");
  one("done-step", "done_step");
  one("outcome", "outcome");
  one("variant", "variant_id");
  if (f.step !== undefined) q["step_id"] = listFlag("step", f.step);
  if (f.status !== undefined) q["status"] = listFlag("status", f.status);
  if (f.reason !== undefined) q["reason"] = listFlag("reason", f.reason);
  if (f.relationship !== undefined) q["relationship_at_enrollment"] = listFlag("relationship", f.relationship);
  if (f.version !== undefined) q["version"] = intFlag("version", f.version);
  return q;
}

/** `code` with its sentence as one `<code>: <message>`; the code alone when there is no sentence. */
const paired = (code: unknown, message: unknown) => (code != null && message != null ? `${code}: ${message}` : code);

/**
 * Human mode reads each reason as `<code>: <message>`: `skip_reason`,
 * `finish_reason` and every history entry's `reason` carry their sentence, and
 * the separate `*_message` keys go. JSON keeps the API's pair.
 */
export function humanReasons(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(humanReasons);
  if (!data || typeof data !== "object") return data;
  const o = { ...(data as Record_) };
  for (const k of ["skip", "finish"]) {
    if (`${k}_message` in o) {
      o[`${k}_reason`] = paired(o[`${k}_reason`], o[`${k}_message`]);
      delete o[`${k}_message`];
    }
  }
  if ("reason_message" in o) {
    o["reason"] = paired(o["reason"], o["reason_message"]);
    delete o["reason_message"];
  }
  for (const k of ["items", "history"]) if (Array.isArray(o[k])) o[k] = (o[k] as unknown[]).map(humanReasons);
  return o;
}

/** Print an Enrollment answer: verbatim in JSON, reasons paired in human mode. */
function show(result: unknown, f: EnrollmentFlags): void {
  const opts = outputOpts(f);
  renderSuccess(opts.json ? result : humanReasons(result), opts, process);
}

// ---------------------------------------------------------------------------
// Run functions
// ---------------------------------------------------------------------------

async function runList(c: Curviate, f: EnrollmentFlags): Promise<void> {
  rejectPaginationModifiersWithoutAll(f, process);
  const params = filters(f);
  if (f.limit !== undefined) params["limit"] = intFlag("limit", f.limit, 1, 100);
  const cursor = readCursorFlag(f, process);
  if (cursor) params["cursor"] = cursor;
  try {
    if (f.all) {
      const page = (p: Record_) => c.enrollments.list(p as never) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(page, params, { maxPages: readMaxPagesFlag(f, process), out: process, pageDelayMs: pageDelayFromFlags(f) })) writeNdjsonItem(process, item, f.fields);
    } else {
      show(readablePage(await c.enrollments.list(params as never)), f);
    }
  } catch (err) {
    await fail(err, f);
  }
}

async function runGet(c: Curviate, f: EnrollmentFlags): Promise<void> {
  try {
    show(readableObject(await c.enrollments.get(String(f.id ?? ""))), f);
  } catch (err) {
    await fail(err, f);
  }
}

/** pause, resume, stop, event, reassign: one call on one Enrollment. */
const single = (method: "pause" | "resume" | "stop" | "events" | "reassign", body: (f: EnrollmentFlags) => Record_ | undefined = () => undefined) =>
  async (c: Curviate, f: EnrollmentFlags): Promise<void> => {
    const b = body(f);
    if (f.preview) return preview(`enrollments.${method}`, { id: f.id }, b ?? {});
    try {
      const call = c.enrollments[method] as (id: string, b?: Record_) => Promise<unknown>;
      show(await call.call(c.enrollments, String(f.id ?? ""), b), f);
    } catch (err) {
      await fail(err, f);
    }
  };

const required = (flag: string, v: string | undefined, what: string): string => {
  if (v === undefined || v.trim() === "") usage(`--${flag} is required: ${what}.`);
  return v;
};

/**
 * `retry`: the guarded Retry, then a wait for the failed Step's next record,
 * printed as `{outcome, reason, message}`. `--wait-timeout` bounds that wait;
 * `--timeout` stays the request timeout.
 */
export async function runRetry(c: Curviate, f: EnrollmentFlags): Promise<void> {
  const id = String(f.id ?? "");
  const waitMs = f["wait-timeout"] === undefined ? RETRY_WAIT_MS : intFlag("wait-timeout", f["wait-timeout"], 0, 24 * 60 * 60 * 1000);
  if (f.preview) return preview("enrollments.retry", { id });
  const read = async () => {
    const e = (await c.enrollments.get(id)) as { history?: HistoryEntry[] } | null;
    return Array.isArray(e?.history) ? e.history : [];
  };
  let before: HistoryEntry[];
  try {
    before = await read();
  } catch (err) {
    return fail(err, f);
  }
  const failed = [...before].reverse().find((h) => h.outcome === "failed");
  let item: unknown;
  try {
    item = await c.enrollments.retry(id);
  } catch (err) {
    const { CurviateError } = await import("@curviate/sdk");
    if (err instanceof CurviateError) return fail(err, f);
    // The API took the call but its answer cannot be read: the Step may be running.
    process.stderr.write(`error: the API answered the retry without a readable result. It may have been applied: check with \`curviate enrollment get ${id}\` before sending it again.\n`);
    process.exit(7);
  }
  if (!failed?.step_id) {
    process.stderr.write(`The retry was accepted, but no failed Step was in the history read just before it: read the outcome with \`curviate enrollment get ${id}\`.\n`);
    return renderSuccess(item, outputOpts(f), process);
  }
  const deadline = Date.now() + waitMs;
  for (;;) {
    // Resumed already: a failed read only costs this poll, never reads as a failed retry.
    const now = await read().catch(() => null);
    const record = now?.slice(before.length).find((h) => h.step_id === failed.step_id);
    if (record) return renderSuccess({ step_id: failed.step_id, outcome: record.outcome ?? null, reason: record.reason ?? null, message: record.reason_message ?? null }, outputOpts(f), process);
    const left = deadline - Date.now();
    if (left <= 0) break;
    await sleep(Math.min(POLL_MS, left));
  }
  process.stderr.write(
    `error: Step ${failed.step_id} was resumed but has not run within ${waitMs} ms; it may wait for pacing or a budget. ` +
      `Read it later with \`curviate enrollment get ${id}\`. Do not retry it: it is already resumed.\n`,
  );
  process.exit(7);
}

const ACTIONS = ["pause", "resume", "stop", "retry", "event", "reassign"];

/** `bulk`: one call, each Enrollment decided alone. Exit 0 when every one is ok, else the first failure's exit. */
async function runBulk(c: Curviate, f: EnrollmentFlags): Promise<void> {
  const action = required("action", f.action, ACTIONS.join(", "));
  if (!ACTIONS.includes(action)) usage(`--action takes one of ${ACTIONS.join(", ")}.`);
  const ids = listFlag("id", f.id);
  const filter = filters(f);
  if ((ids.length > 0) === (f.motion !== undefined)) usage("name the Enrollments either with --id (repeatable, or a comma list) or with --motion and its filters, not both.");
  if (ids.length && Object.keys(filter).length) usage("the list filters apply with --motion, not with --id.");
  const body: Record_ = { action, ...(ids.length ? { ids } : { filter }) };
  if (f.at !== undefined) body["at"] = f.at;
  if (f.name !== undefined) body["name"] = f.name;
  if (f.account !== undefined) body["account_id"] = f.account;
  if (f.preview) return preview("enrollments.bulk", {}, body);
  let result: { results?: Array<{ enrollment_id?: string; outcome?: string; error?: { code?: string; message?: string } | null; warnings?: Array<{ message?: string }> }> } | null;
  try {
    result = (await c.enrollments.bulk(body as never)) as typeof result;
  } catch (err) {
    return fail(err, f);
  }
  const results = Array.isArray(result?.results) ? result.results : [];
  if (outputOpts(f).json) renderSuccess(result, outputOpts(f), process);
  else {
    for (const r of results) {
      const warn = (r.warnings ?? []).map((w) => ` (warning: ${w.message ?? ""})`).join("");
      process.stdout.write(`${r.enrollment_id} ${r.outcome === "ok" ? "ok" : `error ${r.error?.code}: ${r.error?.message ?? ""}`}${warn}\n`);
    }
  }
  const firstError = results.find((r) => r.outcome !== "ok");
  if (firstError) {
    const { getExitCode } = await import("../lib/exit-codes.js");
    process.stderr.write(`error: ${results.filter((r) => r.outcome !== "ok").length} of ${results.length} Enrollments were refused; each refusal is listed.\n`);
    process.exit(getExitCode((firstError.error?.code ?? "INTERNAL") as never));
  }
}

// ---------------------------------------------------------------------------
// citty definitions
// ---------------------------------------------------------------------------

const online = (fn: (c: Curviate, f: EnrollmentFlags) => Promise<void>) => async ({ args }: { args: unknown }) => {
  const f = args as EnrollmentFlags;
  await fn(await rootClient(f), f);
};

const ID = { type: "positional" as const, description: "Enrollment id (enr_...)." };
const ROLE = { INSUFFICIENT_ROLE: "your role cannot operate the Enrollment's Account.", ACCOUNT_NOT_SHARED: "the Enrollment's Account is not shared with you." };
const NOT_ACTIVE = { ENROLLMENT_NOT_ACTIVE: "the Enrollment's status does not take this operation." };
const IN_FLIGHT = { STEP_IN_FLIGHT: "a Step of the Enrollment is being sent right now; read it again in a minute, then retry." };
const SEE = ["curviate enrollment get", "curviate enrollment list"];

const FILTER_ARGS = {
  motion: { type: "string" as const, description: "Only this Motion's Enrollments (mot_...)." },
  contact: { type: "string" as const, description: "Only this Contact's Enrollments (con_...)." },
  status: { type: "string" as const, description: "Comma list of pending, active, paused, finished, skipped." },
  step: { type: "string" as const, description: "Only Enrollments now at one of these Step ids: repeatable or a comma list." },
  version: { type: "string" as const, description: "Only Enrollments running this Sequence version (1 or more)." },
  "done-step": { type: "string" as const, description: "Only Enrollments that ran this Step id. With --outcome: how it ended." },
  outcome: { type: "string" as const, description: "With --done-step: executed, skipped, failed, accepted, not_accepted, replied, no_reply or seen." },
  reason: { type: "string" as const, description: "Comma list of reason codes (skip, finish or Step reasons; narrowed to --done-step when given)." },
  variant: { type: "string" as const, description: "Only Enrollments given this variant id." },
  relationship: { type: "string" as const, description: "Comma list of connected, not_connected, invite_pending, unknown: the Contact's relationship to the Account when it started." },
};

const listCmd = defineCommand({
  meta: {
    name: "list",
    description: "List Enrollments, newest first, filtered by Motion, Contact, status, current Step, or how a Step ended. Each counts once per Contact, Motion and Account.",
    risk: "read",
    output: ["Each reason code comes with its sentence beside it (`skip_reason` and `skip_message`, `finish_reason` and `finish_message`)."],
    examples: [
      "curviate enrollment list --motion mot_YOUR_MOTION_ID",
      "curviate enrollment list --motion mot_YOUR_MOTION_ID --done-step opener --outcome failed",
      "curviate enrollment list --motion mot_YOUR_MOTION_ID --reason already_connected,known_chat --relationship connected",
    ],
  },
  args: { ...readOnly(GLOBAL_FLAGS), ...FILTER_ARGS },
  run: online(runList),
});

const getCmd = defineCommand({
  meta: {
    name: "get",
    description: "One Enrollment with the history of its Steps: outcome, reason and its sentence, the Account that ran it. Metadata only, never the text sent.",
    risk: "read",
    examples: ["curviate enrollment get enr_YOUR_ENROLLMENT_ID"],
  },
  args: { ...readOnly(READ_SINGLE_FLAGS), id: ID },
  run: online(runGet),
});

const pauseCmd = defineCommand({
  meta: {
    name: "pause",
    description: "Hold one Enrollment until you resume it; its waits freeze with the time they had left. Replies are still recorded.",
    risk: "write",
    rules: {
      changes: "No Step of this Enrollment runs until it is resumed.",
      visible_to: "Your Team.",
      budget_rows: [],
      retry: "A second pause answers ENROLLMENT_NOT_ACTIVE; nothing changes.",
      undo: "`curviate enrollment resume <enrollment_id>`.",
    },
    errors: { ...NOT_ACTIVE, ...IN_FLIGHT, MOTION_STATUS_CONFLICT: "the Motion is archived or past its end.", ...ROLE },
    examples: ["curviate enrollment pause enr_YOUR_ENROLLMENT_ID"],
  },
  args: { ...WRITE_SINGLE_FLAGS, id: ID },
  run: online(single("pause")),
});

const resumeCmd = defineCommand({
  meta: {
    name: "resume",
    description:
      "Without --at: lift your own pause; the Enrollment continues where it was. With --at: jump to that Step of its Sequence version. " +
      "The jump is not guarded: it re-enters the Step even when that Step already sent, so a message can go out again. " +
      "To retry a failed Step use `curviate enrollment retry <enrollment_id>`, which acts only on a failure.",
    risk: "high",
    rules: {
      changes: "The Enrollment runs again from its Account; with --at, from the named Step.",
      visible_to: "The Contact, once its next Step reaches LinkedIn.",
      budget_rows: [],
      retry: "With --at, every call jumps again and may send again: read `curviate enrollment get <enrollment_id>` first.",
      undo: "`curviate enrollment pause <enrollment_id>`; what was sent stays sent.",
      blast_radius: "One Enrollment: one Contact, from one Account.",
    },
    errors: { ...NOT_ACTIVE, ...IN_FLIGHT, MOTION_STATUS_CONFLICT: "the Motion is archived or past its end.", ...ROLE },
    seeAlso: ["curviate enrollment retry", "curviate enrollment get"],
    examples: ["curviate enrollment resume enr_YOUR_ENROLLMENT_ID", "curviate enrollment resume enr_YOUR_ENROLLMENT_ID --at bump"],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    id: ID,
    at: { type: "string", description: "Jump to this Step id (the out-of-office path). Not guarded: a Step that already sent sends again." },
  },
  run: online(single("resume", (f) => (f.at === undefined ? undefined : { at: required("at", f.at, "a Step id") }))),
});

const retryCmd = defineCommand({
  meta: {
    name: "retry",
    description:
      "Retry the failed Step of one Enrollment. Acts only while that Step's latest outcome is failed, so a repeated retry never re-sends a delivered message. " +
      "Then waits for the Step's next record and prints it as {outcome, reason, message}; the Step may wait for pacing or a budget.",
    risk: "high",
    rules: {
      changes: "Resumes the Enrollment at its failed Step, which runs again when its Account may send.",
      visible_to: "The Contact, if the Step reaches LinkedIn.",
      budget_rows: [],
      retry: "Safe: with nothing failed it answers NOTHING_TO_RETRY and sends nothing.",
      undo: "`curviate enrollment pause <enrollment_id>` before the Step runs; what was sent stays sent.",
      blast_radius: "One Step of one Enrollment.",
    },
    errors: {
      NOTHING_TO_RETRY: "nothing to retry: the Enrollment's latest Step outcome is not failed.",
      ...IN_FLIGHT,
      ...NOT_ACTIVE,
      MOTION_STATUS_CONFLICT: "the Motion is archived or past its end.",
      ...ROLE,
    },
    output: ["The re-run's record, {step_id, outcome, reason, message}. Exit 7 when the wait runs out first: the Step is resumed; read it later."],
    seeAlso: ["curviate enrollment get", "curviate enrollment bulk"],
    examples: ["curviate enrollment retry enr_YOUR_ENROLLMENT_ID", "curviate enrollment retry enr_YOUR_ENROLLMENT_ID --wait-timeout 60000"],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    id: ID,
    "wait-timeout": { type: "string", description: "How long to wait for the re-run, in milliseconds (default 600000). --timeout stays the request timeout." },
  },
  run: online(runRetry),
});

const stopCmd = defineCommand({
  meta: {
    name: "stop",
    description: "Stop a pending, active or paused Enrollment: it finishes (stopped) and runs no further Step.",
    risk: "write",
    rules: {
      changes: "The Enrollment finishes with reason stopped.",
      visible_to: "Your Team.",
      budget_rows: [],
      retry: "A second stop answers ENROLLMENT_NOT_ACTIVE.",
      undo: "`curviate enrollment resume <enrollment_id> --at <step_id>` restarts it at a Step.",
    },
    errors: { ...NOT_ACTIVE, ...ROLE },
    examples: ["curviate enrollment stop enr_YOUR_ENROLLMENT_ID"],
  },
  args: { ...WRITE_SINGLE_FLAGS, id: ID },
  run: online(single("stop")),
});

const EVENT_ARGS = {
  ...WRITE_SINGLE_FLAGS,
  id: ID,
  name: { type: "positional" as const, description: "The event name a Step of its Sequence waits for (`until event.<name>`)." },
};
const eventMeta = (name: "event" | "signal", description: string, example: string) => ({
  name,
  description,
  risk: "write" as const,
  rules: {
    changes: "Records the event; a Step waiting for it continues. Fires no webhook.",
    visible_to: "Your Team; the Contact once the next Step runs.",
    budget_rows: [],
    retry: "A second event is recorded again; a Step already past the wait ignores it.",
    undo: "Cannot be undone; pause or stop the Enrollment to keep its next Step from running.",
  },
  errors: { ...NOT_ACTIVE, INVALID_REQUEST: "no Step of its version waits for this name; the message lists the awaited names.", ...ROLE },
  examples: [example],
});

const eventCmd = defineCommand({
  meta: eventMeta(
    "event",
    "Send a custom event to an active or paused Enrollment whose Sequence waits for it, for example once your agent wrote the researched text to the Contact's custom fields. Input only: fires no webhook.",
    "curviate enrollment event enr_YOUR_ENROLLMENT_ID research_ready",
  ),
  args: EVENT_ARGS,
  run: online(single("events", (f) => ({ name: f.name ?? "" }))),
});

const signalCmd = defineCommand({
  meta: eventMeta(
    "signal",
    "Deprecated alias of `curviate enrollment event`, accepted until 2027-01-19. Sends the same event.",
    "curviate enrollment signal enr_YOUR_ENROLLMENT_ID research_ready",
  ),
  args: EVENT_ARGS,
  async run(ctx) {
    process.stderr.write("warning: `curviate enrollment signal` is deprecated; use `curviate enrollment event`. It stops working on 2027-01-19.\n");
    await online(single("events", (f) => ({ name: f.name ?? "" })))(ctx);
  },
});

const reassignCmd = defineCommand({
  meta: {
    name: "reassign",
    description:
      "Move an Enrollment to another sending Account of its Motion; it restarts there at the first Step of its version (one you paused stays paused). " +
      "Refused, nothing changed, when its Account already engaged the person, the target already holds them, or the target has a chat with them.",
    risk: "high",
    rules: {
      changes: "The Enrollment restarts on the target Account; Steps already skipped are named in warnings.",
      visible_to: "The Contact, once the target Account's first Step reaches LinkedIn.",
      budget_rows: [],
      retry: "A second call to the same Account answers ALREADY_ENROLLED_ON_ACCOUNT.",
      undo: "Reassign it back while the target has not engaged the person yet.",
      blast_radius: "One Enrollment: one Contact, from one Account.",
    },
    errors: {
      ACCOUNT_NOT_FOUND: "the target is not a sending Account of the Motion.",
      ...NOT_ACTIVE,
      ...IN_FLIGHT,
      ACCOUNT_ALREADY_ENGAGED: "its current Account already did something the person can see.",
      ALREADY_ENROLLED_ON_ACCOUNT: "the target already holds this Contact in the Motion, or is the current Account.",
      KNOWN_CHAT: "the target already has a chat with the person.",
      ...ROLE,
    },
    seeAlso: ["curviate enrollment get", "curviate motion get"],
    examples: ["curviate enrollment reassign enr_YOUR_ENROLLMENT_ID --account acc_YOUR_ACCOUNT_ID"],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    id: ID,
    account: { type: "string", required: true, description: "The target sending Account of the Motion (acc_...). Never defaulted." },
  },
  run: online(single("reassign", (f) => ({ account_id: required("account", f.account, "the target Account (acc_...)") }))),
});

const bulkCmd = defineCommand({
  meta: {
    name: "bulk",
    description:
      "Pause, resume, stop, retry, send an event to or reassign many Enrollments in one call, named with --id or matched by --motion and the list filters. " +
      "Each is decided alone, as its own command would be; not atomic. Up to 1000 items: ids, or Enrollments the filters match. List with the same filters first to see the matches.",
    risk: "high",
    rules: {
      changes: "Each Enrollment gets the action as its single command would.",
      visible_to: "The Contacts whose next Step reaches LinkedIn.",
      budget_rows: [],
      retry: "A retried call is a new call: each Enrollment answers again on its own (a second stop is ENROLLMENT_NOT_ACTIVE for it).",
      undo: "Per Enrollment, as its single command says; what was sent stays sent.",
      blast_radius: "Up to 1000 items (Enrollments), every Contact and Account they cover.",
    },
    errors: { ...NOT_ACTIVE, NOTHING_TO_RETRY: "retry, per Enrollment: nothing failed.", ...IN_FLIGHT, ...ROLE },
    output: ["One line per Enrollment, `<enrollment_id> ok` or `<enrollment_id> error <code>: <message>`; with --json (or piped) the API's answer. Exit 0 when every one is ok, else the first refusal's exit."],
    seeAlso: SEE,
    examples: [
      "curviate enrollment bulk --action stop --id enr_A,enr_B",
      "curviate enrollment bulk --action retry --motion mot_YOUR_MOTION_ID --done-step opener --outcome failed",
    ],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    action: { type: "string", required: true, description: `One of ${ACTIONS.join(", ")}.` },
    id: { type: "string", description: "An Enrollment id (enr_...); repeatable, or a comma list. Not with --motion." },
    ...FILTER_ARGS,
    motion: { type: "string", description: "Act on this Motion's Enrollments (mot_...) that the other filters match. Not with --id." },
    at: { type: "string", description: "With --action resume: jump to this Step id (not guarded, see `curviate enrollment resume`)." },
    name: { type: "string", description: "With --action event: the event name." },
    account: { type: "string", description: "With --action reassign: the target sending Account (acc_...). Never defaulted." },
  },
  run: online(runBulk),
});

export const enrollmentCommand = defineCommand({
  meta: { name: "enrollment", description: DESCRIPTIONS.enrollment },
  subCommands: {
    list: listCmd,
    get: getCmd,
    pause: pauseCmd,
    resume: resumeCmd,
    retry: retryCmd,
    stop: stopCmd,
    event: eventCmd,
    signal: signalCmd,
    reassign: reassignCmd,
    bulk: bulkCmd,
  },
  async run() {
    const { showHelp } = await import("../lib/examples.js");
    await showHelp(enrollmentCommand, ["curviate", "enrollment"]);
  },
});
