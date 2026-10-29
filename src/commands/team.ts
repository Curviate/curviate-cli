/**
 * `curviate team`: the Team calls act in, its members and invites, its logo,
 * new Teams, and seats lent between your Teams. Root-scoped (`curviate.teams.*`,
 * `curviate.billing.seats.*`).
 *
 * `switch` is local: it rewrites the profile's `team` after checking the Team
 * is one of yours (`GET /v1/teams`, asked without a Team so a stale one cannot
 * refuse the check). The Team a call acts in is `--team`, then
 * `CURVIATE_TEAM`, then the profile's `team`.
 */
import { defineCommand } from "citty";
import { readFile } from "node:fs/promises";
import type { Curviate } from "@curviate/sdk";
import { DESCRIPTIONS } from "./descriptions.js";
import { GLOBAL_FLAGS, READ_SINGLE_FLAGS, WRITE_SINGLE_FLAGS, readOnly } from "../lib/global-flags.js";
import { renderSuccess, writeNdjsonItem } from "../lib/output.js";
import { buildPreviewOutput } from "../lib/preview.js";
import { streamAll, pageDelayFromFlags, readCursorFlag, readMaxPagesFlag, readableObject, readablePage, rejectPaginationModifiersWithoutAll } from "../lib/paginate.js";
import { intFlag } from "../lib/int-flag.js";
import { fail, listFlag, outputOpts, rootClient, usage, type RootFlags } from "../lib/root-command.js";
import { createClient } from "../lib/client.js";
import { resolveEffectiveConfig } from "../lib/resolve.js";
import { readConfig, writeProfile } from "../lib/config.js";

type TeamFlags = RootFlags & {
  team?: string;
  id?: string;
  name?: string;
  user?: string;
  role?: string;
  emails?: string;
  status?: string;
  counts?: boolean;
  "billing-owner"?: string;
  file?: string;
  to?: string;
  seat?: string;
  limit?: string;
  cursor?: string;
  all?: boolean;
  "max-pages"?: string;
  "page-delay"?: string;
};
type Rec = Record<string, unknown>;

const show = (result: unknown, f: TeamFlags) => renderSuccess(result, outputOpts(f), process);

/** One SDK call, or its `--preview` render for a write. */
const call = (method: string, args: (f: TeamFlags) => Rec, body: (f: TeamFlags) => unknown, run: (c: Curviate, f: TeamFlags) => Promise<unknown>) =>
  async ({ args: raw }: { args: unknown }): Promise<void> => {
    const f = raw as TeamFlags;
    const b = body(f);
    if (f.preview) {
      process.stdout.write(JSON.stringify(buildPreviewOutput({ method, args: args(f), body: (b ?? {}) as Rec })) + "\n");
      return;
    }
    const c = await rootClient(f);
    try {
      show(readableObject(await run(c, f)), f);
    } catch (err) {
      await fail(err, f);
    }
  };

/** A paginated read: one page, or every page as NDJSON with `--all`. */
const list = (page: (c: Curviate, p: Rec) => Promise<unknown>, params: (f: TeamFlags) => Rec = () => ({})) =>
  async ({ args: raw }: { args: unknown }): Promise<void> => {
    const f = raw as TeamFlags;
    rejectPaginationModifiersWithoutAll(f, process);
    const p = params(f);
    if (f.limit !== undefined) p["limit"] = intFlag("limit", f.limit, 1, 100);
    const cursor = readCursorFlag(f, process);
    if (cursor) p["cursor"] = cursor;
    const c = await rootClient(f);
    try {
      if (f.all) {
        const next = (q: Rec) => page(c, q) as Promise<{ items?: unknown[]; cursor?: string | null }>;
        for await (const item of streamAll(next, p, { maxPages: readMaxPagesFlag(f, process), out: process, pageDelayMs: pageDelayFromFlags(f) })) writeNdjsonItem(process, item, f.fields);
      } else {
        show(readablePage(await page(c, p)), f);
      }
    } catch (err) {
      await fail(err, f);
    }
  };

const nonEmpty = (flag: string, v: string | undefined): string => {
  if (v === undefined || v.trim() === "") usage(`${flag} is required and must not be empty.`);
  return v.trim();
};

// ---------------------------------------------------------------------------
// switch
// ---------------------------------------------------------------------------

type TeamRow = { team_id: string; name: string | null; is_current: boolean };

