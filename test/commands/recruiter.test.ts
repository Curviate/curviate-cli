/**
 * `recruiter` group: run* functions against a mocked `recruiter` SDK namespace.
 * Calls, previews, refusals and --all streams are tables over the runners; ids pass verbatim
 * except `profile <identifier>` (resolveIdentifier).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { writeFile, mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exitCode } from "../helpers/exit-code.js";
import { arg0, clientOf, json, mkOut, ndjson, sdkError, text } from "../helpers/f1-unit.js";
import * as R from "../../src/commands/recruiter.js";

const METHODS = [
  "startChat", "getProfile", "searchPeople", "searchParameters", "searchFromUrl", "searchTalentPool", "listProjects", "getProject",
  "updateProject", "listPipeline", "saveCandidate", "listJobs", "createJob", "getProjectJob", "createProjectJob", "getProjectJobBudget",
  "updateProjectJob", "publishJob", "closeJob", "listApplicants", "getApplicant", "getJob", "downloadResume",
] as const;
let rec: Record<string, Mock>;
let client: ReturnType<typeof clientOf>;
let tmp: string;
beforeEach(async () => {
  rec = Object.fromEntries(METHODS.map((m) => [m, vi.fn().mockResolvedValue({ items: [{ id: "x" }], cursor: null })]));
  client = clientOf({ recruiter: rec });
  tmp = await mkdtemp(join(tmpdir(), "curviate-test-rec-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

type Flags = Record<string, unknown>;
type Runner = (c: never, a: never, o: never, ...rest: never[]) => Promise<void>;
const A: Flags = { account: "acc_1" };
/** Run `fn` with account + json defaults; returns the captured output. */
async function go(fn: unknown, flags: Flags = {}, ...rest: unknown[]) {
  const out = mkOut();
  await (fn as Runner)(client as never, { ...A, json: true, ...flags } as never, out as never, ...(rest as never[]));
  return out;
}
const refused = async (fn: unknown, flags: Flags, method?: string, ...rest: unknown[]) => {
  const out = mkOut();
  const code = await exitCode(() => (fn as Runner)(client as never, { ...A, ...flags } as never, out as never, ...(rest as never[])));
  if (method) expect(rec[method]).not.toHaveBeenCalled();
  return { code, err: text(out.stderr) };
};

/** The schema's minimum description length is 200 characters. */
const DESC = "Build agent infrastructure. ".repeat(8);
const JOB_FLAGS = {
  "job-title-id": "title_1", "job-title": "Senior Backend Engineer", "company-id": "comp_1", "workplace-type": "REMOTE", location: "loc_1",
  "employment-status": "FULL_TIME", "seniority-level": "MID_SENIOR_LEVEL", description: DESC, industry: "ind_1,ind_2",
  "job-function": "fn_1", "apply-method": "linkedin", "notification-email": "jobs@example.com",
};
const JOB_BODY = {
  job_title: { id: "title_1", name: "Senior Backend Engineer" }, company: { id: "comp_1" }, workplace_type: "REMOTE", location: "loc_1",
  employment_status: "FULL_TIME", seniority_level: "MID_SENIOR_LEVEL", description: DESC, industry: ["ind_1", "ind_2"],
  job_function: ["fn_1"], apply_method: { method: "linkedin", notification_email: "jobs@example.com" },
};
const CHAT = { to: "AEM789", text: "hello", subject: "Subj", signature: "Sig" };

