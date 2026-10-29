/**
 * The Contact filter shared by `contact list`, `contact export`, the bulk
 * update and delete, and `contact lists combine`: the same flags, the same
 * checks, two wire shapes (a query string; a `filter` object whose lists are
 * arrays). Lists, tags and statuses are repeatable or comma lists.
 */
import type { Curviate } from "@curviate/sdk";
import { requireAccount } from "./account-arg.js";
import { listFlag, usage, type RootFlags } from "./root-command.js";

export type FilterFlags = {
  list?: string | string[];
  "list-match"?: string;
  "not-list"?: string | string[];
  tag?: string | string[];
  motion?: string;
  status?: string;
  connected?: boolean;
  "connected-account"?: string;
  import?: string;
  "enrichment-status"?: string;
  query?: string;
  "linkedin-url"?: string;
  "has-email"?: boolean;
  "no-email"?: boolean;
};

export const FILTER_ARGS = {
  list: { type: "string" as const, description: "Only Contacts in this Contact list (cl_...); repeatable, or a comma list of up to 20. In any of them unless --list-match all." },
  "list-match": { type: "string" as const, description: "With --list: any (default, in at least one) or all (in every one)." },
  "not-list": { type: "string" as const, description: "Only Contacts in none of these Contact lists (cl_...); repeatable, or a comma list of up to 20." },
  tag: { type: "string" as const, description: "Only Contacts with this Tag, any casing; repeatable: with any of them." },
  motion: { type: "string" as const, description: "Only Contacts with an Enrollment in this Motion (mot_...)." },
  status: { type: "string" as const, description: "With --motion: comma list of Enrollment statuses (queued, active, paused, finished, failed, skipped)." },
  connected: { type: "boolean" as const, description: "Only Connections of your Accounts (--no-connected: everyone else)." },
  "connected-account": { type: "string" as const, description: "Only Connections of this Account (acc_... or its name). Explicit: never filled from the default Account." },
  import: { type: "string" as const, description: "Only Contacts in this import's report (imp_...), while the import exists." },
  "enrichment-status": { type: "string" as const, description: "none, queued, done or failed." },
  query: { type: "string" as const, description: "Text match on names, headline, job title, company, email, location and profile slug." },
  "linkedin-url": { type: "string" as const, description: "The Contact for this person, any URL spelling." },
  "has-email": { type: "boolean" as const, description: "Only Contacts with an email address." },
  "no-email": { type: "boolean" as const, description: "Only Contacts without an email address." },
};

/** Does the command line carry any filter flag? */
export const hasFilter = (f: FilterFlags): boolean => Object.keys(FILTER_ARGS).some((k) => (f as Record<string, unknown>)[k] !== undefined);

const MAX_LISTS = 20;
const ENRICHMENT = ["none", "queued", "done", "failed"];

const text = (flag: string, v: string | undefined): string | undefined => {
  if (v === undefined) return undefined;
  if (v.trim() === "") usage(`--${flag} was given an empty value.`);
  return v;
};

/**
 * The filter as the API takes it. `query`: the listing's parameters (lists
 * comma-joined); `body`: a `filter` object (lists as arrays). Refuses what the
 * API would, before any request.
 */
export async function readFilter(c: Curviate, f: FilterFlags & RootFlags, shape: "query" | "body"): Promise<Record<string, unknown>> {
  const q: Record<string, unknown> = {};
  const join = (v: string[]) => (shape === "query" ? v.join(",") : v);
  const lists = listFlag("list", f.list);
  const notLists = listFlag("not-list", f["not-list"]);
  for (const [flag, ids] of [["list", lists], ["not-list", notLists]] as const) {
    if (ids.length > MAX_LISTS) usage(`--${flag} takes up to ${MAX_LISTS} lists.`);
  }
  if (lists.length) q["list_id"] = join(lists);
  if (notLists.length) q["not_list_id"] = join(notLists);
  if (f["list-match"] !== undefined) {
    if (f["list-match"] !== "any" && f["list-match"] !== "all") usage("--list-match takes any or all.");
    if (!lists.length) usage("--list-match needs --list.");
    q["list_match"] = f["list-match"];
  }
  const tags = listFlag("tag", f.tag);
  if (tags.length) q["tag"] = join(tags);
  const motion = text("motion", f.motion);
  if (motion) q["motion_id"] = motion;
  if (f.status !== undefined) {
    if (!motion) usage("--status needs --motion: it filters that Motion's Enrollments.");
    q["enrollment_status"] = join(listFlag("status", f.status));
  }
  // The parser reads `--no-email` as the negation of an `email` flag.
  const noEmail = f["no-email"] === true || (f as { email?: boolean }).email === false;
  if (f["has-email"] && noEmail) usage("--has-email and --no-email cannot be combined.");
  if (f["has-email"]) q["has_email"] = true;
  if (noEmail) q["has_email"] = false;
  if (f.connected !== undefined) q["connected"] = f.connected;
  if (f["connected-account"] !== undefined) {
    if (f.connected === false) usage("--connected-account and --no-connected cannot be combined.");
    // Explicit only: the resolver is handed this flag, never CURVIATE_ACCOUNT or the profile's Account.
    q["account_id"] = await requireAccount(c, { account: text("connected-account", f["connected-account"]), preview: f.preview }, process);
  }
  const imp = text("import", f.import);
  if (imp) q["import_id"] = imp;
  if (f["enrichment-status"] !== undefined) {
    if (!ENRICHMENT.includes(f["enrichment-status"])) usage(`--enrichment-status takes one of ${ENRICHMENT.join(", ")}.`);
    q["enrichment_status"] = f["enrichment-status"];
  }
  const query = text("query", f.query);
  if (query) q["q"] = query;
  const url = text("linkedin-url", f["linkedin-url"]);
  if (url) q["linkedin_url"] = url;
  return q;
}
