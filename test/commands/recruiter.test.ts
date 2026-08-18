/**
 * Tests for the `recruiter` command group.
 *
 * Coverage:
 *   recruiter message new --to <id> "<text>" [--attach…] [--voice] [--video]  → recruiter.startChat (multipart)
 *   recruiter profile <identifier>                                              → recruiter.getProfile (resolveIdentifier)
 *   recruiter search people [filters…]                                         → recruiter.searchPeople (POST)
 *   recruiter search parameters --type <t>                                     → recruiter.searchParameters (POST)
 *   recruiter projects [--all] [--limit] [--cursor]                            → recruiter.listProjects
 *   recruiter project <project_id>                                             → recruiter.getProject (verbatim id)
 *   recruiter save-candidate <project_id> --stage-id <id> --candidate-id <id> → recruiter.saveCandidate
 *   recruiter jobs [--all] [--limit] [--cursor]                                → recruiter.listJobs
 *   recruiter job create <body…>                                               → recruiter.createJob
 *   recruiter job publish <project_id> <job_id>                                → recruiter.publishJob
 *   recruiter applicants <project_id> --channel-id <id>                        → recruiter.listApplicants
 *   recruiter applicant <project_id> <applicant_id>                            → recruiter.getApplicant (verbatim id)
 *   recruiter applicant resume <project_id> <applicant_id> -o <file>           → recruiter.downloadResume (binary)
 *
 * Tier gate:
 *   TIER_NOT_ACTIVE → exit 5 + JSON requiredTier
 *   LINKEDIN_FEATURE_NOT_SUBSCRIBED → exit 5 + JSON code
 *
 * --preview on writes: renders preview, no SDK call.
 * --preview on reads: exit 2.
 * resolveIdentifier applied to `profile <identifier>` only.
 * user_id / job_id / applicant_id / project_id pass verbatim.
 * Resume binary: -o writes file; TTY without -o exits 2.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { writeFile, mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Mock client factory ───────────────────────────────────────────────────

function makeRecruiterNs() {
  return {
    recruiter: {
      startChat: vi.fn(),
      getProfile: vi.fn(),
      searchPeople: vi.fn(),
      searchParameters: vi.fn(),
      searchFromUrl: vi.fn(),
      searchTalentPool: vi.fn(),
      listProjects: vi.fn(),
      getProject: vi.fn(),
      updateProject: vi.fn(),
      listPipeline: vi.fn(),
      saveCandidate: vi.fn(),
      listJobs: vi.fn(),
      createJob: vi.fn(),
      getProjectJob: vi.fn(),
      createProjectJob: vi.fn(),
      getProjectJobBudget: vi.fn(),
      updateProjectJob: vi.fn(),
      publishJob: vi.fn(),
      closeJob: vi.fn(),
      listApplicants: vi.fn(),
      getApplicant: vi.fn(),
      getJob: vi.fn(),
      downloadResume: vi.fn(),
    },
  };
}

function makeClient(ns: ReturnType<typeof makeRecruiterNs>) {
  return {
    account: vi.fn().mockReturnValue(ns),
  };
}


// ─── Shared helpers ────────────────────────────────────────────────────────

function makeOut() {
  return {
    stdout: { write: vi.fn() },
    stderr: { write: vi.fn() },
  };
}

function mockExit() {
  return vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
    throw new Error(`process.exit(${code})`);
  });
}

function makeTierError(code: string, requiredTier?: string) {
  return Object.assign(new Error(`Tier error: ${code}`), {
    code,
    requiredTier,
    userFixable: true,
    retryLikelyToSucceed: false,
    toJSON: () => ({ code, requiredTier, message: `Tier error: ${code}` }),
  });
}

// ─── Tier gate tests ───────────────────────────────────────────────────────

describe("recruiter tier gate", () => {
  let ns: ReturnType<typeof makeRecruiterNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeRecruiterNs();
    client = makeClient(ns);
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recruiter projects — TIER_NOT_ACTIVE → exit 5, requiredTier:recruiter", async () => {
    const tierErr = makeTierError("TIER_NOT_ACTIVE", "recruiter");
    (ns.recruiter.listProjects as Mock).mockRejectedValue(tierErr);

    const { CurviateError } = await import("@curviate/sdk");
    Object.setPrototypeOf(tierErr, CurviateError.prototype);

    const { runRecruiterListProjects } = await import("../../src/commands/recruiter.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runRecruiterListProjects(client as never, { account: "acc_1", json: true }, out);
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(5)");
    } finally {
      exitSpy.mockRestore();
    }

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.error.code).toBe("TIER_NOT_ACTIVE");
    expect(parsed.error.requiredTier).toBe("recruiter");
  });

  it("recruiter search people — LINKEDIN_FEATURE_NOT_SUBSCRIBED → exit 5, distinct code", async () => {
    const tierErr = makeTierError("LINKEDIN_FEATURE_NOT_SUBSCRIBED");
    (ns.recruiter.searchPeople as Mock).mockRejectedValue(tierErr);

    const { CurviateError } = await import("@curviate/sdk");
    Object.setPrototypeOf(tierErr, CurviateError.prototype);

    const { runRecruiterSearchPeople } = await import("../../src/commands/recruiter.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runRecruiterSearchPeople(client as never, { account: "acc_1", json: true }, out);
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(5)");
    } finally {
      exitSpy.mockRestore();
    }

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.error.code).toBe("LINKEDIN_FEATURE_NOT_SUBSCRIBED");
  });

  it("per-command gate independence — recruiter jobs stubbed independently → exit 5", async () => {
    const tierErr = makeTierError("TIER_NOT_ACTIVE", "recruiter");
    (ns.recruiter.listJobs as Mock).mockRejectedValue(tierErr);

    const { CurviateError } = await import("@curviate/sdk");
    Object.setPrototypeOf(tierErr, CurviateError.prototype);

    const { runRecruiterListJobs } = await import("../../src/commands/recruiter.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runRecruiterListJobs(client as never, { account: "acc_1", json: true }, out);
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(5)");
    } finally {
      exitSpy.mockRestore();
    }

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.error.code).toBe("TIER_NOT_ACTIVE");
    expect(parsed.error.requiredTier).toBe("recruiter");
  });

  it("per-command gate independence — recruiter profile stubbed independently → exit 5", async () => {
    const tierErr = makeTierError("TIER_NOT_ACTIVE", "recruiter");
    (ns.recruiter.getProfile as Mock).mockRejectedValue(tierErr);

    const { CurviateError } = await import("@curviate/sdk");
    Object.setPrototypeOf(tierErr, CurviateError.prototype);

    const { runRecruiterProfile } = await import("../../src/commands/recruiter.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runRecruiterProfile(client as never, { account: "acc_1", identifier: "jdoe", json: true }, out);
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(5)");
    } finally {
      exitSpy.mockRestore();
    }

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.error.requiredTier).toBe("recruiter");
  });
});

// ─── recruiter message new ─────────────────────────────────────────────────

describe("recruiter message new", () => {
  let ns: ReturnType<typeof makeRecruiterNs>;
  let client: ReturnType<typeof makeClient>;
  let tmpDir: string;

  beforeEach(async () => {
    ns = makeRecruiterNs();
    client = makeClient(ns);
    (ns.recruiter.startChat as Mock).mockResolvedValue({ chat_id: "rec_chat_1" });
    tmpDir = await mkdtemp(join(tmpdir(), "curviate-test-rec-"));
    vi.resetModules();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("calls recruiter.startChat with to, text, subject, and signature (v2: both required)", async () => {
    const { runRecruiterMessageNew } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterMessageNew(client as never, {
      account: "acc_1",
      to: "AEM789",
      text: "hello recruiter",
      subject: "Quick question",
      signature: "Jane Recruiter",
      json: true,
    }, out);

    expect(client.account).toHaveBeenCalledWith("acc_1");
    expect(ns.recruiter.startChat).toHaveBeenCalledWith(
      expect.objectContaining({
        attendees_ids: ["AEM789"],
        text: "hello recruiter",
        subject: "Quick question",
        signature: "Jane Recruiter",
      }),
    );
  });

  // ── Wire-encoding regression: the Recruiter chat body MUST use `attendees_ids`
  // (PLURAL) — matches the server-renamed field (F2, SN/Recruiter parity pass).
  // A prior version sent the singular `attendee_ids` → guaranteed API 400.
  it("recruiter message new — body uses attendees_ids (plural), not attendee_ids", async () => {
    const { runRecruiterMessageNew } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterMessageNew(client as never, {
      account: "acc_1",
      to: "AEM789",
      text: "hello recruiter",
      subject: "Subj",
      signature: "Sig",
      json: true,
    }, out);

    const body = (ns.recruiter.startChat as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body["attendees_ids"]).toEqual(["AEM789"]);
    expect(body["text"]).toBe("hello recruiter");
    // The singular form must NOT appear — it was the old pre-parity field name.
    expect(body).not.toHaveProperty("attendee_ids");
  });

  it("missing --subject exits 2 before any SDK call (v2: required)", async () => {
    const { runRecruiterMessageNew } = await import("../../src/commands/recruiter.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runRecruiterMessageNew(client as never, {
        account: "acc_1",
        to: "AEM789",
        text: "hello",
        signature: "Sig",
      }, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(ns.recruiter.startChat).not.toHaveBeenCalled();
  });

  it("missing --signature exits 2 before any SDK call (v2: required)", async () => {
    const { runRecruiterMessageNew } = await import("../../src/commands/recruiter.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runRecruiterMessageNew(client as never, {
        account: "acc_1",
        to: "AEM789",
        text: "hello",
        subject: "Subj",
      }, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(ns.recruiter.startChat).not.toHaveBeenCalled();
  });

  it("--attach file passes base64 payload in attachments (v2: no multipart)", async () => {
    const filePath = join(tmpDir, "resume.pdf");
    await writeFile(filePath, "pdfcontent");

    const { runRecruiterMessageNew } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterMessageNew(client as never, {
      account: "acc_1",
      to: "AEM789",
      text: "hello",
      subject: "Subj",
      signature: "Sig",
      attach: filePath,
      json: true,
    }, out);

    const callArgs = (ns.recruiter.startChat as Mock).mock.calls[0]![0] as Record<string, unknown>;
    const attachments = callArgs["attachments"] as Array<Record<string, unknown>>;
    expect(Array.isArray(attachments)).toBe(true);
    expect(attachments[0]).toEqual({
      content: Buffer.from("pdfcontent").toString("base64"),
      content_type: "application/pdf",
      filename: "resume.pdf",
    });
  });

  it("--voice file rides the shared attachments[] array with send_mode 'native' (v2: no voice_message field)", async () => {
    const voicePath = join(tmpDir, "voice.ogg");
    await writeFile(voicePath, "voicedata");

    const { runRecruiterMessageNew } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterMessageNew(client as never, {
      account: "acc_1",
      to: "AEM789",
      text: "hello",
      subject: "Subj",
      signature: "Sig",
      voice: voicePath,
      json: true,
    }, out);

    const callArgs = (ns.recruiter.startChat as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(callArgs).not.toHaveProperty("voice_message");
    const attachments = callArgs["attachments"] as Array<Record<string, unknown>>;
    expect(attachments[0]).toMatchObject({
      content: Buffer.from("voicedata").toString("base64"),
      filename: "voice.ogg",
      send_mode: "native",
    });
  });

  it("--video file rides the shared attachments[] array with send_mode 'native' (v2: no video_message field)", async () => {
    const videoPath = join(tmpDir, "video.mp4");
    await writeFile(videoPath, "videodata");

    const { runRecruiterMessageNew } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterMessageNew(client as never, {
      account: "acc_1",
      to: "AEM789",
      text: "hello",
      subject: "Subj",
      signature: "Sig",
      video: videoPath,
      json: true,
    }, out);

    const callArgs = (ns.recruiter.startChat as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(callArgs).not.toHaveProperty("video_message");
    const attachments = callArgs["attachments"] as Array<Record<string, unknown>>;
    expect(attachments[0]).toMatchObject({
      content: Buffer.from("videodata").toString("base64"),
      filename: "video.mp4",
      send_mode: "native",
    });
  });

  it("--preview renders request, does not call startChat", async () => {
    const { runRecruiterMessageNew } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterMessageNew(client as never, {
      account: "acc_1",
      to: "AEM789",
      text: "hello",
      subject: "Subj",
      signature: "Sig",
      preview: true,
    }, out);

    expect(ns.recruiter.startChat).not.toHaveBeenCalled();
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.method).toBe("recruiter.startChat");
  });

  it("--attach missing file exits 2 before startChat", async () => {
    const { runRecruiterMessageNew } = await import("../../src/commands/recruiter.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runRecruiterMessageNew(client as never, {
        account: "acc_1",
        to: "AEM789",
        text: "hello",
        subject: "Subj",
        signature: "Sig",
        attach: join(tmpDir, "no-such-file.txt"),
      }, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(ns.recruiter.startChat).not.toHaveBeenCalled();
  });
});

// ─── recruiter profile ─────────────────────────────────────────────────────

describe("recruiter profile", () => {
  let ns: ReturnType<typeof makeRecruiterNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeRecruiterNs();
    client = makeClient(ns);
    (ns.recruiter.getProfile as Mock).mockResolvedValue({ id: "p1", name: "Jane" });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls recruiter.getProfile with identifier resolved via resolveIdentifier", async () => {
    const { runRecruiterProfile } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterProfile(client as never, {
      account: "acc_1",
      identifier: "https://www.linkedin.com/in/jane-doe",
      json: true,
    }, out);

    expect(ns.recruiter.getProfile).toHaveBeenCalledWith("jane-doe", expect.anything());
  });

  it("bare slug is passed through unchanged", async () => {
    const { runRecruiterProfile } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterProfile(client as never, {
      account: "acc_1",
      identifier: "jdoe",
      json: true,
    }, out);

    expect(ns.recruiter.getProfile).toHaveBeenCalledWith("jdoe", expect.anything());
  });

  it("--preview on read: exits 2", async () => {
    const { runRecruiterProfile } = await import("../../src/commands/recruiter.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runRecruiterProfile(client as never, { account: "acc_1", identifier: "jdoe", preview: true }, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(ns.recruiter.getProfile).not.toHaveBeenCalled();
  });
});

// ─── recruiter search people ───────────────────────────────────────────────

describe("recruiter search people", () => {
  let ns: ReturnType<typeof makeRecruiterNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeRecruiterNs();
    client = makeClient(ns);
    (ns.recruiter.searchPeople as Mock).mockResolvedValue({ items: [{ id: "a1" }], cursor: null });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls recruiter.searchPeople with body (POST shape)", async () => {
    const { runRecruiterSearchPeople } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterSearchPeople(client as never, { account: "acc_1", keywords: "ml", json: true }, out);

    expect(ns.recruiter.searchPeople).toHaveBeenCalled();
    const callArgs = (ns.recruiter.searchPeople as Mock).mock.calls[0] as [Record<string, unknown>];
    // First argument is the body (POST)
    expect(typeof callArgs[0]).toBe("object");
    expect(callArgs[0]).toEqual({ keywords: "ml" });
  });

  it("--filters '<json>' merges nested filter objects into the POST body verbatim", async () => {
    const { runRecruiterSearchPeople } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterSearchPeople(client as never, {
      account: "acc_1",
      filters: '{"industry":{"include":["96"]},"seniority":{"include":["3"]}}',
      json: true,
    }, out);

    const body = (ns.recruiter.searchPeople as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({ industry: { include: ["96"] }, seniority: { include: ["3"] } });
  });

  it("--keywords + --filters combine; named flags map to exact API fields", async () => {
    const { runRecruiterSearchPeople } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterSearchPeople(client as never, {
      account: "acc_1",
      keywords: "ml",
      filters: '{"industry":{"include":["96"]}}',
      "employment-type": "FULL_TIME,CONTRACT",
      function: "eng",
      "profile-language": "en,de",
      json: true,
    }, out);

    const body = (ns.recruiter.searchPeople as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({
      industry: { include: ["96"] },
      keywords: "ml",
      employment_type: ["FULL_TIME", "CONTRACT"],
      // --function (server field is job_function, not function)
      job_function: ["eng"],
      profile_language: ["en", "de"],
    });
  });

  it("bad --filters JSON exits 2 before any SDK call", async () => {
    const { runRecruiterSearchPeople } = await import("../../src/commands/recruiter.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runRecruiterSearchPeople(client as never, { account: "acc_1", filters: "{bad" }, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(ns.recruiter.searchPeople).not.toHaveBeenCalled();
  });

  it("--preview exits 2", async () => {
    const { runRecruiterSearchPeople } = await import("../../src/commands/recruiter.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runRecruiterSearchPeople(client as never, { account: "acc_1", preview: true }, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(ns.recruiter.searchPeople).not.toHaveBeenCalled();
  });

  it("--all streams all pages via POST search", async () => {
    (ns.recruiter.searchPeople as Mock)
      .mockResolvedValueOnce({ items: [{ id: "a1" }], cursor: "cur_1" })
      .mockResolvedValueOnce({ items: [{ id: "a2" }], cursor: null });

    const { runRecruiterSearchPeople } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterSearchPeople(client as never, { account: "acc_1", all: true, json: true }, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("\n");
    const lines = written.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!)).toEqual({ id: "a1" });
    expect(JSON.parse(lines[1]!)).toEqual({ id: "a2" });
  });
});

// ─── recruiter search parameters ──────────────────────────────────────────

describe("recruiter search parameters", () => {
  let ns: ReturnType<typeof makeRecruiterNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeRecruiterNs();
    client = makeClient(ns);
    (ns.recruiter.searchParameters as Mock).mockResolvedValue({ items: [] });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls recruiter.searchParameters with source + type in the body (v2: POST, not GET)", async () => {
    const { runRecruiterSearchParameters } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterSearchParameters(client as never, {
      account: "acc_1",
      source: "JOBS",
      type: "LOCATION",
      json: true,
    }, out);

    expect(ns.recruiter.searchParameters).toHaveBeenCalledWith(
      expect.objectContaining({ source: "JOBS", type: "LOCATION" }),
      undefined,
    );
  });

  it("wires --keywords, --project-id, --stage-id into the body and --limit into query params", async () => {
    const { runRecruiterSearchParameters } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterSearchParameters(client as never, {
      account: "acc_1",
      source: "PIPELINE",
      type: "SKILL",
      keywords: "Berlin",
      "project-id": "proj_1",
      "stage-id": "stage_1",
      limit: "10",
      json: true,
    }, out);

    expect(ns.recruiter.searchParameters).toHaveBeenCalledWith(
      { source: "PIPELINE", type: "SKILL", keywords: "Berlin", project_id: "proj_1", stage_id: "stage_1" },
      { limit: 10 },
    );
  });

  it("missing --source exits 2 before any SDK call", async () => {
    const { runRecruiterSearchParameters } = await import("../../src/commands/recruiter.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runRecruiterSearchParameters(client as never, { account: "acc_1", type: "LOCATION" }, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(ns.recruiter.searchParameters).not.toHaveBeenCalled();
  });
});

// ─── recruiter search <url> ────────────────────────────────────────────────

describe("recruiter search <url>", () => {
  let ns: ReturnType<typeof makeRecruiterNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeRecruiterNs();
    client = makeClient(ns);
    (ns.recruiter.searchFromUrl as Mock).mockResolvedValue({ object: "recruiter_people_search_result", data: [] });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls recruiter.searchFromUrl with {url} body and no pagination params by default", async () => {
    const { runRecruiterSearchFromUrl } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterSearchFromUrl(client as never, {
      account: "acc_1",
      url: "https://www.linkedin.com/talent/search/...",
      json: true,
    }, out);

    expect(ns.recruiter.searchFromUrl).toHaveBeenCalledWith(
      { url: "https://www.linkedin.com/talent/search/..." },
      undefined,
    );
  });

  it("--limit/--cursor pass through as query params, not in the body", async () => {
    const { runRecruiterSearchFromUrl } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterSearchFromUrl(client as never, {
      account: "acc_1",
      url: "https://www.linkedin.com/talent/search/...",
      limit: "10",
      cursor: "cur_1",
      json: true,
    }, out);

    expect(ns.recruiter.searchFromUrl).toHaveBeenCalledWith(
      { url: "https://www.linkedin.com/talent/search/..." },
      { limit: 10, cursor: "cur_1" },
    );
  });

  it("--all streams all pages", async () => {
    (ns.recruiter.searchFromUrl as Mock)
      .mockResolvedValueOnce({ data: [{ id: "1" }], cursor: "cur_1" })
      .mockResolvedValueOnce({ data: [{ id: "2" }], cursor: null });

    const { runRecruiterSearchFromUrl } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterSearchFromUrl(client as never, { account: "acc_1", url: "https://linkedin.com/x", all: true, json: true }, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("\n");
    const lines = written.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(2);
  });

  it("rejects --preview (read command)", async () => {
    const { runRecruiterSearchFromUrl } = await import("../../src/commands/recruiter.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runRecruiterSearchFromUrl(client as never, { account: "acc_1", url: "https://linkedin.com/x", preview: true }, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(ns.recruiter.searchFromUrl).not.toHaveBeenCalled();
  });
});

// ─── recruiter projects ────────────────────────────────────────────────────

describe("recruiter projects", () => {
  let ns: ReturnType<typeof makeRecruiterNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeRecruiterNs();
    client = makeClient(ns);
    (ns.recruiter.listProjects as Mock).mockResolvedValue({ items: [{ id: "proj_1" }], cursor: null });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls recruiter.listProjects", async () => {
    const { runRecruiterListProjects } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterListProjects(client as never, { account: "acc_1", json: true }, out);

    expect(client.account).toHaveBeenCalledWith("acc_1");
    expect(ns.recruiter.listProjects).toHaveBeenCalled();
  });

  it("--all streams all pages", async () => {
    (ns.recruiter.listProjects as Mock)
      .mockResolvedValueOnce({ items: [{ id: "proj_1" }], cursor: "cur_1" })
      .mockResolvedValueOnce({ items: [{ id: "proj_2" }], cursor: null });

    const { runRecruiterListProjects } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterListProjects(client as never, { account: "acc_1", all: true, json: true }, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("\n");
    const lines = written.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(2);
  });
});

// ─── recruiter project <project_id> ───────────────────────────────────────

describe("recruiter project", () => {
  let ns: ReturnType<typeof makeRecruiterNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeRecruiterNs();
    client = makeClient(ns);
    (ns.recruiter.getProject as Mock).mockResolvedValue({ id: "proj_1", name: "Q3 Hiring" });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls recruiter.getProject with projectId verbatim (no resolveIdentifier)", async () => {
    const { runRecruiterGetProject } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterGetProject(client as never, {
      account: "acc_1",
      projectId: "proj_abc",
      json: true,
    }, out);

    // project_id is a native id — must NOT be URL-resolved
    expect(ns.recruiter.getProject).toHaveBeenCalledWith("proj_abc");
  });
});

// ─── recruiter project update <project_id> ────────────────────────────────

describe("recruiter project update", () => {
  let ns: ReturnType<typeof makeRecruiterNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeRecruiterNs();
    client = makeClient(ns);
    (ns.recruiter.updateProject as Mock).mockResolvedValue({ object: "recruiter_project_updated" });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls recruiter.updateProject with projectId verbatim + only the provided fields", async () => {
    const { runRecruiterUpdateProject } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterUpdateProject(client as never, {
      account: "acc_1",
      projectId: "proj_9",
      name: "Q3 Backend Hiring",
      visibility: "SHARED",
      json: true,
    }, out);

    expect(ns.recruiter.updateProject).toHaveBeenCalledWith("proj_9", { name: "Q3 Backend Hiring", visibility: "SHARED" });
  });

  it("--preview renders request, does not call updateProject", async () => {
    const { runRecruiterUpdateProject } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterUpdateProject(client as never, {
      account: "acc_1",
      projectId: "proj_9",
      name: "Renamed",
      preview: true,
    }, out);

    expect(ns.recruiter.updateProject).not.toHaveBeenCalled();
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.method).toBe("recruiter.updateProject");
    expect(parsed.body).toEqual({ name: "Renamed" });
  });
});

// ─── recruiter pipeline <project_id> ──────────────────────────────────────

describe("recruiter pipeline", () => {
  let ns: ReturnType<typeof makeRecruiterNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeRecruiterNs();
    client = makeClient(ns);
    (ns.recruiter.listPipeline as Mock).mockResolvedValue({ items: [{ id: "cand_1" }], cursor: null });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls recruiter.listPipeline with projectId verbatim (read, no --channel-id requirement)", async () => {
    const { runRecruiterListPipeline } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterListPipeline(client as never, {
      account: "acc_1",
      projectId: "proj_9",
      json: true,
    }, out);

    const calls = (ns.recruiter.listPipeline as Mock).mock.calls;
    expect(calls[0]![0]).toBe("proj_9");
  });

  it("--stage-id / --keywords filter into the body", async () => {
    const { runRecruiterListPipeline } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterListPipeline(client as never, {
      account: "acc_1",
      projectId: "proj_9",
      "stage-id": "sta_1",
      keywords: "backend",
      json: true,
    }, out);

    const calls = (ns.recruiter.listPipeline as Mock).mock.calls;
    expect(calls[0]![1]).toEqual(expect.objectContaining({ stage_id: "sta_1", keywords: "backend" }));
  });

  it("--all streams all pages", async () => {
    (ns.recruiter.listPipeline as Mock)
      .mockResolvedValueOnce({ items: [{ id: "cand_1" }], cursor: "cur_1" })
      .mockResolvedValueOnce({ items: [{ id: "cand_2" }], cursor: null });

    const { runRecruiterListPipeline } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterListPipeline(client as never, { account: "acc_1", projectId: "proj_9", all: true, json: true }, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("\n");
    const lines = written.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(2);
  });

  it("rejects --preview (read command)", async () => {
    const { runRecruiterListPipeline } = await import("../../src/commands/recruiter.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runRecruiterListPipeline(client as never, { account: "acc_1", projectId: "proj_9", preview: true }, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(ns.recruiter.listPipeline).not.toHaveBeenCalled();
  });
});

// ─── recruiter project-job get/budget <project_id> [<job_id>] ─────────────

describe("recruiter project-job get", () => {
  let ns: ReturnType<typeof makeRecruiterNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeRecruiterNs();
    client = makeClient(ns);
    (ns.recruiter.getProjectJob as Mock).mockResolvedValue({ object: "recruiter_job_posting", id: "job_1", project_id: "proj_9" });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls recruiter.getProjectJob with projectId verbatim (singular, not a list)", async () => {
    const { runRecruiterGetProjectJob } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterGetProjectJob(client as never, { account: "acc_1", projectId: "proj_9", json: true }, out);

    expect(ns.recruiter.getProjectJob).toHaveBeenCalledWith("proj_9");
  });

  it("404 RESOURCE_NOT_FOUND (no job attached) surfaces as exit 4", async () => {
    const err = Object.assign(new Error("not found"), {
      code: "RESOURCE_NOT_FOUND",
      userFixable: true,
      retryLikelyToSucceed: false,
      toJSON: () => ({ code: "RESOURCE_NOT_FOUND", message: "not found" }),
    });
    const { CurviateError } = await import("@curviate/sdk");
    Object.setPrototypeOf(err, CurviateError.prototype);
    (ns.recruiter.getProjectJob as Mock).mockRejectedValue(err);

    const { runRecruiterGetProjectJob } = await import("../../src/commands/recruiter.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runRecruiterGetProjectJob(client as never, { account: "acc_1", projectId: "proj_9", json: true }, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(4)");
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe("recruiter project-job budget", () => {
  let ns: ReturnType<typeof makeRecruiterNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeRecruiterNs();
    client = makeClient(ns);
    (ns.recruiter.getProjectJobBudget as Mock).mockResolvedValue({ object: "recruiter_job_posting_budget", promoted: {}, free: { eligible: true } });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls recruiter.getProjectJobBudget with projectId + jobId verbatim", async () => {
    const { runRecruiterGetProjectJobBudget } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterGetProjectJobBudget(client as never, {
      account: "acc_1",
      projectId: "proj_9",
      jobId: "job_42",
      json: true,
    }, out);

    expect(ns.recruiter.getProjectJobBudget).toHaveBeenCalledWith("proj_9", "job_42");
  });
});

// A complete recruiter-job-body flag set — the required set per the v2
// createProjectJob schema (job_title, company, workplace_type, location,
// employment_status, seniority_level, description, industry, job_function,
// apply_method). Shared by project-job create's happy-path + misuse tests.
const FULL_RECRUITER_JOB_FLAGS = {
  "job-title-id": "title_1",
  "job-title": "Senior Backend Engineer",
  "company-id": "comp_1",
  "workplace-type": "REMOTE",
  location: "loc_1",
  "employment-status": "FULL_TIME",
  "seniority-level": "MID_SENIOR_LEVEL",
  description: "Build agents.",
  industry: "ind_1,ind_2",
  "job-function": "fn_1",
  "apply-method": "linkedin",
  "notification-email": "jobs@example.com",
};

const FULL_RECRUITER_JOB_BODY = {
  job_title: { id: "title_1", name: "Senior Backend Engineer" },
  company: { id: "comp_1" },
  workplace_type: "REMOTE",
  location: "loc_1",
  employment_status: "FULL_TIME",
  seniority_level: "MID_SENIOR_LEVEL",
  description: "Build agents.",
  industry: ["ind_1", "ind_2"],
  job_function: ["fn_1"],
  apply_method: { method: "linkedin", notification_email: "jobs@example.com" },
};

describe("recruiter project-job create", () => {
  let ns: ReturnType<typeof makeRecruiterNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeRecruiterNs();
    client = makeClient(ns);
    (ns.recruiter.createProjectJob as Mock).mockResolvedValue({ object: "recruiter_job_posting", id: "job_new" });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("assembles the full body from scalar flags and calls createProjectJob(projectId, body)", async () => {
    const { runRecruiterCreateProjectJob } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterCreateProjectJob(client as never, {
      account: "acc_1",
      projectId: "proj_9",
      ...FULL_RECRUITER_JOB_FLAGS,
      json: true,
    }, out);

    expect(ns.recruiter.createProjectJob).toHaveBeenCalledWith("proj_9", FULL_RECRUITER_JOB_BODY);
  });

  it.each([
    ["job-title-id", "--job-title-id"],
    ["company-id", "--company-id"],
    ["workplace-type", "--workplace-type"],
    ["location", "--location"],
    ["employment-status", "--employment-status"],
    ["seniority-level", "--seniority-level"],
    ["description", "--description"],
    ["industry", "--industry"],
    ["job-function", "--job-function"],
    ["apply-method", "--apply-method"],
  ])("missing %s exits 2 naming %s, before any SDK call", async (flagKey, flagName) => {
    const { runRecruiterCreateProjectJob } = await import("../../src/commands/recruiter.js");
    const out = makeOut();
    const exitSpy = mockExit();

    const flags = { ...FULL_RECRUITER_JOB_FLAGS } as Record<string, string | undefined>;
    delete flags[flagKey];
    // job_title needs BOTH id and name dropped together to actually remove
    // the key from the assembled body when the id half is what's under test.
    if (flagKey === "job-title-id") delete flags["job-title"];

    try {
      await runRecruiterCreateProjectJob(client as never, {
        account: "acc_1",
        projectId: "proj_9",
        ...flags,
      }, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    const stderrText = (out.stderr.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    expect(stderrText).toContain(flagName);
    expect(ns.recruiter.createProjectJob).not.toHaveBeenCalled();
  });

  it("--preview shows the assembled body, does not call createProjectJob", async () => {
    const { runRecruiterCreateProjectJob } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterCreateProjectJob(client as never, {
      account: "acc_1",
      projectId: "proj_9",
      ...FULL_RECRUITER_JOB_FLAGS,
      preview: true,
    }, out);

    expect(ns.recruiter.createProjectJob).not.toHaveBeenCalled();
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.method).toBe("recruiter.createProjectJob");
    expect(parsed.body).toEqual(FULL_RECRUITER_JOB_BODY);
  });
});

describe("recruiter project-job update", () => {
  let ns: ReturnType<typeof makeRecruiterNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeRecruiterNs();
    client = makeClient(ns);
    (ns.recruiter.updateProjectJob as Mock).mockResolvedValue({ object: "recruiter_job_posting_edited" });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("PATCH semantics — only the supplied fields are sent, no required-field validation", async () => {
    const { runRecruiterUpdateProjectJob } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterUpdateProjectJob(client as never, {
      account: "acc_1",
      projectId: "proj_9",
      jobId: "job_42",
      description: "New description.",
      json: true,
    }, out);

    expect(ns.recruiter.updateProjectJob).toHaveBeenCalledWith("proj_9", "job_42", { description: "New description." });
  });

  it("--preview renders request, does not call updateProjectJob", async () => {
    const { runRecruiterUpdateProjectJob } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterUpdateProjectJob(client as never, {
      account: "acc_1",
      projectId: "proj_9",
      jobId: "job_42",
      "workplace-type": "HYBRID",
      preview: true,
    }, out);

    expect(ns.recruiter.updateProjectJob).not.toHaveBeenCalled();
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.method).toBe("recruiter.updateProjectJob");
    expect(parsed.body).toEqual({ workplace_type: "HYBRID" });
  });
});

// ─── recruiter add-candidate ───────────────────────────────────────────────

describe("recruiter save-candidate", () => {
  let ns: ReturnType<typeof makeRecruiterNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeRecruiterNs();
    client = makeClient(ns);
    (ns.recruiter.saveCandidate as Mock).mockResolvedValue({ object: "recruiter_candidate_saved" });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls recruiter.saveCandidate with projectId verbatim and {stage_id, candidate_id} body (v2: full reshape from addCandidate)", async () => {
    const { runRecruiterSaveCandidate } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterSaveCandidate(client as never, {
      account: "acc_1",
      projectId: "proj_abc",
      "stage-id": "stage_1",
      "candidate-id": "AEM123",
      json: true,
    }, out);

    expect(ns.recruiter.saveCandidate).toHaveBeenCalledWith(
      "proj_abc",
      { stage_id: "stage_1", candidate_id: "AEM123" },
    );
  });

  it("--preview renders request, does not call saveCandidate", async () => {
    const { runRecruiterSaveCandidate } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterSaveCandidate(client as never, {
      account: "acc_1",
      projectId: "proj_abc",
      "stage-id": "stage_1",
      "candidate-id": "AEM123",
      preview: true,
    }, out);

    expect(ns.recruiter.saveCandidate).not.toHaveBeenCalled();
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.method).toBe("recruiter.saveCandidate");
  });
});
// ─── recruiter jobs ────────────────────────────────────────────────────────

describe("recruiter jobs", () => {
  let ns: ReturnType<typeof makeRecruiterNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeRecruiterNs();
    client = makeClient(ns);
    (ns.recruiter.listJobs as Mock).mockResolvedValue({ items: [{ id: "job_1" }], cursor: null });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls recruiter.listJobs", async () => {
    const { runRecruiterListJobs } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterListJobs(client as never, { account: "acc_1", json: true }, out);

    expect(ns.recruiter.listJobs).toHaveBeenCalled();
  });
});

// ─── recruiter job create ──────────────────────────────────────────────────

describe("recruiter job create", () => {
  let ns: ReturnType<typeof makeRecruiterNs>;
  let client: ReturnType<typeof makeClient>;
  let tmpDir: string;

  // Injectable readers so the JSON-body source can be exercised without real
  // process.stdin / fs I/O. The real --body-file path is exercised via a temp file.
  function makeReaders(opts: { file?: string; stdin?: string } = {}) {
    return {
      readFile: vi.fn(async () => {
        if (opts.file === undefined) throw new Error("no file");
        return opts.file;
      }),
      readStdin: vi.fn(async () => opts.stdin ?? ""),
    };
  }

  // A complete v2 job-create body (project_name + the full recruiter-job-body
  // required set: job_title, company, workplace_type, location,
  // employment_status, seniority_level, description, industry, job_function,
  // apply_method — the v2 createJob schema).
  const FULL_BODY = {
    job_title: { id: "title_1", name: "Senior AI Engineer" },
    company: { id: "1441" },
    workplace_type: "REMOTE",
    location: "103644278",
    employment_status: "FULL_TIME",
    seniority_level: "MID_SENIOR_LEVEL",
    description: "<p>Build agents.</p>",
    industry: ["ind_1"],
    job_function: ["fn_1"],
    apply_method: { method: "linkedin", notification_email: "jobs@example.com" },
    project_name: "Q3 Hiring",
  };

  beforeEach(async () => {
    ns = makeRecruiterNs();
    client = makeClient(ns);
    (ns.recruiter.createJob as Mock).mockResolvedValue({ job_id: "job_new", status: "draft" });
    tmpDir = await mkdtemp(join(tmpdir(), "curviate-test-job-"));
    vi.resetModules();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── Wire-encoding regression: a prior version built `const body = {}` and
  // never populated it — 0 fields wired → guaranteed API 400. This asserts the
  // JSON body source is read and every field reaches the SDK verbatim.
  it("--body-file — reads the JSON file and passes the full body to createJob (every required field)", async () => {
    const filePath = join(tmpDir, "job.json");
    await writeFile(filePath, JSON.stringify(FULL_BODY));

    const { runRecruiterCreateJob } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    // Real fs reader (no injection): exercises the actual --body-file path.
    await runRecruiterCreateJob(client as never, {
      account: "acc_1",
      "body-file": filePath,
      json: true,
    }, out);

    expect(client.account).toHaveBeenCalledWith("acc_1");
    const body = (ns.recruiter.createJob as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual(FULL_BODY);
    // Spot-check the required keys are all present with correct names.
    for (const k of ["job_title", "company", "workplace_type", "location", "employment_status", "seniority_level", "description", "industry", "job_function", "apply_method"]) {
      expect(body).toHaveProperty(k);
    }
  });

  it("--body - — reads the JSON body from stdin", async () => {
    const { runRecruiterCreateJob } = await import("../../src/commands/recruiter.js");
    const out = makeOut();
    const readers = makeReaders({ stdin: JSON.stringify(FULL_BODY) });

    await runRecruiterCreateJob(client as never, {
      account: "acc_1",
      body: "-",
      json: true,
    }, out, readers);

    expect(readers.readStdin).toHaveBeenCalled();
    const body = (ns.recruiter.createJob as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual(FULL_BODY);
  });

  it("scalar convenience flags merge OVER the JSON body", async () => {
    const { runRecruiterCreateJob } = await import("../../src/commands/recruiter.js");
    const out = makeOut();
    // JSON sets job_title/description; the scalar flags must override them.
    const readers = makeReaders({
      stdin: JSON.stringify({ ...FULL_BODY, description: "OLD", employment_status: "PART_TIME" }),
    });

    await runRecruiterCreateJob(client as never, {
      account: "acc_1",
      body: "-",
      "job-title-id": "title_2",
      "job-title": "Staff Engineer",
      description: "NEW",
      "employment-status": "FULL_TIME",
      json: true,
    }, out, readers);

    const body = (ns.recruiter.createJob as Mock).mock.calls[0]![0] as Record<string, unknown>;
    // --job-title-id/--job-title map to job_title:{id,name} (an object in the API).
    expect(body["job_title"]).toEqual({ id: "title_2", name: "Staff Engineer" });
    expect(body["description"]).toBe("NEW");
    expect(body["employment_status"]).toBe("FULL_TIME");
    // Untouched JSON fields survive.
    expect(body["company"]).toEqual(FULL_BODY.company);
    expect(body["apply_method"]).toEqual(FULL_BODY.apply_method);
  });

  it("scalar flags alone (no JSON source) assemble the full required body", async () => {
    const { runRecruiterCreateJob } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterCreateJob(client as never, {
      account: "acc_1",
      ...FULL_RECRUITER_JOB_FLAGS,
      "project-name": "Q3 Hiring",
      json: true,
    }, out);

    const body = (ns.recruiter.createJob as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({ ...FULL_RECRUITER_JOB_BODY, project_name: "Q3 Hiring" });
  });

  // ── v2's createJob always opens a brand-new project; project_name is a
  // genuinely new top-level requirement (not a rename) — folded into the
  // shared required-fields check alongside the rest of the job body.
  it("missing project_name (no --project-name, no project_name in JSON) exits 2 naming --project-name, before any SDK call", async () => {
    const { runRecruiterCreateJob } = await import("../../src/commands/recruiter.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runRecruiterCreateJob(client as never, {
        account: "acc_1",
        ...FULL_RECRUITER_JOB_FLAGS,
      }, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    const stderrText = (out.stderr.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    expect(stderrText).toContain("--project-name");
    expect(ns.recruiter.createJob).not.toHaveBeenCalled();
  });

  it("missing a required job-body field (e.g. --workplace-type) exits 2 naming the flag, before any SDK call", async () => {
    const { runRecruiterCreateJob } = await import("../../src/commands/recruiter.js");
    const out = makeOut();
    const exitSpy = mockExit();
    const flags = { ...FULL_RECRUITER_JOB_FLAGS } as Record<string, string | undefined>;
    delete flags["workplace-type"];

    try {
      await runRecruiterCreateJob(client as never, {
        account: "acc_1",
        ...flags,
        "project-name": "Q3 Hiring",
      }, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    const stderrText = (out.stderr.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    expect(stderrText).toContain("--workplace-type");
    expect(ns.recruiter.createJob).not.toHaveBeenCalled();
  });

  it("invalid JSON from --body-file exits 2 before any SDK call", async () => {
    const filePath = join(tmpDir, "bad.json");
    await writeFile(filePath, "{ not valid json ");

    const { runRecruiterCreateJob } = await import("../../src/commands/recruiter.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runRecruiterCreateJob(client as never, {
        account: "acc_1",
        "body-file": filePath,
      }, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(ns.recruiter.createJob).not.toHaveBeenCalled();
  });

  it("non-object JSON (array) from stdin exits 2 before any SDK call", async () => {
    const { runRecruiterCreateJob } = await import("../../src/commands/recruiter.js");
    const out = makeOut();
    const readers = makeReaders({ stdin: "[1,2,3]" });
    const exitSpy = mockExit();

    try {
      await runRecruiterCreateJob(client as never, {
        account: "acc_1",
        body: "-",
      }, out, readers);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(ns.recruiter.createJob).not.toHaveBeenCalled();
  });

  it("--preview shows the fully assembled body (JSON + scalar flags)", async () => {
    const { runRecruiterCreateJob } = await import("../../src/commands/recruiter.js");
    const out = makeOut();
    const readers = makeReaders({ stdin: JSON.stringify(FULL_BODY) });

    await runRecruiterCreateJob(client as never, {
      account: "acc_1",
      body: "-",
      "job-title-id": "title_9",
      "job-title": "Lead Engineer",
      preview: true,
    }, out, readers);

    expect(ns.recruiter.createJob).not.toHaveBeenCalled();
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.method).toBe("recruiter.createJob");
    // Honest preview: the assembled body carries the merged scalar override.
    expect(parsed.body.job_title).toEqual({ id: "title_9", name: "Lead Engineer" });
    expect(parsed.body.company).toEqual(FULL_BODY.company);
  });
});

// ─── recruiter job publish ─────────────────────────────────────────────────

describe("recruiter job publish", () => {
  let ns: ReturnType<typeof makeRecruiterNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeRecruiterNs();
    client = makeClient(ns);
    (ns.recruiter.publishJob as Mock).mockResolvedValue({ object: "job_posting_published", job_id: "job_1" });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls recruiter.publishJob with projectId + jobId verbatim (v2: project-scoped)", async () => {
    const { runRecruiterPublishJob } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterPublishJob(client as never, {
      account: "acc_1",
      projectId: "proj_9",
      jobId: "job_42",
      mode: "FREE",
      json: true,
    }, out);

    expect(ns.recruiter.publishJob).toHaveBeenCalledWith(
      "proj_9",
      "job_42",
      expect.objectContaining({ mode: "FREE" }),
    );
  });

  it("--preview renders request, does not call publishJob", async () => {
    const { runRecruiterPublishJob } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterPublishJob(client as never, {
      account: "acc_1",
      projectId: "proj_9",
      jobId: "job_42",
      mode: "FREE",
      preview: true,
    }, out);

    expect(ns.recruiter.publishJob).not.toHaveBeenCalled();
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.method).toBe("recruiter.publishJob");
  });

  it("--mode PROMOTED with --budget-* publishes with the budget object", async () => {
    const { runRecruiterPublishJob } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterPublishJob(client as never, {
      account: "acc_1",
      projectId: "proj_9",
      jobId: "job_42",
      mode: "PROMOTED",
      "budget-currency": "EUR",
      "budget-amount": "25",
      "budget-scope": "DAILY",
      json: true,
    }, out);

    expect(ns.recruiter.publishJob).toHaveBeenCalledWith(
      "proj_9",
      "job_42",
      { mode: "PROMOTED", budget: { currency: "EUR", amount: 25, scope: "DAILY" } },
    );
  });

  it("without --mode exits 2 naming --mode, no SDK call", async () => {
    const { runRecruiterPublishJob } = await import("../../src/commands/recruiter.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runRecruiterPublishJob(client as never, { account: "acc_1", projectId: "proj_9", jobId: "job_42" }, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    const stderrText = (out.stderr.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    expect(stderrText).toContain("--mode");
    expect(ns.recruiter.publishJob).not.toHaveBeenCalled();
  });

  it("--mode PROMOTED without --budget-* exits 2 naming --budget-currency, no SDK call", async () => {
    const { runRecruiterPublishJob } = await import("../../src/commands/recruiter.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runRecruiterPublishJob(client as never, { account: "acc_1", projectId: "proj_9", jobId: "job_42", mode: "PROMOTED" }, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    const stderrText = (out.stderr.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    expect(stderrText).toContain("--budget-currency");
    expect(ns.recruiter.publishJob).not.toHaveBeenCalled();
  });
});

// ─── recruiter job close <project_id> <job_id> ────────────────────────────

describe("recruiter job close", () => {
  let ns: ReturnType<typeof makeRecruiterNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeRecruiterNs();
    client = makeClient(ns);
    (ns.recruiter.closeJob as Mock).mockResolvedValue({ object: "recruiter_job_posting_closed" });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls recruiter.closeJob with projectId + jobId verbatim, bodyless", async () => {
    const { runRecruiterCloseJob } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterCloseJob(client as never, { account: "acc_1", projectId: "proj_9", jobId: "job_42", json: true }, out);

    expect(ns.recruiter.closeJob).toHaveBeenCalledWith("proj_9", "job_42");
  });

  it("--preview renders request, does not call closeJob", async () => {
    const { runRecruiterCloseJob } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterCloseJob(client as never, { account: "acc_1", projectId: "proj_9", jobId: "job_42", preview: true }, out);

    expect(ns.recruiter.closeJob).not.toHaveBeenCalled();
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.method).toBe("recruiter.closeJob");
  });
});

// ─── recruiter talent-search <project_id> --channel-id <id> ───────────────

describe("recruiter talent-search", () => {
  let ns: ReturnType<typeof makeRecruiterNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeRecruiterNs();
    client = makeClient(ns);
    (ns.recruiter.searchTalentPool as Mock).mockResolvedValue({ items: [{ id: "cand_1" }], cursor: null });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls recruiter.searchTalentPool with projectId verbatim and channel_id in the body", async () => {
    const { runRecruiterSearchTalentPool } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterSearchTalentPool(client as never, {
      account: "acc_1",
      projectId: "proj_9",
      "channel-id": "ch_1",
      keywords: "backend",
      json: true,
    }, out);

    const calls = (ns.recruiter.searchTalentPool as Mock).mock.calls;
    expect(calls[0]![0]).toBe("proj_9");
    expect(calls[0]![1]).toEqual(expect.objectContaining({ channel_id: "ch_1", keywords: "backend" }));
  });

  it("missing --channel-id exits 2 before any SDK call", async () => {
    const { runRecruiterSearchTalentPool } = await import("../../src/commands/recruiter.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runRecruiterSearchTalentPool(client as never, { account: "acc_1", projectId: "proj_9", json: true }, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    const stderrText = (out.stderr.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    expect(stderrText).toContain("--channel-id");
    expect(ns.recruiter.searchTalentPool).not.toHaveBeenCalled();
  });

  it("--all streams all pages", async () => {
    (ns.recruiter.searchTalentPool as Mock)
      .mockResolvedValueOnce({ items: [{ id: "cand_1" }], cursor: "cur_1" })
      .mockResolvedValueOnce({ items: [{ id: "cand_2" }], cursor: null });

    const { runRecruiterSearchTalentPool } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterSearchTalentPool(client as never, {
      account: "acc_1",
      projectId: "proj_9",
      "channel-id": "ch_1",
      all: true,
      json: true,
    }, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("\n");
    const lines = written.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(2);
  });
});

// ─── recruiter applicants ──────────────────────────────────────────────────

describe("recruiter applicants", () => {
  let ns: ReturnType<typeof makeRecruiterNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeRecruiterNs();
    client = makeClient(ns);
    (ns.recruiter.listApplicants as Mock).mockResolvedValue({ items: [{ id: "app_1" }], cursor: null });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls recruiter.listApplicants with projectId verbatim and channel_id in the body (v2: project-scoped, channel_id required)", async () => {
    const { runRecruiterListApplicants } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterListApplicants(client as never, {
      account: "acc_1",
      projectId: "proj_99",
      "channel-id": "ch_1",
      json: true,
    }, out);

    // Third arg is optional pagination params; when no pagination flags are set, passes undefined.
    const calls = (ns.recruiter.listApplicants as Mock).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0]![0]).toBe("proj_99");
    expect(calls[0]![1]).toEqual({ channel_id: "ch_1" });
    expect(calls[0]![2]).toBeUndefined();
  });

  it("missing --channel-id exits 2 before any SDK call", async () => {
    const { runRecruiterListApplicants } = await import("../../src/commands/recruiter.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runRecruiterListApplicants(client as never, {
        account: "acc_1",
        projectId: "proj_99",
        json: true,
      }, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(ns.recruiter.listApplicants).not.toHaveBeenCalled();
  });
});

// ─── recruiter job get ────────────────────────────────────────────────────

// Real Recruiter `recruiter_job_posting` v2 shape: `company` is a nested
// object (no top-level company_id), the applicant count is
// `applications_count`, and `published_at` (unlike the Core job_posting
// shape) IS a real field here — see the D13-sweep note on slimJob.
const richRecruiterJob = {
  object: "recruiter_job_posting",
  id: "4428113858",
  title: "Founders Associate",
  company: { id: "67756343", name: "LEAGUES" },
  state: "active",
  location: "Stuttgart, Baden-Württemberg, Germany",
  cost: 0,
  applications_count: 75,
  description: "Über deine Rolle: build the founding team.",
  created_at: "2026-06-12T10:07:09.000Z",
  published_at: "2026-06-12T10:08:03.000Z",
  hiring_team: [],
};

describe("recruiter job get", () => {
  let ns: ReturnType<typeof makeRecruiterNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeRecruiterNs();
    client = makeClient(ns);
    (ns.recruiter.getJob as Mock).mockResolvedValue(richRecruiterJob);
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("full job URL resolves to the numeric id and calls recruiter.getJob", async () => {
    const { runRecruiterGetJob } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterGetJob(client as never, {
      account: "acc_1",
      jobId: "https://www.linkedin.com/jobs/view/4428113858",
      json: true,
    }, out);

    expect(ns.recruiter.getJob).toHaveBeenCalledWith("4428113858");
  });

  it("bare numeric id calls recruiter.getJob with an identical request", async () => {
    const { runRecruiterGetJob } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterGetJob(client as never, {
      account: "acc_1",
      jobId: "4428113858",
      json: true,
    }, out);

    expect(ns.recruiter.getJob).toHaveBeenCalledWith("4428113858");
  });

  it("--preview is a usage error on this read command; no SDK call is made", async () => {
    const { runRecruiterGetJob } = await import("../../src/commands/recruiter.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runRecruiterGetJob(client as never, {
        account: "acc_1",
        jobId: "4428113858",
        preview: true,
      }, out);
      expect.fail("Should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(ns.recruiter.getJob).not.toHaveBeenCalled();
  });

  it("slim output has exactly the 10 documented fields, excludes hiring_team/cost", async () => {
    const { runRecruiterGetJob } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterGetJob(client as never, {
      account: "acc_1",
      jobId: "4428113858",
      json: true,
    }, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as Record<string, unknown>;
    expect(Object.keys(result)).toHaveLength(10);
    expect(result).not.toHaveProperty("hiring_team");
    expect(result).not.toHaveProperty("cost");
    expect(result["description"]).toBe(richRecruiterJob.description);
  });

  it("D13 sweep: company_id is synthesized from the nested company.id, applications_count surfaces, published_at is real and used directly (unaffected by the Core-shape created_at fallback)", async () => {
    const { runRecruiterGetJob } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterGetJob(client as never, {
      account: "acc_1",
      jobId: "4428113858",
      json: true,
    }, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as Record<string, unknown>;
    expect(result["company_id"]).toBe("67756343");
    expect(result["applications_count"]).toBe(75);
    expect(result["published_at"]).toBe("2026-06-12T10:08:03.000Z");
    expect(result).not.toHaveProperty("applicants_counter");
  });

  it("--verbose returns the full SDK response including hiring_team, cost, created_at", async () => {
    const { runRecruiterGetJob } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterGetJob(client as never, {
      account: "acc_1",
      jobId: "4428113858",
      json: true,
      verbose: true,
    }, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as Record<string, unknown>;
    expect(result).toHaveProperty("hiring_team");
    expect(result).toHaveProperty("cost");
    expect(result).toHaveProperty("created_at");
  });

  it("tier gate: TIER_NOT_ACTIVE → exit 5, requiredTier:recruiter", async () => {
    const tierErr = makeTierError("TIER_NOT_ACTIVE", "recruiter");
    (ns.recruiter.getJob as Mock).mockRejectedValue(tierErr);

    const { CurviateError } = await import("@curviate/sdk");
    Object.setPrototypeOf(tierErr, CurviateError.prototype);

    const { runRecruiterGetJob } = await import("../../src/commands/recruiter.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runRecruiterGetJob(client as never, { account: "acc_1", jobId: "4428113858", json: true }, out);
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(5)");
    } finally {
      exitSpy.mockRestore();
    }

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.error.code).toBe("TIER_NOT_ACTIVE");
    expect(parsed.error.requiredTier).toBe("recruiter");
  });

  it("unknown job exits with the resource-not-found exit code", async () => {
    const notFoundErr = Object.assign(new Error("Job offer not found"), {
      code: "RESOURCE_NOT_FOUND",
      userFixable: true,
      retryLikelyToSucceed: false,
      toJSON: () => ({ code: "RESOURCE_NOT_FOUND", message: "Job offer not found" }),
    });
    (ns.recruiter.getJob as Mock).mockRejectedValue(notFoundErr);

    const { CurviateError } = await import("@curviate/sdk");
    Object.setPrototypeOf(notFoundErr, CurviateError.prototype);

    const { runRecruiterGetJob } = await import("../../src/commands/recruiter.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runRecruiterGetJob(client as never, { account: "acc_1", jobId: "9999999999999", json: true }, out);
      expect.fail("Should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(4)");
    } finally {
      exitSpy.mockRestore();
    }

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.error.code).toBe("RESOURCE_NOT_FOUND");
  });
});

// ─── recruiter applicant ──────────────────────────────────────────────────

describe("recruiter applicant", () => {
  let ns: ReturnType<typeof makeRecruiterNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeRecruiterNs();
    client = makeClient(ns);
    (ns.recruiter.getApplicant as Mock).mockResolvedValue({ id: "app_1", name: "Alice" });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls recruiter.getApplicant with projectId + applicantId verbatim (v2: project-scoped, no resolveIdentifier)", async () => {
    const { runRecruiterGetApplicant } = await import("../../src/commands/recruiter.js");
    const out = makeOut();

    await runRecruiterGetApplicant(client as never, {
      account: "acc_1",
      projectId: "proj_9",
      applicantId: "app_abc",
      json: true,
    }, out);

    expect(ns.recruiter.getApplicant).toHaveBeenCalledWith("proj_9", "app_abc");
  });
});

// ─── recruiter applicant resume ────────────────────────────────────────────

describe("recruiter applicant resume", () => {
  let ns: ReturnType<typeof makeRecruiterNs>;
  let client: ReturnType<typeof makeClient>;
  let tmpDir: string;

  beforeEach(async () => {
    ns = makeRecruiterNs();
    client = makeClient(ns);
    tmpDir = await mkdtemp(join(tmpdir(), "curviate-test-rec-resume-"));
    vi.resetModules();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("-o <file> writes ArrayBuffer bytes to disk, exit 0", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    (ns.recruiter.downloadResume as Mock).mockResolvedValue(bytes.buffer);

    const { runRecruiterDownloadResume } = await import("../../src/commands/recruiter.js");
    const outPath = join(tmpDir, "resume.pdf");
    const out = makeOut();

    await runRecruiterDownloadResume(client as never, {
      account: "acc_1",
      projectId: "proj_9",
      applicantId: "app_1",
      output: outPath,
    }, out, false /* isTTY=false */);

    const written = await readFile(outPath);
    expect(written).toEqual(Buffer.from(bytes.buffer));
    expect(ns.recruiter.downloadResume).toHaveBeenCalledWith("proj_9", "app_1");
  });

  it("TTY without -o exits 2", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    (ns.recruiter.downloadResume as Mock).mockResolvedValue(bytes.buffer);

    const { runRecruiterDownloadResume } = await import("../../src/commands/recruiter.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runRecruiterDownloadResume(client as never, {
        account: "acc_1",
        applicantId: "app_1",
      }, out, true /* isTTY=true, no -o */);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("--preview on read: exits 2", async () => {
    const { runRecruiterDownloadResume } = await import("../../src/commands/recruiter.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runRecruiterDownloadResume(client as never, {
        account: "acc_1",
        applicantId: "app_1",
        preview: true,
      }, out, false);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(ns.recruiter.downloadResume).not.toHaveBeenCalled();
  });
});

// no recruiter inmail-balance in registry

describe("recruiter registry has no inmail-balance", () => {
  it("recruiterCommand does not have an inmail-balance subcommand", async () => {
    vi.resetModules();
    const { recruiterCommand } = await import("../../src/commands/recruiter.js");
    const subCommands = (recruiterCommand as { subCommands?: Record<string, unknown> }).subCommands ?? {};
    expect("inmail-balance" in subCommands).toBe(false);
  });
});