describe("entitlement gate: all three codes exit 5 with the code in the JSON envelope, on every command", () => {
  it.each<[string, string, unknown, Flags]>([
    ["listProjects", "NO_ACTIVE_SEAT", R.runRecruiterListProjects, {}],
    ["searchPeople", "LINKEDIN_FEATURE_NOT_SUBSCRIBED", R.runRecruiterSearchPeople, {}],
    ["listJobs", "BETA_NOT_ENABLED", R.runRecruiterListJobs, {}],
    ["getProfile", "NO_ACTIVE_SEAT", R.runRecruiterProfile, { identifier: "jdoe" }],
    ["getJob", "LINKEDIN_FEATURE_NOT_SUBSCRIBED", R.runRecruiterGetJob, { jobId: "4428113858" }],
  ])("%s: %s", async (method, code, fn, flags) => {
    rec[method]!.mockRejectedValue(sdkError(code, 403));
    const out = mkOut();
    expect(await exitCode(() => (fn as Runner)(client as never, { ...A, json: true, ...flags } as never, out as never))).toBe(5);
    const parsed = json(out);
    expect(parsed["error"].code).toBe(code);
    expect(parsed["error"]).not.toHaveProperty("requiredTier");
    expect(text(out.stderr)).toContain(code);
  });

  it("a missing resource exits 4 (project-job get, job get), envelope carries the code", async () => {
    rec["getProjectJob"]!.mockRejectedValue(sdkError("RESOURCE_NOT_FOUND", 404));
    expect(await exitCode(() => go(R.runRecruiterGetProjectJob, { projectId: "proj_9" }))).toBe(4);
    rec["getJob"]!.mockRejectedValue(sdkError("RESOURCE_NOT_FOUND", 404));
    const out = mkOut();
    expect(await exitCode(() => R.runRecruiterGetJob(client as never, { ...A, jobId: "9999999999999", json: true } as never, out as never))).toBe(4);
    expect(json(out)["error"].code).toBe("RESOURCE_NOT_FOUND");
  });
});