/** Rewrite the profile's `team` to one of the person's Teams, by id or exact name. */
async function runSwitch({ args: raw }: { args: unknown }): Promise<void> {
  const f = raw as TeamFlags;
  const wanted = nonEmpty("<team>", f.id);
  const cfg = await resolveEffectiveConfig({ apiKey: f["api-key"], baseUrl: f["base-url"], timeout: f.timeout, profile: f.profile });
  if (!cfg.apiKey) {
    process.stderr.write("error: no API key, run `curviate setup` or pass --api-key.\n");
    process.exit(3);
  }
  let rows: TeamRow[];
  try {
    const page = readablePage(await createClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, timeout: cfg.timeout, team: null }).teams.list({ limit: 100 }));
    rows = ((page as { items?: TeamRow[] }).items ?? []);
  } catch (err) {
    return fail(err, f);
  }
  const byName = rows.filter((t) => t.name === wanted);
  const row = rows.find((t) => t.team_id === wanted) ?? (byName.length === 1 ? byName[0] : undefined);
  if (!row) {
    usage(byName.length > 1
      ? `${byName.length} of your Teams are named "${wanted}": pass the team id (\`curviate team list\`).`
      : `"${wanted}" is not one of your Teams (\`curviate team list\`). For a Team you were just added to, run \`curviate setup --team <team_id>\`.`);
  }
  // A Team key acts only in its own Team: naming another would refuse every call.
  if (!cfg.apiKey.startsWith("cvt_all_") && !row.is_current) {
    process.stderr.write(`error: this key works only in its own Team. Run \`curviate setup --team ${row.team_id}\` for a key that reaches ${row.name ?? row.team_id}.\n`);
    process.exit(3);
  }
  const profile = f.profile ?? (await readConfig())?.active ?? "default";
  await writeProfile(profile, { team: row.team_id });
  show({ team_id: row.team_id, name: row.name, profile }, f);
}

// ---------------------------------------------------------------------------
// citty definitions
// ---------------------------------------------------------------------------

const USER = { type: "positional" as const, description: "The member's user id (usr_...)." };
const INVITE = { type: "positional" as const, description: "Invite id (inv_...)." };
const OWNERS = { INSUFFICIENT_ROLE: "only an Owner of the Team can do this." };
const PAGE_FLAGS = readOnly(GLOBAL_FLAGS);

const listCmd = defineCommand({
  meta: {
    name: "list",
    description: "The Teams you are a member of, with your role; is_current marks the Team this call acts in. --counts adds each Team's Tier, trial, Accounts, active Motions and, where you are an Owner, seats.",
    risk: "read",
    examples: ["curviate team list", "curviate team list --counts --json"],
  },
  args: { ...PAGE_FLAGS, counts: { type: "boolean", description: "Add each Team's counts (on every row for a key that works in all your Teams, on its own row for a Team key)." } },
  run: list((c, p) => c.teams.list(p as never), (f) => (f.counts ? { include: "counts" } : {})),
});

const getCmd = defineCommand({
  meta: { name: "get", description: "The Team this call acts in: its name, your role, and the Owner who receives invoices.", risk: "read", examples: ["curviate team get", "curviate team get --team tnt_01HZY3K8Q2"] },
  args: readOnly(READ_SINGLE_FLAGS),
  run: call("teams.getCurrent", () => ({}), () => undefined, (c) => c.teams.getCurrent()),
});

const updateCmd = defineCommand({
  meta: {
    name: "update",
    description: "Rename the Team, or name the Owner whose email receives invoices. Owners only.",
    risk: "write",
    errors: OWNERS,
    examples: ["curviate team update --name \"Acme (client)\"", "curviate team update --billing-owner usr_01HZY3K8Q2"],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    name: { type: "string", description: "The Team's new name, 1 to 80 characters." },
    "billing-owner": { type: "string", description: "An Owner of this Team (usr_...) who receives the invoices." },
  },
  run: call("teams.updateCurrent", () => ({}), (f) => updateBody(f), (c, f) => c.teams.updateCurrent(updateBody(f))),
});

function updateBody(f: TeamFlags): { name?: string; billing_owner_user_id?: string } {
  if (f.name === undefined && f["billing-owner"] === undefined) usage("pass --name, --billing-owner, or both.");
  return { ...(f.name !== undefined ? { name: f.name } : {}), ...(f["billing-owner"] !== undefined ? { billing_owner_user_id: f["billing-owner"] } : {}) };
}

const createCmd = defineCommand({
  meta: {
    name: "create",
    description: "Create a Team with you as its Owner, with no subscription or seat. Prints the Team and next_step: the header to send with a key for all your Teams, else the setup command for a key in the new Team.",
    risk: "write",
    rules: { retry: "Two identical calls create two Teams." },
    examples: ["curviate team create \"Acme (client)\""],
  },
  args: { ...WRITE_SINGLE_FLAGS, name: { type: "positional", description: "The Team's name, 1 to 80 characters." } },
  run: call("teams.create", () => ({}), (f) => ({ name: f.name }), (c, f) => c.teams.create({ name: nonEmpty("<name>", f.name) })),
});

