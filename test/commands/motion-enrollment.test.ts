/**
 * `curviate motion` and `curviate enrollment` list filters on the wire: comma
 * lists stay lists.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lines, wire } from "../helpers/wire.js";

describe("motion and enrollment lists: the request each filter sends", () => {
  it.each([
    [["enrollment", "list", "--motion", "mot_1", "--step", "opener,bump", "--step", "follow"],
      { call: "GET /v1/enrollments", query: { motion_id: "mot_1", step_id: "opener,bump,follow" }, body: undefined }],
    [["enrollment", "list", "--accounts", "acc_a,acc_b"], { call: "GET /v1/enrollments", query: { account_id: "acc_a,acc_b" }, body: undefined }],
    [["enrollment", "list", "--account", "acc_a,acc_b"], { call: "GET /v1/enrollments", query: { account_id: "acc_a,acc_b" }, body: undefined }],
    [["motion", "list", "--account", "acc_a,acc_b", "--sort", "activity"], { call: "GET /v1/motions", query: { account_id: "acc_a,acc_b", sort: "activity" }, body: undefined }],
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

it("motion list --sort outside updated|activity exits 2 with no request", async () => {
  const r = await wire(["motion", "list", "--sort", "name"]);
  expect([r.status, r.sent.length]).toEqual([2, 0]);
});

describe("motion create: schedule.timezone is retired", () => {
  it("is refused locally, nothing sent; the same file without it is sent", async () => {
    const file = (schedule: object) => {
      const p = join(mkdtempSync(join(tmpdir(), "motion-")), "m.json");
      writeFileSync(p, JSON.stringify({ name: "M", schedule }));
      return p;
    };
    const hours = { days: ["mon"], hours: { start: "09:00", end: "17:00" } };
    const send = (schedule: object) => wire(["motion", "create", "--file", file(schedule)], () => ({ body: { object: "motion", id: "mot_1" } }));
    const bad = await send({ ...hours, timezone: "Europe/Berlin" });
    expect([bad.status, bad.sent]).toEqual([2, []]);
    expect(bad.stderr + bad.stdout).toContain("timezone");
    const ok = await send(hours);
    expect([ok.status, lines(ok.sent).map((l) => l.call)]).toEqual([0, ["POST /v1/motions"]]);
  });
});

describe("motion create and update: settings.priority, and the retired keys the API still accepts", () => {
  it.each([["create"], ["update mot_1"]])("%s sends priority and the retired keys as written, and prints the API's SETTING_REMOVED notice", async (verb) => {
    const settings = { priority: "prioritized", new_enrollments_per_account_per_day: 15, assign: "even" };
    const p = join(mkdtempSync(join(tmpdir(), "motion-")), "m.json");
    writeFileSync(p, JSON.stringify({ name: "M", settings }));
    const notices = [{ code: "SETTING_REMOVED", message: "settings.assign even is retired" }];
    const r = await wire(["motion", ...verb.split(" "), "--file", p], () => ({ body: { object: "motion", id: "mot_1", notices } }));
    expect(r.status, r.stderr).toBe(0);
    expect((r.sent[0]!.body as { settings: unknown }).settings).toEqual(settings);
    expect(r.stderr + r.stdout).toContain("SETTING_REMOVED");
    writeFileSync(p, JSON.stringify({ name: "M", settings: { priority: "high" } }));
    const refused = await wire(["motion", ...verb.split(" "), "--file", p], () => ({ body: {} }));
    expect([refused.status, refused.sent]).toEqual([2, []]);
  });
});

describe("motion voice-clip", () => {
  const clip = { object: "voice_clip", id: "vc_01J8Z3K9P0Q1R2S3T4V5W6X7Y8", duration_ms: 42010, bytes: 3, filename: "intro.mp3", created_at: "2026-10-31T09:30:00.000Z" };
  const audio = () => {
    const p = join(mkdtempSync(join(tmpdir(), "clip-")), "intro.mp3");
    writeFileSync(p, Buffer.from([1, 2, 3]));
    return p;
  };

  it("upload sends the file's bytes raw with its name and prints the clip; get reads one back", async () => {
    const up = await wire(["motion", "voice-clip", "upload", audio()], () => ({ status: 201, body: clip }));
    expect(up.status, up.stderr).toBe(0);
    expect(up.sent.map((s) => [s.method, s.path, s.query, s.bytes, s.headers.get("content-type")])).toEqual([["POST", "/v1/motions/voice-clips", { filename: "intro.mp3" }, [1, 2, 3], "audio/mpeg"]]);
    expect(JSON.parse(up.stdout).id).toBe(clip.id);
    const get = await wire(["motion", "voice-clip", "get", clip.id], () => ({ body: clip }));
    expect([get.status, lines(get.sent).map((l) => l.call)]).toEqual([0, [`GET /v1/motions/voice-clips/${clip.id}`]]);
  });

  it("--preview and a missing file send nothing; the API's refusal exits 2 and names the reason", async () => {
    const preview = await wire(["motion", "voice-clip", "upload", audio(), "--preview"]);
    expect([preview.status, preview.sent, JSON.parse(preview.stdout).attachments]).toEqual([0, [], ["intro.mp3 (3 bytes)"]]);
    const missing = await wire(["motion", "voice-clip", "upload", "/nope/x.mp3"]);
    expect([missing.status, missing.sent]).toEqual([2, []]);
    const refused = await wire(["motion", "voice-clip", "upload", audio()], () => ({
      status: 422,
      body: { code: "VOICE_CLIP_INVALID", message: "The clip is 121.0 s; the limit is 120 s.", user_fixable: true, retry_likely_to_succeed: false },
    }));
    expect([refused.status, refused.stderr + refused.stdout]).toEqual([2, expect.stringContaining("the limit is 120 s")]);
  });
});