describe("each command calls its SDK method with exactly these arguments", () => {
  const FILTERS = '{"industry":{"include":["96"]},"seniority":{"include":["3"]}}';
  it.each<[string, string, unknown, Flags, unknown[]]>([
    ["profile url -> slug", "getProfile", R.runRecruiterProfile, { identifier: "https://www.linkedin.com/in/jane-doe" }, ["jane-doe", expect.anything()]],
    ["profile bare slug", "getProfile", R.runRecruiterProfile, { identifier: "jdoe" }, ["jdoe", expect.anything()]],
    ["search people keywords", "searchPeople", R.runRecruiterSearchPeople, { keywords: "ml" }, [{ keywords: "ml" }]],
    ["search people --filters verbatim", "searchPeople", R.runRecruiterSearchPeople, { filters: FILTERS }, [{ industry: { include: ["96"] }, seniority: { include: ["3"] } }]],
    ["search people named flags + filters + keywords", "searchPeople", R.runRecruiterSearchPeople, {
      keywords: "ml", filters: '{"industry":{"include":["96"]}}', "employment-type": "FULL_TIME,CONTRACT", function: "eng", "profile-language": "en,de",
    }, [{ industry: { include: ["96"] }, keywords: "ml", employment_type: ["FULL_TIME", "CONTRACT"], job_function: ["eng"], profile_language: ["en", "de"] }]],
    ["search parameters source + type", "searchParameters", R.runRecruiterSearchParameters, { source: "JOBS", type: "LOCATION" }, [{ source: "JOBS", type: "LOCATION" }, undefined]],
    ["search parameters keywords/project/stage in body, limit in query", "searchParameters", R.runRecruiterSearchParameters, {
      source: "PIPELINE", type: "SKILL", keywords: "Berlin", "project-id": "proj_1", "stage-id": "stage_1", limit: "10",
    }, [{ source: "PIPELINE", type: "SKILL", keywords: "Berlin", project_id: "proj_1", stage_id: "stage_1" }, { limit: 10 }]],
    ["search <url>: no pagination params by default", "searchFromUrl", R.runRecruiterSearchFromUrl, { url: "https://www.linkedin.com/talent/search/x" }, [{ url: "https://www.linkedin.com/talent/search/x" }, undefined]],
    ["search <url>: --limit/--cursor in the query, not the body", "searchFromUrl", R.runRecruiterSearchFromUrl, { url: "https://l/x", limit: "10", cursor: "cur_1" }, [{ url: "https://l/x" }, { limit: 10, cursor: "cur_1" }]],
    ["project verbatim id", "getProject", R.runRecruiterGetProject, { projectId: "proj_abc" }, ["proj_abc"]],
    ["project update only provided fields", "updateProject", R.runRecruiterUpdateProject, { projectId: "proj_9", name: "Q3", visibility: "SHARED" }, ["proj_9", { name: "Q3", visibility: "SHARED" }]],
    ["pipeline filters into the body", "listPipeline", R.runRecruiterListPipeline, { projectId: "proj_9", "stage-id": "sta_1", keywords: "backend" }, ["proj_9", expect.objectContaining({ stage_id: "sta_1", keywords: "backend" })]],
    ["project-job get", "getProjectJob", R.runRecruiterGetProjectJob, { projectId: "proj_9" }, ["proj_9"]],
    ["project-job budget", "getProjectJobBudget", R.runRecruiterGetProjectJobBudget, { projectId: "proj_9", jobId: "job_42" }, ["proj_9", "job_42"]],
    ["project-job create assembles the body from scalar flags", "createProjectJob", R.runRecruiterCreateProjectJob, { projectId: "proj_9", ...JOB_FLAGS }, ["proj_9", JOB_BODY]],
    ["project-job update is PATCH: only supplied fields", "updateProjectJob", R.runRecruiterUpdateProjectJob, { projectId: "proj_9", jobId: "job_42", "workplace-type": "HYBRID" }, ["proj_9", "job_42", { workplace_type: "HYBRID" }]],
    ["save-candidate", "saveCandidate", R.runRecruiterSaveCandidate, { projectId: "proj_abc", "stage-id": "stage_1", "candidate-id": "AEM123" }, ["proj_abc", { stage_id: "stage_1", candidate_id: "AEM123" }]],
    ["job publish FREE", "publishJob", R.runRecruiterPublishJob, { projectId: "proj_9", jobId: "job_42", mode: "FREE" }, ["proj_9", "job_42", expect.objectContaining({ mode: "FREE" })]],
    ["job publish PROMOTED with budget", "publishJob", R.runRecruiterPublishJob, {
      projectId: "proj_9", jobId: "job_42", mode: "PROMOTED", "budget-currency": "EUR", "budget-amount": "25", "budget-scope": "DAILY",
    }, ["proj_9", "job_42", { mode: "PROMOTED", budget: { currency: "EUR", amount: 25, scope: "DAILY" } }]],
    ["job close is bodyless", "closeJob", R.runRecruiterCloseJob, { projectId: "proj_9", jobId: "job_42" }, ["proj_9", "job_42"]],
    ["talent-search: channel_id + keywords in the body", "searchTalentPool", R.runRecruiterSearchTalentPool, { projectId: "proj_9", "channel-id": "ch_1", keywords: "backend" }, ["proj_9", expect.objectContaining({ channel_id: "ch_1", keywords: "backend" })]],
    ["applicants: project-scoped, channel_id in the body", "listApplicants", R.runRecruiterListApplicants, { projectId: "proj_99", "channel-id": "ch_1" }, ["proj_99", { channel_id: "ch_1" }, undefined]],
    ["job get url -> numeric id", "getJob", R.runRecruiterGetJob, { jobId: "https://www.linkedin.com/jobs/view/4428113858" }, ["4428113858"]],
    ["job get bare id", "getJob", R.runRecruiterGetJob, { jobId: "4428113858" }, ["4428113858"]],
    ["applicant: project-scoped verbatim ids", "getApplicant", R.runRecruiterGetApplicant, { projectId: "proj_9", applicantId: "app_abc" }, ["proj_9", "app_abc"]],
  ])("%s", async (_label, method, fn, flags, expected) => {
    await go(fn, flags);
    expect(client.account).toHaveBeenCalledWith("acc_1");
    expect(rec[method]!.mock.calls[0]!.slice(0, expected.length)).toEqual(expected);
  });
});