const switchCmd = defineCommand({
  meta: {
    name: "switch",
    description: "Act in another of your Teams from now on: writes the Team to the profile (by id, or by its exact name). --team and CURVIATE_TEAM still override it per call.",
    risk: "write",
    examples: ["curviate team switch tnt_01HZY3K8Q2", "curviate team switch \"Acme (client)\" --profile work"],
  },
  args: { ...readOnly(READ_SINGLE_FLAGS), id: { type: "positional", description: "Team id (tnt_...) or its exact name." } },
  run: runSwitch,
});

const membersCmd = defineCommand({
  meta: { name: "members", description: "Everyone in the Team, oldest membership first, with their role. Every role may read it.", risk: "read", examples: ["curviate team members", "curviate team members --all"] },
  args: PAGE_FLAGS,
  run: list((c, p) => c.teams.listMembers(p as never)),
});

const roleCmd = defineCommand({
  meta: {
    name: "role",
    description: "Set a member's role: owner, manager or member. The Team always keeps an Owner. Owners only.",
    risk: "write",
    errors: { ...OWNERS, LAST_OWNER: "the Team must keep one Owner.", BILLING_OWNER_REQUIRED: "name another Owner to receive invoices first (`curviate team update --billing-owner`)." },
    examples: ["curviate team role usr_01HZY3K8Q2 manager"],
  },
  args: { ...WRITE_SINGLE_FLAGS, user: USER, role: { type: "positional", description: "owner, manager or member." } },
  run: call("teams.updateMember", (f) => ({ user_id: f.user }), (f) => ({ role: f.role }), (c, f) => c.teams.updateMember(nonEmpty("<user>", f.user), { role: nonEmpty("<role>", f.role) as never })),
});

const removeCmd = defineCommand({
  meta: {
    name: "remove",
    description: "Remove a member from the Team. Their Accounts here are disconnected and their key and connectors for this Team stop working at once. Owners only.",
    risk: "high",
    errors: { ...OWNERS, LAST_OWNER: "the Team must keep one Owner.", DEFAULT_TEAM_PROTECTED: "nobody is removed from their own default Team." },
    examples: ["curviate team remove usr_01HZY3K8Q2"],
  },
  args: { ...WRITE_SINGLE_FLAGS, user: USER },
  run: call("teams.removeMember", (f) => ({ user_id: f.user }), () => undefined, (c, f) => c.teams.removeMember(nonEmpty("<user>", f.user))),
});

const leaveCmd = defineCommand({
  meta: {
    name: "leave",
    description: "Leave the Team this call acts in. Your Accounts here are disconnected; you can never leave your own default Team.",
    risk: "high",
    errors: { DEFAULT_TEAM_PROTECTED: "you can never leave your own default Team.", LAST_OWNER: "the Team must keep one Owner." },
    examples: ["curviate team leave --team tnt_01HZY3K8Q2"],
  },
  args: WRITE_SINGLE_FLAGS,
  run: call("teams.removeMember", () => ({ user_id: "me" }), () => undefined, (c) => c.teams.removeMember("me")),
});

const invitesCmd = defineCommand({
  meta: { name: "invites", description: "Invite people to the Team, list, resend or revoke invites. Owners only." },
  subCommands: {
    create: defineCommand({
      meta: {
        name: "create",
        description: "Invite 1 to 20 people by email, comma-separated, each with --role (default member). Owners only.",
        risk: "write",
        errors: { ...OWNERS, ALREADY_MEMBER: "that person is already in the Team." },
        examples: ["curviate team invites create dana@example.com", "curviate team invites create dana@example.com,lee@example.com --role manager"],
      },
      args: { ...WRITE_SINGLE_FLAGS, emails: { type: "positional", description: "Email addresses, comma-separated." }, role: { type: "string", description: "owner, manager or member (default)." } },
      run: call("teams.createInvites", () => ({}), (f) => inviteBody(f), (c, f) => c.teams.createInvites(inviteBody(f) as never)),
    }),
    list: defineCommand({
      meta: { name: "list", description: "The Team's invites, newest first; never the invite link. Owners only.", risk: "read", examples: ["curviate team invites list", "curviate team invites list --status pending"] },
      args: { ...PAGE_FLAGS, status: { type: "string", description: "pending, expired, accepted or revoked." } },
      run: list((c, p) => c.teams.listInvites(p as never), (f) => (f.status !== undefined ? { status: nonEmpty("--status", f.status) } : {})),
    }),
    resend: defineCommand({
      meta: { name: "resend", description: "Send a pending invite's email again, with a fresh link. Owners only.", risk: "write", errors: OWNERS, examples: ["curviate team invites resend inv_01HZY3K8Q2"] },
      args: { ...WRITE_SINGLE_FLAGS, id: INVITE },
      run: call("teams.resendInvite", (f) => ({ invite_id: f.id }), () => undefined, (c, f) => c.teams.resendInvite(nonEmpty("<invite_id>", f.id))),
    }),
    revoke: defineCommand({
      meta: { name: "revoke", description: "Revoke a pending invite: its link stops working. Owners only.", risk: "write", errors: OWNERS, examples: ["curviate team invites revoke inv_01HZY3K8Q2"] },
      args: { ...WRITE_SINGLE_FLAGS, id: INVITE },
      run: call("teams.revokeInvite", (f) => ({ invite_id: f.id }), () => undefined, (c, f) => c.teams.revokeInvite(nonEmpty("<invite_id>", f.id))),
    }),
  },
});

