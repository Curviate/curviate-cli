/** `job` group: get (slim/verbose), list (+ re-filter, ALL union), create/update/publish/close, applicants, resume, flag hygiene. */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CurviateError } from "@curviate/sdk";
import {
  jobCommand, runJobApplicantGet, runJobApplicantResume, runJobApplicants, runJobBudget, runJobClose, runJobCreate,
  runJobGet, runJobList, runJobPublish, runJobUpdate,
} from "../../src/commands/job.js";
import { exitCode } from "../helpers/exit-code.js";
import { calls, go, mkEnv, ndjson, previews, refuses, text, type Args, type Env, type Run } from "../helpers/f3-unit.js";

const SHAPE = {
  jobs: {
    get: { object: "job_posting", id: "4428113858" },
    list: { object: "job_list", items: [], cursor: null },
    create: { object: "job_posting", id: "job_1" },
    update: { object: "job_posting", id: "job_1" },
    getBudget: { object: "job_budget" },
    publish: { object: "job_posting", state: "LISTED" },
    close: { object: "job_posting", state: "CLOSED" },
    listApplicants: { object: "applicant_list", items: [], cursor: null },
    getApplicant: { object: "applicant", id: "app_1" },
    downloadResume: new TextEncoder().encode("%PDF-bytes").buffer,
  },
};
const richJob = {
  object: "job_posting", id: "4428113858", title: "Founders Associate", company: { id: "67756343", name: "LEAGUES", public_identifier: "leagues" },
  state: "LISTED", location: "Stuttgart, Germany", cost: 0, applications_count: 75, description: "Über deine Rolle: build the founding team.",
  created_at: "2026-06-12T10:07:09.000Z", hiring_team: [],
};
const createFlags = {
  "job-title": "Founders Associate", company: "LEAGUES", "workplace-type": "HYBRID", location: "loc_123", "employment-status": "FULL_TIME",
  description: "A".repeat(220), "apply-method": "linkedin", "notification-email": "jobs@example.com",
};
const stderr = (e: Env) => e.out.stderr.write.mock.calls.map((c) => String(c[0])).join("");
const posting = (id: string, state: string) => ({ object: "job_posting", id, title: id, state });
const page = (items: object[], cursor: string | null = null) => ({ object: "job_posting_list", items, cursor });
const withList = (impl: (p: { state: string; cursor?: string }) => unknown) => (e: Env) => e.fn("jobs.list").mockImplementation(async (p: never) => impl(p));

/** Exit 2, the flag named on stderr, no SDK call. */
async function refusal(run: Run, args: Args, flag: string) {
  const e = mkEnv(SHAPE);
  expect(await exitCode(() => run(e.client as never, { account: "acc_1", ...args }, e.out as never))).toBe(2);
  expect(stderr(e)).toContain(flag);
  expect(Object.values(e.ns["jobs"]!).some((m) => m.mock.calls.length)).toBe(false);
}