describe("--preview renders the request and never calls the SDK", () => {
  it.each<[string, string, unknown, Flags, unknown?]>([
    ["recruiter.startChat", "startChat", R.runRecruiterMessageNew, CHAT],
    ["recruiter.updateProject", "updateProject", R.runRecruiterUpdateProject, { projectId: "proj_9", name: "Renamed" }, { name: "Renamed" }],
    ["recruiter.createProjectJob", "createProjectJob", R.runRecruiterCreateProjectJob, { projectId: "proj_9", ...JOB_FLAGS }, JOB_BODY],
    ["recruiter.updateProjectJob", "updateProjectJob", R.runRecruiterUpdateProjectJob, { projectId: "proj_9", jobId: "job_42", "workplace-type": "HYBRID" }, { workplace_type: "HYBRID" }],
    ["recruiter.saveCandidate", "saveCandidate", R.runRecruiterSaveCandidate, { projectId: "p", "stage-id": "s", "candidate-id": "AEM123" }],
    ["recruiter.publishJob", "publishJob", R.runRecruiterPublishJob, { projectId: "proj_9", jobId: "job_42", mode: "FREE" }],
    ["recruiter.closeJob", "closeJob", R.runRecruiterCloseJob, { projectId: "proj_9", jobId: "job_42" }],
  ])("%s", async (name, method, fn, flags, body) => {
    const out = await go(fn, { ...flags, json: undefined, preview: true });
    expect(rec[method]).not.toHaveBeenCalled();
    const parsed = json(out);
    expect(parsed["method"]).toBe(name);
    if (body) expect(parsed["body"]).toEqual(body);
  });
});

describe("refusals exit 2 before any SDK call, naming the flag", () => {
  it.each<[string, string, unknown, Flags, string?]>([
    ["message new without --subject", "startChat", R.runRecruiterMessageNew, { ...CHAT, subject: undefined }, "--subject"],
    ["message new without --signature", "startChat", R.runRecruiterMessageNew, { ...CHAT, signature: undefined }, "--signature"],
    ["message new --attach missing file", "startChat", R.runRecruiterMessageNew, { ...CHAT, attach: "/nonexistent/no-such-file.pdf" }],
    ["search people bad --filters JSON", "searchPeople", R.runRecruiterSearchPeople, { filters: "{bad" }],
    ["search parameters without --source", "searchParameters", R.runRecruiterSearchParameters, { type: "LOCATION" }],
    ["talent-search without --channel-id", "searchTalentPool", R.runRecruiterSearchTalentPool, { projectId: "proj_9" }, "--channel-id"],
    ["applicants without --channel-id", "listApplicants", R.runRecruiterListApplicants, { projectId: "proj_99" }, "--channel-id"],
    ["job publish without --mode", "publishJob", R.runRecruiterPublishJob, { projectId: "proj_9", jobId: "job_42" }, "--mode"],
    ["job publish PROMOTED without a budget", "publishJob", R.runRecruiterPublishJob, { projectId: "proj_9", jobId: "job_42", mode: "PROMOTED" }, "--budget-currency"],
    ["job create without --project-name", "createJob", R.runRecruiterCreateJob, { ...JOB_FLAGS }, "--project-name"],
    ["job create without --workplace-type", "createJob", R.runRecruiterCreateJob, { ...JOB_FLAGS, "workplace-type": undefined, "project-name": "Q3" }, "--workplace-type"],
  ])("%s", async (_label, method, fn, flags, flag) => {
    const { code, err } = await refused(fn, flags, method);
    expect(code).toBe(2);
    if (flag) expect(err).toContain(flag);
  });

  it.each([
    ["job-title-id", "--job-title-id"], ["company-id", "--company-id"], ["workplace-type", "--workplace-type"], ["location", "--location"],
    ["employment-status", "--employment-status"], ["seniority-level", "--seniority-level"], ["description", "--description"],
    ["industry", "--industry"], ["job-function", "--job-function"], ["apply-method", "--apply-method"],
  ])("project-job create without %s names %s", async (key, flag) => {
    const flags: Flags = { projectId: "proj_9", ...JOB_FLAGS, [key]: undefined };
    if (key === "job-title-id") flags["job-title"] = undefined;
    const { code, err } = await refused(R.runRecruiterCreateProjectJob, flags, "createProjectJob");
    expect(code).toBe(2);
    expect(err).toContain(flag);
  });

  it("job create: invalid JSON in --file and a non-object document on stdin", async () => {
    await writeFile(join(tmp, "bad.json"), "{ not valid json ");
    expect((await refused(R.runRecruiterCreateJob, { file: join(tmp, "bad.json") }, "createJob")).code).toBe(2);
    const readers = { readFile: vi.fn(), readStdin: vi.fn(async () => "[1,2,3]") };
    expect((await refused(R.runRecruiterCreateJob, { file: "-" }, "createJob", readers)).code).toBe(2);
  });

  it("resume to a TTY without -o", async () => {
    rec["downloadResume"]!.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
    expect((await refused(R.runRecruiterDownloadResume, { applicantId: "app_1" }, undefined, true)).code).toBe(2);
  });
});

