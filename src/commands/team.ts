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
const OWNERS_MANAGERS = { INSUFFICIENT_ROLE: "only an Owner or a Manager of the Team can do this." };
const INVITE_ROLES = { INSUFFICIENT_ROLE: "only an Owner or a Manager of the Team can do this, and a Manager acts on Member invites only." };
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
    description: "Rename the Team (Owners and Managers), or name the Owner whose email receives invoices (Owners only).",
    risk: "write",
    rules: {
      changes: "Renames the Team, or names the Owner whose email receives invoices.",
      visible_to: "Everyone in the Team; the billing Owner receives the invoices.",
      budget_rows: [],
      retry: "Safe: the same values written again leave the Team the same.",
      undo: "Run it again with the previous values.",
    },
    errors: { INSUFFICIENT_ROLE: "only an Owner or a Manager renames the Team; only an Owner sets --billing-owner.", BILLING_OWNER_REQUIRED: "--billing-owner must name an Owner of this Team." },
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
    rules: {
      changes: "Creates a Team with you as its Owner, with no subscription or seat.",
      visible_to: "You alone, until you invite people (`curviate team invites create`).",
      budget_rows: [],
      retry: "Two identical calls create two Teams.",
      undo: "The CLI cannot delete a Team: leave it with `curviate team leave --team <team_id>` once another Owner holds it.",
    },
    errors: { INVALID_REQUEST: "the name is empty or longer than allowed." },
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
    rules: {
      changes: "Writes the Team to the local profile; later calls act in it unless --team or CURVIATE_TEAM says otherwise.",
      visible_to: "Nobody else: the profile stays on this machine.",
      budget_rows: [],
      retry: "Safe: the same result every time.",
      undo: "Switch back with `curviate team switch <team>` and the previous Team.",
    },
    errors: { TEAM_ACCESS_DENIED: "this key works only in its own Team: run `curviate setup --team <team_id>` for a key that reaches the other one.", INVALID_REQUEST: "the Team is not one of yours, or several share the name." },
    examples: ["curviate team switch tnt_01HZY3K8Q2", "curviate team switch \"Acme (client)\" --profile work"],
  },
  args: { ...readOnly(READ_SINGLE_FLAGS), id: { type: "positional", description: "Team id (tnt_...) or its exact name." } },
  run: runSwitch,
});

const membersCmd = defineCommand({
  meta: { name: "members", description: "Everyone in the Team, oldest membership first, with their role and name (their email when they set no name). Every role may read it.", risk: "read", examples: ["curviate team members", "curviate team members --all"] },
  args: PAGE_FLAGS,
  run: list((c, p) => c.teams.listMembers(p as never)),
});

const roleCmd = defineCommand({
  meta: {
    name: "role",
    description: "Set a member's role: owner, manager or member. The Team always keeps an Owner. Owners only.",
    risk: "write",
    rules: {
      changes: "Sets the member's role in this Team.",
      visible_to: "The member and the Team's Owners.",
      budget_rows: [],
      retry: "Safe: the same role written again changes nothing.",
      undo: "Set the previous role.",
    },
    errors: { ...OWNERS, LAST_OWNER: "the Team must keep one Owner.", BILLING_OWNER_REQUIRED: "name another Owner to receive invoices first (`curviate team update --billing-owner`)." },
    examples: ["curviate team role usr_01HZY3K8Q2 manager"],
  },
  args: { ...WRITE_SINGLE_FLAGS, user: USER, role: { type: "positional", description: "owner, manager or member." } },
  run: call("teams.updateMember", (f) => ({ user_id: f.user }), (f) => ({ role: f.role }), (c, f) => c.teams.updateMember(nonEmpty("<user>", f.user), { role: nonEmpty("<role>", f.role) as never })),
});

const removeCmd = defineCommand({
  meta: {
    name: "remove",
    description: "Remove a member from the Team. Their Accounts here are disconnected and their key and connectors for this Team stop working at once. An Owner removes anyone; a Manager removes Members.",
    risk: "high",
    rules: {
      changes: "The member leaves the Team; their Accounts here are disconnected and their key and connectors for it stop working.",
      visible_to: "The member, who loses access at once.",
      budget_rows: [],
      retry: "Safe: a member already gone has nothing left to remove.",
      undo: "Cannot be undone for their Accounts, which are disconnected; invite them again with `curviate team invites create`.",
      blast_radius: "One member and every Account they connected to this Team.",
    },
    errors: { INSUFFICIENT_ROLE: "only an Owner removes someone else; a Manager removes Members only.", LAST_OWNER: "the Team must keep one Owner.", DEFAULT_TEAM_PROTECTED: "nobody is removed from their own default Team." },
    seeAlso: ["curviate team members", "curviate team invites create"],
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
    rules: {
      changes: "You leave the Team; your Accounts here are disconnected and your key for it stops working.",
      visible_to: "The Team's members, who no longer see you.",
      budget_rows: [],
      retry: "Safe: once you have left, a repeat is refused.",
      undo: "Cannot be undone for your Accounts, which are disconnected; an Owner can invite you again.",
      blast_radius: "You and every Account you connected to this Team.",
    },
    errors: { DEFAULT_TEAM_PROTECTED: "you can never leave your own default Team.", LAST_OWNER: "the Team must keep one Owner." },
    seeAlso: ["curviate team members"],
    examples: ["curviate team leave --team tnt_01HZY3K8Q2"],
  },
  args: WRITE_SINGLE_FLAGS,
  run: call("teams.removeMember", () => ({ user_id: "me" }), () => undefined, (c) => c.teams.removeMember("me")),
});

