/**
 * `curviate campaign` and `curviate enrollment` list filters on the wire: comma
 * lists stay lists.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { lines, wire } from "../helpers/wire.js";
import { pkgRoot } from "../helpers/pkg.js";

describe("campaign and enrollment lists: the request each filter sends", () => {
  it.each([
    [["enrollment", "list", "--campaign", "mot_1", "--step", "opener,bump", "--step", "follow"],
      { call: "GET /v1/enrollments", query: { campaign_id: "mot_1", step_id: "opener,bump,follow" }, body: undefined }],
    [["enrollment", "list", "--accounts", "acc_a,acc_b"], { call: "GET /v1/enrollments", query: { account_id: "acc_a,acc_b" }, body: undefined }],
    [["enrollment", "list", "--account", "acc_a,acc_b"], { call: "GET /v1/enrollments", query: { account_id: "acc_a,acc_b" }, body: undefined }],
    [["campaign", "list", "--account", "acc_a,acc_b", "--sort", "activity"], { call: "GET /v1/campaigns", query: { account_id: "acc_a,acc_b", sort: "activity" }, body: undefined }],
  ])("%j", async (args, expected) => {
    const r = await wire(args, () => ({ body: { object: "list", items: [], cursor: null } }));
    expect([r.status, lines(r.sent)]).toEqual([0, [expected]]);
  });
});

describe("enrollment get: history_truncated", () => {
  const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  afterEach(() => (tty ? Object.defineProperty(process.stdout, "isTTY", tty) : delete (process.stdout as { isTTY?: boolean }).isTTY));

  it("a truncated history is said in human mode; a full one says nothing", async () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    const read = (t: boolean) => wire(["enrollment", "get", "enr_1"], () => ({ body: { object: "enrollment", id: "enr_1", history: [], history_truncated: t } }));
    expect((await read(true)).stderr).toContain("history_truncated");
    expect((await read(false)).stderr).not.toContain("history_truncated");
  });

  it("prints the Enrollment's saved values", async () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    const r = await wire(["enrollment", "get", "enr_1"], () => ({ body: { object: "enrollment", id: "enr_1", history: [], values: { meeting_url: "https://cal.example/x" } } }));
    expect(r.stdout).toContain("https://cal.example/x");
  });
});

it("`motion` is an unknown command with no request; root help lists campaign, not motion or contact; no help text, example or hint names `curviate (contact|motion)`", async () => {
  const old = await wire(["motion", "list"]);
  expect([old.status, old.sent.length, old.stderr]).toEqual([2, 0, expect.stringContaining("unknown command")]);
  const help = (await wire(["--help"])).stdout;
  expect(help).toMatch(/^\s+`campaign`\s/m);
  expect(help).not.toMatch(/^\s+`(motion|contact)`\s/m);
  // commands.json holds every command's description, examples, seeAlso, undo and error text
  expect(readFileSync(join(pkgRoot, "commands.json"), "utf8").match(/curviate (contact|motion)\b/g)).toBeNull();
});

it("campaign list --sort outside updated|activity exits 2 with no request", async () => {
  const r = await wire(["campaign", "list", "--sort", "name"]);
  expect([r.status, r.sent.length]).toEqual([2, 0]);
});

describe("campaign create: schedule.timezone is retired", () => {
  it("is refused locally, nothing sent; the same file without it is sent", async () => {
    const file = (schedule: object) => {
      const p = join(mkdtempSync(join(tmpdir(), "campaign-")), "m.json");
      writeFileSync(p, JSON.stringify({ name: "M", schedule }));
      return p;
    };
    const hours = { days: ["mon"], hours: { start: "09:00", end: "17:00" } };
    const send = (schedule: object) => wire(["campaign", "create", "--file", file(schedule)], () => ({ body: { object: "campaign", id: "mot_1" } }));
    const bad = await send({ ...hours, timezone: "Europe/Berlin" });
    expect([bad.status, bad.sent]).toEqual([2, []]);
    expect(bad.stderr + bad.stdout).toContain("timezone");
    const ok = await send(hours);
    expect([ok.status, lines(ok.sent).map((l) => l.call)]).toEqual([0, ["POST /v1/campaigns"]]);
  });
});

describe("campaign lint and create: one verdict on a Campaign file's fields", () => {
  const seq = { on_reply: "end", steps: [{ id: "t", tag: "warm", next: "end" }] };
  it.each([
    ["an unknown top-level key", { name: "M", description: "x", sequence: seq }, 2],
    ["an unknown settings key", { name: "M", settings: { nope: 1 }, sequence: seq }, 2],
    ["no name", { sequence: seq }, 2],
    ["a clean file", { name: "M", sequence: seq }, 0],
  ])("%s: lint and create exit alike, lint sends nothing", async (_what, doc, status) => {
    const p = join(mkdtempSync(join(tmpdir(), "campaign-")), "m.json");
    writeFileSync(p, JSON.stringify(doc));
    const lint = await wire(["campaign", "lint", "--file", p]);
    const create = await wire(["campaign", "create", "--file", p], () => ({ body: { object: "campaign", id: "mot_1" } }));
    expect([lint.status, create.status, lint.sent.length]).toEqual([status, status, 0]);
  });
});

describe("campaign create and update: settings.priority, and the retired keys the API still accepts", () => {
  it.each([["create"], ["update mot_1"]])("%s sends priority and the retired keys as written, and prints the API's SETTING_REMOVED notice", async (verb) => {
    const settings = { priority: "prioritized", new_enrollments_per_account_per_day: 15, assign: "even" };
    const p = join(mkdtempSync(join(tmpdir(), "campaign-")), "m.json");
    writeFileSync(p, JSON.stringify({ name: "M", settings }));
    const notices = [{ code: "SETTING_REMOVED", message: "settings.assign even is retired" }];
    const r = await wire(["campaign", ...verb.split(" "), "--file", p], () => ({ body: { object: "campaign", id: "mot_1", notices } }));
    expect(r.status, r.stderr).toBe(0);
    expect((r.sent[0]!.body as { settings: unknown }).settings).toEqual(settings);
    expect(r.stderr + r.stdout).toContain("SETTING_REMOVED");
    writeFileSync(p, JSON.stringify({ name: "M", settings: { priority: "high" } }));
    const refused = await wire(["campaign", ...verb.split(" "), "--file", p], () => ({ body: {} }));
    expect([refused.status, refused.sent]).toEqual([2, []]);
  });
});

describe("campaign voice-clip", () => {
  const clip = { object: "voice_clip", id: "vc_01J8Z3K9P0Q1R2S3T4V5W6X7Y8", duration_ms: 42010, bytes: 3, filename: "intro.mp3", created_at: "2026-10-31T09:30:00.000Z" };
  const audio = () => {
    const p = join(mkdtempSync(join(tmpdir(), "clip-")), "intro.mp3");
    writeFileSync(p, Buffer.from([1, 2, 3]));
    return p;
  };

  it("upload sends the file's bytes raw with its name and prints the clip; get reads one back", async () => {
    const up = await wire(["campaign", "voice-clip", "upload", audio()], () => ({ status: 201, body: clip }));
    expect(up.status, up.stderr).toBe(0);
    expect(up.sent.map((s) => [s.method, s.path, s.query, s.bytes, s.headers.get("content-type")])).toEqual([["POST", "/v1/campaigns/voice-clips", { filename: "intro.mp3" }, [1, 2, 3], "audio/mpeg"]]);
    expect(JSON.parse(up.stdout).id).toBe(clip.id);
    const get = await wire(["campaign", "voice-clip", "get", clip.id], () => ({ body: clip }));
    expect([get.status, lines(get.sent).map((l) => l.call)]).toEqual([0, [`GET /v1/campaigns/voice-clips/${clip.id}`]]);
  });

  it("--preview and a missing file send nothing; the API's refusal exits 2 and names the reason", async () => {
    const preview = await wire(["campaign", "voice-clip", "upload", audio(), "--preview"]);
    expect([preview.status, preview.sent, JSON.parse(preview.stdout).attachments]).toEqual([0, [], ["intro.mp3 (3 bytes)"]]);
    const missing = await wire(["campaign", "voice-clip", "upload", "/nope/x.mp3"]);
    expect([missing.status, missing.sent]).toEqual([2, []]);
    const refused = await wire(["campaign", "voice-clip", "upload", audio()], () => ({
      status: 422,
      body: { code: "VOICE_CLIP_INVALID", message: "The clip is 121.0 s; the limit is 120 s.", user_fixable: true, retry_likely_to_succeed: false },
    }));
    expect([refused.status, refused.stderr + refused.stdout]).toEqual([2, expect.stringContaining("the limit is 120 s")]);
  });
});

describe("email, parity, Do-not-contact, billing and warm-up flags: the request each sends", () => {
  it.each([
    [["campaign", "start", "mot_1", "--skip-missing-email"], [{ call: "POST /v1/campaigns/mot_1/start", query: {}, body: { skip_missing_email: true } }]],
    [["campaign", "start", "mot_1"], [{ call: "POST /v1/campaigns/mot_1/start", query: {}, body: undefined }]],
    [["campaign", "resume", "mot_1", "--skip-missing-email"], [{ call: "POST /v1/campaigns/mot_1/resume", query: {}, body: { skip_missing_email: true } }]],
    [["campaign", "check", "mot_1"], [{ call: "POST /v1/campaigns/mot_1/check", query: {}, body: undefined }]],
    [["campaign", "preview", "mot_1", "--limit", "3", "--cursor", "c_1"], [{ call: "GET /v1/campaigns/mot_1/preview", query: { limit: "3", cursor: "c_1" }, body: undefined }]],
    [["do-not-contact", "add", "--lead", "con_1", "--scope", "email_only"], [{ call: "POST /v1/do-not-contact", query: {}, body: { lead_id: "con_1", scope: "email_only" } }]],
    [["do-not-contact", "add", "--lead", "con_1", "--scope", "all"], []],
    [["billing", "quote", "--seats", "25"], [{ call: "GET /v1/billing/quote", query: { seats: "25", period: "monthly" }, body: undefined }]],
    [["billing", "cap"], [{ call: "GET /v1/billing/spending-cap", query: {}, body: undefined }]],
    [["account", "warm-up", "on", "acc_1", "--preset", "custom", "--start", "20", "--step", "10", "--every", "2"],
      [{ call: "PATCH /v1/acc_1/safety-policy", query: {}, body: { warm_up: { enabled: true, preset: "custom", start: 20, step: 10, every: 2 } } }]],
    [["account", "warm-up", "on", "acc_1", "--start", "95"], []],
  ])("%j", async (args, expected) => {
    const r = await wire(args, () => ({ body: { object: "x" } }));
    expect([r.status, lines(r.sent)]).toEqual([expected.length ? 0 : 2, expected]);
  });

  it("do-not-contact import --scope fills the rows that name none, CSV and JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dnc-"));
    writeFileSync(join(dir, "a.csv"), "linkedin_url\nhttps://www.linkedin.com/in/a/\n");
    writeFileSync(join(dir, "a.json"), JSON.stringify([{ linkedin_url: "https://www.linkedin.com/in/a/" }, { linkedin_url: "https://www.linkedin.com/in/b/", scope: "everything" }]));
    const send = (f: string) => wire(["do-not-contact", "import", "--file", join(dir, f), "--scope", "email_only"], () => ({ body: { counts: {}, report: [] } }));
    expect(lines((await send("a.csv")).sent).map((l) => l.body)).toEqual([{ csv: "linkedin_url,scope\nhttps://www.linkedin.com/in/a/,email_only" }]);
    expect(lines((await send("a.json")).sent).map((l) => l.body)).toEqual([
      { rows: [{ linkedin_url: "https://www.linkedin.com/in/a/", scope: "email_only" }, { linkedin_url: "https://www.linkedin.com/in/b/", scope: "everything" }] },
    ]);
  });

  it("campaign preview --all pages until next_cursor is null: one request a page, every Lead once, the first page's projection", async () => {
    const leads = Array.from({ length: 47 }, (_, i) => `con_${i}`);
    const r = await wire(["campaign", "preview", "mot_1", "--all", "--limit", "20", "--page-delay", "0", "--json"], (req) => {
      const from = req.query["cursor"] ? Number(req.query["cursor"]) : 0;
      const next = from + 20 < leads.length ? String(from + 20) : null;
      return { body: { object: "campaign_preview", samples: leads.slice(from, from + 20).map((lead_id) => ({ lead_id })), next_cursor: next, ...(from === 0 ? { paths: [["a"]], projection: { leads: 47 } } : {}) } };
    });
    expect(r.status).toBe(0);
    expect(r.sent.map((s) => s.query["cursor"] ?? null)).toEqual([null, "20", "40"]);
    const out = JSON.parse(r.stdout) as { samples: { lead_id: string }[]; projection: unknown; next_cursor: unknown };
    expect([out.samples.map((s) => s.lead_id), out.projection, out.next_cursor]).toEqual([leads, { leads: 47 }, null]);
  });

  it("enrollment get prints next_action as its sentence in human mode, the object with --json", async () => {
    const next_action = { step_id: "m", action: "message.send", at: null, why: "wait", text: "Sends Step 2, message, after the 3-day wait." };
    const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const get = (json: boolean) => wire(["enrollment", "get", "enr_1", ...(json ? ["--json"] : [])], () => ({ body: { object: "enrollment", id: "enr_1", history: [], next_action } }));
    try {
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      const human = (await get(false)).stdout;
      expect([human.includes("Sends Step 2, message, after the 3-day wait."), human.includes("message.send")]).toEqual([true, false]);
    } finally {
      if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
    expect(JSON.parse((await get(true)).stdout).next_action).toEqual(next_action);
  });
});