describe("--all streams every page as NDJSON", () => {
  it.each<[string, unknown, Flags, string]>([
    ["searchPeople", R.runRecruiterSearchPeople, {}, "items"],
    ["searchFromUrl", R.runRecruiterSearchFromUrl, { url: "https://linkedin.com/x" }, "data"],
    ["listProjects", R.runRecruiterListProjects, {}, "items"],
    ["listPipeline", R.runRecruiterListPipeline, { projectId: "proj_9" }, "items"],
    ["searchTalentPool", R.runRecruiterSearchTalentPool, { projectId: "proj_9", "channel-id": "ch_1" }, "items"],
  ])("%s", async (method, fn, flags, key) => {
    rec[method]!.mockReset().mockResolvedValueOnce({ [key]: [{ id: "a1" }], cursor: "cur_1" }).mockResolvedValueOnce({ [key]: [{ id: "a2" }], cursor: null });
    const out = await go(fn, { ...flags, all: true });
    expect(ndjson(out).map((l) => JSON.parse(l))).toEqual([{ id: "a1" }, { id: "a2" }]);
  });
});

describe("recruiter message new", () => {
  it("body uses attendees_ids (plural) with text, subject and signature", async () => {
    await go(R.runRecruiterMessageNew, CHAT);
    const b = arg0(rec["startChat"]!);
    expect(b).toMatchObject({ attendees_ids: ["AEM789"], text: "hello", subject: "Subj", signature: "Sig" });
    expect(b).not.toHaveProperty("attendee_ids");
  });

  it.each([
    ["attach", "resume.pdf", "pdfcontent", { content_type: "application/pdf" }],
    ["voice", "voice.ogg", "voicedata", { send_mode: "native" }],
    ["video", "video.mp4", "videodata", { send_mode: "native" }],
  ])("--%s rides attachments[] as base64 (native send mode for voice/video; no voice_message / video_message field)", async (flag, name, data, extra) => {
    const file = join(tmp, name);
    await writeFile(file, data);
    await go(R.runRecruiterMessageNew, { ...CHAT, [flag]: file });
    const b = arg0(rec["startChat"]!);
    expect(b).not.toHaveProperty("voice_message");
    expect(b).not.toHaveProperty("video_message");
    expect((b["attachments"] as unknown[])[0]).toMatchObject({ content: Buffer.from(data).toString("base64"), filename: name, ...extra });
  });
});