describe("job get", () => {
  calls(SHAPE, [
    ["a job URL resolves to the numeric id", runJobGet, { id: "https://www.linkedin.com/jobs/view/4428113858" }, "jobs.get", ["4428113858"]],
    ["a bare id is the identical request", runJobGet, { id: "4428113858" }, "jobs.get", ["4428113858"]],
  ]);
  const read = async (args: Args) => JSON.parse(text((await go(SHAPE, runJobGet, { id: "4428113858", ...args }, (e) => e.fn("jobs.get").mockResolvedValue(richJob))).out)) as Record<string, unknown>;

  it("scopes the call to --account", async () => {
    expect((await go(SHAPE, runJobGet, { id: "4428113858", account: "acc_9" })).client.account).toHaveBeenCalledWith("acc_9");
  });

  it("slim: the 10 documented fields, description kept, hiring_team/cost dropped, company_id from company.id, published_at from created_at", async () => {
    const r = await read({});
    expect(Object.keys(r)).toHaveLength(10);
    expect(r).toMatchObject({ description: richJob.description, company_id: "67756343", applications_count: 75, published_at: richJob.created_at });
    for (const k of ["hiring_team", "cost", "applicants_counter"]) expect(r).not.toHaveProperty(k);
  });

  it("--verbose is the full response; json is on by default when stdout is not a TTY", async () => {
    expect(await read({ verbose: true })).toMatchObject({ hiring_team: [], cost: 0, created_at: richJob.created_at });
    expect(Object.keys(await read({ json: undefined })).length).toBeGreaterThan(0);
  });

  it("an unknown job exits 4 with the code in the --json error envelope", async () => {
    const e = mkEnv(SHAPE);
    e.fn("jobs.get").mockRejectedValue(new CurviateError({ code: "RESOURCE_NOT_FOUND", message: "Job offer not found", httpStatus: 404, userFixable: true, retryLikelyToSucceed: false }));
    expect(await exitCode(() => runJobGet(e.client as never, { id: "9999999999999", account: "acc_1", json: true }, e.out as never))).toBe(4);
    expect(JSON.parse(text(e.out)).error.code).toBe("RESOURCE_NOT_FOUND");
  });

  refuses(SHAPE, [["no connected account", runJobGet, { id: "4428113858", account: null }, 2]]);
});

describe("job list", () => {
  calls(SHAPE, [
    ["--state OPEN", runJobList, { state: "OPEN" }, "jobs.list", [{ state: "OPEN" }]],
    ["--limit/--cursor travel alongside state", runJobList, { state: "OPEN", limit: "10", cursor: "c1" }, "jobs.list", [{ state: "OPEN", limit: 10, cursor: "c1" }]],
  ]);
  refuses(SHAPE, [
    ["an out-of-enum --state", runJobList, { state: "ARCHIVED" }, 2],
    ["a non-enum, non-ALL state", runJobList, { state: "BOGUS" }, 2],
  ]);
  it("without --state: exit 2 naming the flag", () => refusal(runJobList, {}, "--state"));

  it("re-filters by the item's own state (OPEN is LISTED); notes the drop count; cursor and envelope pass through", async () => {
    const items = [posting("job_1", "LISTED"), posting("job_2", "DRAFT"), posting("job_3", "CLOSED")];
    const e = await go(SHAPE, runJobList, { state: "OPEN" }, (x) => x.fn("jobs.list").mockResolvedValue(page(items, "cur_next")));
    expect(JSON.parse(text(e.out))).toEqual(page([items[0]!], "cur_next"));
    expect(stderr(e)).toMatch(/dropped 2 of 3/i);
    const draft = await go(SHAPE, runJobList, { state: "DRAFT" }, (x) => x.fn("jobs.list").mockResolvedValue(page(items)));
    expect(JSON.parse(text(draft.out)).items).toEqual([items[1]]);
    const clean = await go(SHAPE, runJobList, { state: "OPEN" }, (x) => x.fn("jobs.list").mockResolvedValue(page([items[0]!])));
    expect(clean.out.stderr.write).not.toHaveBeenCalled();
  });

  it("--all re-filters each streamed item and still walks every upstream page", async () => {
    const e = await go(SHAPE, runJobList, { state: "OPEN", all: true, json: undefined }, (x) =>
      x.fn("jobs.list").mockResolvedValueOnce(page([posting("job_1", "LISTED"), posting("job_2", "DRAFT")], "cur_2")).mockResolvedValueOnce(page([posting("job_3", "LISTED")])),
    );
    expect(e.fn("jobs.list").mock.calls[1]![0]).toMatchObject({ cursor: "cur_2" });
    expect(ndjson(e.out).map((l) => JSON.parse(l).id)).toEqual(["job_1", "job_3"]);
    expect(stderr(e)).toMatch(/dropped 1 of 2/i);
  });

  describe("--state ALL: the best-effort client-side union", () => {
    const STATES = ["DRAFT", "OPEN", "CLOSED", "REVIEW", "SUSPENDED"];
    const onePerState = (p: { state: string }) => page([posting(`job_${p.state}`, p.state === "OPEN" ? "LISTED" : p.state)]);

    it("queries every enum state once, merges into one envelope, and surfaces the caveat on stderr", async () => {
      const e = await go(SHAPE, runJobList, { state: "ALL", "page-delay": "0" }, withList(onePerState));
      expect(e.fn("jobs.list").mock.calls.map((c) => (c[0] as { state: string }).state).sort()).toEqual([...STATES].sort());
      expect(JSON.parse(text(e.out)).items.map((i: { id: string }) => i.id).sort()).toEqual(STATES.map((s) => `job_${s}`).sort());
      expect(stderr(e)).toMatch(/best-effort client-side union/i);
    });

    it("de-duplicates by id and drops each query's off-state noise", async () => {
      const e = await go(SHAPE, runJobList, { state: "ALL", "page-delay": "0" }, withList((p) =>
        page(p.state === "DRAFT" ? [posting("dup", "DRAFT"), posting("noise", "CLOSED")] : p.state === "CLOSED" ? [posting("dup", "CLOSED")] : []),
      ));
      expect(JSON.parse(text(e.out)).items.map((i: { id: string }) => i.id)).toEqual(["dup"]);
    });

    it("--all streams the de-duplicated union as NDJSON and announces it", async () => {
      const e = await go(SHAPE, runJobList, { state: "ALL", all: true, json: undefined, "page-delay": "0" }, withList(onePerState));
      expect(e.fn("jobs.list")).toHaveBeenCalledTimes(STATES.length);
      expect(ndjson(e.out).map((l) => JSON.parse(l).id).sort()).toEqual(STATES.map((s) => `job_${s}`).sort());
      expect(stderr(e)).toMatch(/NDJSON[\s\S]*best-effort client-side union|best-effort client-side union[\s\S]*NDJSON/);
    });
  });
});