function inviteBody(f: TeamFlags): Rec {
  const emails = listFlag("emails", nonEmpty("<emails>", f.emails));
  return { invites: emails.map((email) => ({ email, ...(f.role !== undefined ? { role: f.role } : {}) })) };
}

const logoCmd = defineCommand({
  meta: { name: "logo", description: "Set or remove the Team's logo. Owners only." },
  subCommands: {
    set: defineCommand({
      meta: { name: "set", description: "Set the Team's logo from a PNG file of at most 1 MB; replaces the previous one. Owners only.", risk: "write", errors: OWNERS, examples: ["curviate team logo set ./logo.png"] },
      args: { ...WRITE_SINGLE_FLAGS, file: { type: "positional", description: "Path to a PNG, at most 1 MB." } },
      run: call("teams.setLogo", (f) => ({ file: f.file }), () => undefined, async (c, f) => {
        const path = nonEmpty("<file>", f.file);
        let png: Uint8Array;
        try {
          png = new Uint8Array(await readFile(path));
        } catch {
          usage(`cannot read ${path}.`);
        }
        return c.teams.setLogo(png);
      }),
    }),
    remove: defineCommand({
      meta: { name: "remove", description: "Remove the Team's logo. Removing a logo that is not set changes nothing. Owners only.", risk: "write", errors: OWNERS, examples: ["curviate team logo remove"] },
      args: WRITE_SINGLE_FLAGS,
      run: call("teams.removeLogo", () => ({}), () => undefined, (c) => c.teams.removeLogo()),
    }),
  },
});

const seatsCmd = defineCommand({
  meta: { name: "seats", description: "Lend an unused paid seat to another of your Teams, or take it back." },
  subCommands: {
    lend: defineCommand({
      meta: {
        name: "lend",
        description: "Move an unused paid seat of this Team to another of your Teams at no charge; it stays on this Team's invoice. Only the Owner who pays for both Teams may lend. Each call lends one more seat.",
        risk: "write",
        rules: { retry: "Each call lends one more seat.", undo: "`curviate team seats return <seat_id>`." },
        errors: { BILLING_OWNER_REQUIRED: "only the Owner who pays for both Teams may lend.", SEAT_LENT: "that seat is already lent." },
        examples: ["curviate team seats lend --to tnt_01HZY3K8Q2", "curviate team seats lend --to tnt_01HZY3K8Q2 --seat seat_01HZY3K8Q2"],
      },
      args: {
        ...WRITE_SINGLE_FLAGS,
        to: { type: "string", required: true, description: "The Team that receives the seat (tnt_...)." },
        seat: { type: "string", description: "The seat to lend (seat_...); default any unused paid seat." },
      },
      run: call("billing.seats.lend", () => ({}), (f) => lendBody(f), (c, f) => c.billing.seats.lend(lendBody(f) as never)),
    }),
    return: defineCommand({
      meta: {
        name: "return",
        description: "End a seat loan while no Account uses the seat. Run it in either Team, with that Team's id for the seat.",
        risk: "write",
        examples: ["curviate team seats return seat_01HZY3K8Q2"],
      },
      args: { ...WRITE_SINGLE_FLAGS, id: { type: "positional", description: "Seat id (seat_...)." } },
      run: call("billing.seats.return", (f) => ({ seat_id: f.id }), () => undefined, (c, f) => c.billing.seats.return(nonEmpty("<seat_id>", f.id))),
    }),
  },
});

function lendBody(f: TeamFlags): Rec {
  return { team_id: nonEmpty("--to", f.to), ...(f.seat !== undefined ? { seat_id: nonEmpty("--seat", f.seat) } : {}) };
}

export const teamCommand = defineCommand({
  meta: { name: "team", description: DESCRIPTIONS.team },
  subCommands: {
    list: listCmd,
    get: getCmd,
    switch: switchCmd,
    create: createCmd,
    update: updateCmd,
    members: membersCmd,
    role: roleCmd,
    remove: removeCmd,
    leave: leaveCmd,
    invites: invitesCmd,
    logo: logoCmd,
    seats: seatsCmd,
  },
  async run() {
    const { showHelp } = await import("../lib/examples.js");
    await showHelp(teamCommand, ["curviate", "team"]);
  },
});