describe("recruiter job create (JSON body + scalar flags)", () => {
  const FULL = { ...JOB_BODY, project_name: "Q3 Hiring" };
  const readers = (o: { stdin?: string } = {}) => ({ readFile: vi.fn(), readStdin: vi.fn(async () => o.stdin ?? "") });

  it("--file <path> and --file - (stdin) pass the whole JSON body through", async () => {
    await writeFile(join(tmp, "job.json"), JSON.stringify(FULL));
    await go(R.runRecruiterCreateJob, { file: join(tmp, "job.json") });
    const r = readers({ stdin: JSON.stringify(FULL) });
    await go(R.runRecruiterCreateJob, { file: "-" }, r);
    expect(r.readStdin).toHaveBeenCalled();
    expect(rec["createJob"]!.mock.calls.map((c) => c[0])).toEqual([FULL, FULL]);
  });

  it("scalar flags merge over the JSON body, and alone assemble the full required body", async () => {
    const r = readers({ stdin: JSON.stringify({ ...FULL, description: `OLD ${DESC}`, employment_status: "PART_TIME" }) });
    await go(R.runRecruiterCreateJob, { file: "-", "job-title-id": "title_2", "job-title": "Staff Engineer", description: `NEW ${DESC}`, "employment-status": "FULL_TIME" }, r);
    expect(arg0(rec["createJob"]!)).toMatchObject({
      job_title: { id: "title_2", name: "Staff Engineer" }, description: `NEW ${DESC}`, employment_status: "FULL_TIME", company: FULL.company, apply_method: FULL.apply_method,
    });
    await go(R.runRecruiterCreateJob, { ...JOB_FLAGS, "project-name": "Q3 Hiring" });
    expect(arg0(rec["createJob"]!, 1)).toEqual(FULL);
  });

  it("--preview shows the assembled body (JSON + flags) without calling createJob", async () => {
    const r = readers({ stdin: JSON.stringify(FULL) });
    const out = await go(R.runRecruiterCreateJob, { file: "-", "job-title-id": "title_9", "job-title": "Lead Engineer", preview: true, json: undefined }, r);
    expect(rec["createJob"]).not.toHaveBeenCalled();
    expect(json(out)).toMatchObject({ method: "recruiter.createJob", body: { job_title: { id: "title_9", name: "Lead Engineer" }, company: FULL.company } });
  });
});

describe("job get output and resume download", () => {
  const job = {
    object: "recruiter_job_posting", id: "4428113858", title: "Founders Associate", company: { id: "67756343", name: "LEAGUES" }, state: "active",
    location: "Stuttgart", cost: 0, applications_count: 75, description: "Build the founding team.", created_at: "2026-06-12T10:07:09.000Z",
    published_at: "2026-06-12T10:08:03.000Z", hiring_team: [],
  };

  it("slim has exactly 10 fields (company_id from company.id, real published_at, no hiring_team/cost); --verbose returns the full response", async () => {
    rec["getJob"]!.mockResolvedValue(job);
    const slim = json(await go(R.runRecruiterGetJob, { jobId: "4428113858" }));
    expect(Object.keys(slim)).toHaveLength(10);
    expect(slim).toMatchObject({ company_id: "67756343", applications_count: 75, published_at: job.published_at, description: job.description });
    for (const k of ["hiring_team", "cost", "applicants_counter"]) expect(slim).not.toHaveProperty(k);
    expect(json(await go(R.runRecruiterGetJob, { jobId: "4428113858", verbose: true }))).toMatchObject({ hiring_team: [], cost: 0, created_at: job.created_at });
  });

  it("resume -o writes the bytes to disk and asks the SDK for the project-scoped applicant", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    rec["downloadResume"]!.mockResolvedValue(bytes.buffer);
    const outPath = join(tmp, "resume.pdf");
    await go(R.runRecruiterDownloadResume, { projectId: "proj_9", applicantId: "app_1", output: outPath, json: undefined }, false);
    expect(await readFile(outPath)).toEqual(Buffer.from(bytes.buffer));
    expect(rec["downloadResume"]).toHaveBeenCalledWith("proj_9", "app_1");
  });

  it("the registry has no inmail-balance subcommand", () => {
    expect((R.recruiterCommand as unknown as { subCommands: object }).subCommands).not.toHaveProperty("inmail-balance");
  });
});