describe("job create / update / publish / close / budget", () => {
  calls(SHAPE, [
    ["update sends only the provided fields", runJobUpdate, { id: "job_1", "workplace-type": "REMOTE" }, "jobs.update", ["job_1", { workplace_type: "REMOTE" }]],
    ["budget", runJobBudget, { id: "job_1" }, "jobs.getBudget", ["job_1"]],
    ["close is bodyless (one argument)", runJobClose, { id: "job_1" }, "jobs.close", ["job_1"]],
    ["publish --mode FREE", runJobPublish, { id: "j1", mode: "FREE" }, "jobs.publish", ["j1", { mode: "FREE" }]],
    ["publish PROMOTED carries the budget object", runJobPublish, { id: "j1", mode: "PROMOTED", "budget-currency": "EUR", "budget-amount": "25", "budget-scope": "DAILY" }, "jobs.publish", ["j1", { mode: "PROMOTED", budget: { currency: "EUR", amount: 25, scope: "DAILY" } }]],
  ]);

  const created = async (over: Args) => (await go(SHAPE, runJobCreate, { ...createFlags, ...over })).fn("jobs.create").mock.calls[0]![0] as Record<string, unknown>;
  it("create builds the nested job_title/company objects and a linkedin apply_method", async () => {
    expect(await created({})).toMatchObject({
      job_title: { name: "Founders Associate" }, company: { name: "LEAGUES" }, workplace_type: "HYBRID", location: "loc_123", employment_status: "FULL_TIME",
      apply_method: { method: "linkedin", notification_email: "jobs@example.com" }, description: createFlags.description,
    });
  });
  it("create: the id forms, and an external apply_method", async () => {
    const ids = await created({ "job-title": undefined, "job-title-id": "jt_9", company: undefined, "company-id": "co_9" });
    expect([ids["job_title"], ids["company"]]).toEqual([{ id: "jt_9" }, { id: "co_9" }]);
    const ext = await created({ "apply-method": "external", "notification-email": undefined, "website-url": "https://apply.example.com" });
    expect(ext["apply_method"]).toEqual({ method: "external", website_url: "https://apply.example.com" });
  });
  it.each([
    [{ "job-title": undefined, "job-title-id": undefined }, "--job-title"],
    [{ company: undefined, "company-id": undefined }, "--company"],
    [{ "workplace-type": undefined }, "--workplace-type"],
    [{ location: undefined }, "--location"],
    [{ "employment-status": undefined }, "--employment-status"],
    [{ description: undefined }, "--description"],
    [{ "apply-method": undefined }, "--apply-method"],
    [{ "notification-email": undefined }, "--notification-email"],
  ])("create missing %j: exit 2 naming %s, no SDK call", (over, flag) => refusal(runJobCreate, { ...createFlags, ...over }, flag));
  it("publish without --mode, or PROMOTED without a complete budget: exit 2 naming the flag", async () => {
    await refusal(runJobPublish, { id: "j1" }, "--mode");
    await refusal(runJobPublish, { id: "j1", mode: "PROMOTED", "budget-currency": "EUR" }, "--budget-amount");
  });
  refuses(SHAPE, [["publish --mode outside the enum", runJobPublish, { id: "j1", mode: "GIVE_AWAY" }, 2]]);
  previews(SHAPE, [
    ["create", runJobCreate, createFlags, "jobs.create", {}],
    ["publish", runJobPublish, { id: "j1", mode: "FREE" }, "jobs.publish", { body: { mode: "FREE" } }],
  ]);
});