const invitesCmd = defineCommand({
  meta: { name: "invites", description: "Invite people to the Team, list, resend or revoke invites. Owners and Managers (a Manager invites Members only)." },
  subCommands: {
    create: defineCommand({
      meta: {
        name: "create",
        description: "Invite people by email, comma-separated, each with --role (default member). Owners and Managers (a Manager invites Members only).",
        risk: "write",
        rules: {
          changes: "Emails an invite, with a link, to each address.",
          visible_to: "Each invitee, by email.",
          budget_rows: [],
          retry: "A repeat for an invite still pending answers INVITE_ALREADY_PENDING and sends nothing new.",
          undo: "`curviate team invites revoke <invite_id>` makes the link stop working.",
        },
        errors: { ...INVITE_ROLES, ALREADY_MEMBER: "that person is already in the Team.", INVITE_ALREADY_PENDING: "that person has a pending invite.", INVITE_LIMIT_REACHED: "the Team has as many pending invites as it may." },
        examples: ["curviate team invites create dana@example.com", "curviate team invites create dana@example.com,lee@example.com --role manager"],
      },
      args: { ...WRITE_SINGLE_FLAGS, emails: { type: "positional", description: "Email addresses, comma-separated." }, role: { type: "string", description: "owner, manager or member (default)." } },
      run: call("teams.createInvites", () => ({}), (f) => inviteBody(f), (c, f) => c.teams.createInvites(inviteBody(f) as never)),
    }),
    list: defineCommand({
      meta: { name: "list", description: "The Team's invites, newest first; never the invite link. Owners and Managers.", risk: "read", examples: ["curviate team invites list", "curviate team invites list --status pending"] },
      args: { ...PAGE_FLAGS, status: { type: "string", description: "pending, expired, accepted or revoked." } },
      run: list((c, p) => c.teams.listInvites(p as never), (f) => (f.status !== undefined ? { status: nonEmpty("--status", f.status) } : {})),
    }),
    resend: defineCommand({
      meta: {
        name: "resend",
        description: "Send a pending invite's email again, with a fresh link. Owners, and Managers for Member invites.",
        risk: "write",
        rules: {
          changes: "Sends the invite email again, with a fresh link that replaces the old one.",
          visible_to: "The invitee, by email.",
          budget_rows: [],
          retry: "Each call sends another email.",
          undo: "`curviate team invites revoke <invite_id>` makes the link stop working.",
        },
        errors: { ...INVITE_ROLES, INVITE_NOT_PENDING: "the invite was accepted, revoked or has expired." },
        examples: ["curviate team invites resend inv_01HZY3K8Q2"],
      },
      args: { ...WRITE_SINGLE_FLAGS, id: INVITE },
      run: call("teams.resendInvite", (f) => ({ invite_id: f.id }), () => undefined, (c, f) => c.teams.resendInvite(nonEmpty("<invite_id>", f.id))),
    }),
    revoke: defineCommand({
      meta: {
        name: "revoke",
        description: "Revoke a pending invite: its link stops working. Owners, and Managers for Member invites.",
        risk: "write",
        rules: {
          changes: "The invite's link stops working.",
          visible_to: "The invitee, whose link no longer opens.",
          budget_rows: [],
          retry: "A second call answers INVITE_NOT_PENDING and changes nothing.",
          undo: "`curviate team invites create <email>` sends a new invite.",
        },
        errors: { ...INVITE_ROLES, INVITE_NOT_PENDING: "the invite was accepted, revoked or has expired." },
        examples: ["curviate team invites revoke inv_01HZY3K8Q2"],
      },
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
  meta: { name: "logo", description: "Set or remove the Team's logo. Owners and Managers." },
  subCommands: {
    set: defineCommand({
      meta: {
        name: "set",
        description: "Set the Team's logo from a PNG file; replaces the previous one. Owners and Managers.",
        risk: "write",
        rules: {
          changes: "Replaces the Team's logo with the PNG.",
          visible_to: "Everyone in the Team, in the dashboard.",
          budget_rows: [],
          retry: "Safe: the same file written again leaves the logo the same.",
          undo: "`curviate team logo remove`; the previous logo is not kept.",
        },
        errors: OWNERS_MANAGERS,
        examples: ["curviate team logo set ./logo.png"],
      },
      args: { ...WRITE_SINGLE_FLAGS, file: { type: "positional", description: "Path to a PNG." } },
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
      meta: {
        name: "remove",
        description: "Remove the Team's logo. Removing a logo that is not set changes nothing. Owners and Managers.",
        risk: "write",
        rules: {
          changes: "Removes the Team's logo.",
          visible_to: "Everyone in the Team, in the dashboard.",
          budget_rows: [],
          retry: "Safe: removing a logo that is not set changes nothing.",
          undo: "`curviate team logo set <file>` with the PNG; the removed logo is not kept.",
        },
        errors: OWNERS_MANAGERS,
        examples: ["curviate team logo remove"],
      },
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
        rules: {
          changes: "One unused paid seat moves to the Team named by --to, at no charge; it stays on this Team's invoice.",
          visible_to: "Both Teams: the receiving Team gains a seat to connect an Account to.",
          budget_rows: [],
          retry: "Each call lends one more seat.",
          undo: "`curviate team seats return <seat_id>`.",
        },
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
        rules: {
          changes: "Ends the loan: the seat goes back to the Team that lent it.",
          visible_to: "Both Teams.",
          budget_rows: [],
          retry: "A second call finds no loan to end.",
          undo: "`curviate team seats lend --to <team_id> --seat <seat_id>` lends it again.",
        },
        errors: { SEAT_NOT_FOUND: "no seat has this id.", SEAT_NOT_EMPTY: "an Account still uses the seat: disconnect it first." },
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