describe("job applicants and resume", () => {
  calls(SHAPE, [
    ["applicants: empty filter by default", runJobApplicants, { id: "job_1" }, "jobs.listApplicants", ["job_1", {}]],
    ["applicants forwards --ratings, --limit, --cursor", runJobApplicants, { id: "job_1", ratings: "GOOD_FIT,MAYBE", limit: "5", cursor: "c2" }, "jobs.listApplicants", ["job_1", { ratings: ["GOOD_FIT", "MAYBE"], limit: 5, cursor: "c2" }]],
    ["applicant get", runJobApplicantGet, { id: "job_1", applicantId: "app_1" }, "jobs.getApplicant", ["job_1", "app_1"]],
  ]);

  it("resume writes the bytes to -o <file>; on a TTY without -o it refuses (exit 2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "job-resume-"));
    const tmp = join(dir, "resume.pdf");
    try {
      const e = mkEnv(SHAPE);
      await runJobApplicantResume(e.client as never, { id: "job_1", applicantId: "app_1", output: tmp, account: "acc_1" }, e.out as never, false);
      expect(e.fn("jobs.downloadResume")).toHaveBeenCalledWith("job_1", "app_1");
      expect(readFileSync(tmp).toString()).toBe("%PDF-bytes");
      expect(await exitCode(() => runJobApplicantResume(e.client as never, { id: "job_1", applicantId: "app_1", account: "acc_1" }, e.out as never, true))).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("job flag hygiene", () => {
  type Cmd = { args?: Record<string, unknown>; subCommands?: Record<string, Cmd> };
  const PAGING = ["limit", "cursor", "all", "max-pages"];
  const args = (path: string[]) => path.reduce((n, s) => n.subCommands![s]!, jobCommand as unknown as Cmd).args ?? {};

  it.each([["create"], ["update"], ["publish"], ["close"]])("%s (a write): no pagination flags, keeps --fields", (...path) => {
    for (const f of PAGING) expect(args(path)).not.toHaveProperty(f);
    expect(args(path)).toHaveProperty("fields");
  });
  it.each([["get"], ["budget"]])("%s (a single read): no pagination flags", (...path) => {
    for (const f of PAGING) expect(args(path)).not.toHaveProperty(f);
    expect(args(path)).toHaveProperty("fields");
  });
  it.each([["list"], ["applicants"]])("%s (a list read): has the pagination flags", (...path) => {
    for (const f of PAGING) expect(args(path)).toHaveProperty(f);
  });
  it("no job command exposes --dry-run", () => {
    for (const p of [["list"], ["create"], ["update"], ["budget"], ["publish"], ["close"], ["applicants"], ["applicant", "get"], ["applicant", "resume"]]) {
      expect(args(p)).not.toHaveProperty("dry-run");
    }
  });
});
