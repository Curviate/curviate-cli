/**
 * `curviate motion` against the recording sink: what reaches the wire, what
 * is refused before it, and the offline commands with no credential at all.
 * Every refusal is paired with a same-path control that sends.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateSequence } from "@curviate/sdk";
import { useSink, line, type Hit } from "../helpers/sink.js";
import { runCli } from "../helpers/run-inproc.js";
import { pkgRoot } from "../helpers/pkg.js";
import { BULK_MAX_IDS, TEMPLATES } from "../../src/commands/motion.js";

const dir = mkdtempSync(join(tmpdir(), "curviate-motion-"));
const put = (name: string, content: string) => (writeFileSync(join(dir, name), content), join(dir, name));

const SEQUENCE = {
  on_reply: "end",
  steps: [
    { id: "invite", do: "invite.send", with: { note: null } },
    { id: "w_accept", until: "invite.accepted", timeout: "21d", then: "hello", else: "end" },
    { id: "hello", do: "message.send", with: { text: "Hi {{first_name}}, thanks for connecting.", fallback: "Hi, thanks for connecting." }, next: "end" },
  ],
};
const REQUEST = {
  name: "Q4 webinar follow-up",
  contact_list_ids: ["cl_1"],
  exclusion_list_ids: [],
  account_ids: ["acc_1"],
  schedule: { timezone: "Europe/Berlin", days: ["mon", "tue"], hours: { start: "09:00", end: "18:00" } },
  settings: { stop_on_engagement: false },
  where: [],
  sequence: SEQUENCE,
};
const READ_ONLY = {
  object: "motion", id: "mot_1", status: "active", pause_reason: null, sequence_version: 2, sequence_revision: 3, sequence_updated_by_user_id: "usr_1",
  counts: { pending: 0, active: 1, paused: 0, finished: 0, skipped: 0 }, warnings: [], created_by_user_id: "usr_1",
  created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-02T00:00:00Z", started_at: null, completed_at: null, archived_at: null, safety_warning: null,
};
/** `motion get` output: every key of the GET response. */
const MOTION = { ...READ_ONLY, ...REQUEST };

const sink = useSink((h) => ({
  body: h.method !== "GET" ? { object: "motion", id: "mot_1" } : h.url.startsWith("/v1/motions?") ? { object: "list", items: [], cursor: null } : MOTION,
}));
const sent = (r: { requests: Hit[] }) => r.requests.map((q) => [line(q), q.body ? JSON.parse(q.body) : null]);
const NO_KEY = { env: { CURVIATE_API_KEY: undefined, CURVIATE_BASE_URL: "http://127.0.0.1:1" } };

describe("a pasted `motion get` is a Motion file", () => {
  it.each([
    [["motion", "create"], "POST /v1/motions"],
    [["motion", "update", "mot_1"], "PATCH /v1/motions/mot_1"],
  ])("%j --file -: exit 0, the body is the request projection, stderr names every dropped key", async (argv, request) => {
    const got = await sink.run(["motion", "get", "mot_1", "--json"]);
    expect([got.status, JSON.parse(got.stdout)]).toEqual([0, MOTION]);
    const r = await sink.run([...argv, "--file", "-", "--json"], { stdin: got.stdout });
    expect([r.status, sent(r)], r.stderr).toEqual([0, [[request, REQUEST]]]);
    expect(r.stderr).toContain(`warning: dropped ${Object.keys(READ_ONLY).join(", ")}: set by Curviate`);
  });

  it("an unknown key exits 2 with the nearest field suggested, nothing sent; the unknown key's value is never echoed", async () => {
    const r = await sink.run(["motion", "create", "--file", "-", "--json"], { stdin: JSON.stringify({ ...MOTION, acount_ids: ["CANARY_VALUE"] }) });
    expect([r.status, r.requests.length]).toEqual([2, 0]);
    expect(JSON.parse(r.stdout).error).toMatchObject({ code: "INVALID_REQUEST", errors: [{ path: "acount_ids", rule: "unknown field", suggestion: "account_ids" }] });
    expect(r.stderr).toContain("acount_ids: unknown field (did you mean account_ids?)");
    expect(r.stdout + r.stderr).not.toContain("CANARY_VALUE");
  });
});

/** A Motion file whose Sequence breaks R12 on line 7 (an out-of-range wait). */
const R12_FILE = [
  "{",
  '  "name": "x",',
  '  "sequence": {',
  '    "on_reply": "end",',
  '    "steps": [',
  '      { "id": "invite", "do": "invite.send", "with": { "note": null } },',
  '      { "id": "pause", "wait": "999d", "next": "end" }',
  "    ]",
  "  }",
  "}",
].join("\n");

describe("Sequence findings in the compiler format", () => {
  it("motion lint: one line per finding at the pointer's line and column, with the hint and docs URL; exit 2, offline, no credential needed", async () => {
    const file = put("r12.json", R12_FILE);
    const r = await runCli(["motion", "lint", "--file", file], NO_KEY);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}:7:32 error R12 pause\\.wait: .+\\. .+ -> https://docs\\.curviate\\.com/reference/sequence-rules#r12$`, "m"));
    const json = JSON.parse(r.stdout) as { error: { code: string; errors: Array<{ code: string; pointer: string }> } };
    expect([json.error.code, json.error.errors.map((e) => [e.code, e.pointer])]).toEqual(["SEQUENCE_INVALID", [["R12", "/steps/1/wait"]]]);
    // A bare Sequence document from stdin: the same finding, named `-`, no `/sequence` prefix.
    const bare = JSON.stringify(JSON.parse(R12_FILE).sequence, null, 2);
    const s = await runCli(["motion", "lint", "--file", "-"], { ...NO_KEY, stdin: bare });
    const at = bare.split("\n").findIndex((l) => l.includes('"999d"')) + 1;
    expect([s.status, s.stderr]).toEqual([2, expect.stringMatching(new RegExp(`^-:${at}:\\d+ error R12 pause\\.wait: `, "m"))]);
  });

  it("a clean document exits 0 and lists its warnings; control: the SDK verdict is what lint prints", async () => {
    const tpl = JSON.stringify(TEMPLATES["connect-and-converse"], null, 2);
    const r = await runCli(["motion", "lint", "--file", put("tpl.json", tpl), "--json"], NO_KEY);
    const verdict = validateSequence((TEMPLATES["connect-and-converse"] as { sequence: unknown }).sequence);
    expect([r.status, JSON.parse(r.stdout)]).toEqual([0, { errors: [], warnings: verdict.warnings }]);
    expect(r.stderr.trim().split("\n").map((l) => / warning (W\d+) (\S+):/.exec(l)?.slice(1))).toEqual(verdict.warnings.map((w) => [w.code, `${w.path}:`.slice(0, -1)]));
  });

  it("motion create with a broken Sequence: exit 2, SEQUENCE_INVALID with every error, nothing sent; control: the fixed file sends once", async () => {
    const r = await sink.run(["motion", "create", "--file", put("bad.json", R12_FILE), "--json"]);
    expect([r.status, r.requests.length, JSON.parse(r.stdout).error.code]).toEqual([2, 0, "SEQUENCE_INVALID"]);
    expect(r.stderr).toMatch(/:7:32 error R12 pause\.wait: /);
    // A canary in a faulty value and in a message text appears in no output.
    const canary = await sink.run(["motion", "create", "--file", put("canary.json", R12_FILE.replace('"999d"', '"CANARY_9d"').replace('"note": null', '"note": "CANARY_NOTE {FIRST}"')), "--json"]);
    expect([canary.status, canary.requests.length, JSON.parse(canary.stdout).error.errors.length]).toEqual([2, 0, 2]);
    expect(canary.stdout + canary.stderr).not.toMatch(/CANARY/);
    const ok = await sink.run(["motion", "create", "--file", put("ok.json", R12_FILE.replace("999d", "3d")), "--json"]);
    expect([ok.status, ok.requests.map(line)]).toEqual([0, ["POST /v1/motions"]]);
  });
});

describe("motion update --if-revision", () => {
  it("sends if_sequence_revision only from the flag, never from the file's sequence_revision", async () => {
    const file = put("m.json", JSON.stringify(MOTION));
    const [without, withRev] = [await sink.run(["motion", "update", "mot_1", "--file", file]), await sink.run(["motion", "update", "mot_1", "--file", file, "--if-revision", "3"])];
    expect([JSON.parse(without.requests[0]!.body)["if_sequence_revision"], JSON.parse(withRev.requests[0]!.body)["if_sequence_revision"]]).toEqual([undefined, 3]);
    // A precondition written into the file is dropped with a warning, never sent.
    const inFile = await sink.run(["motion", "update", "mot_1", "--file", put("p.json", JSON.stringify({ ...REQUEST, if_sequence_revision: 2 }))]);
    expect([inFile.status, JSON.parse(inFile.requests[0]!.body)["if_sequence_revision"], inFile.stderr]).toEqual([0, undefined, expect.stringContaining("dropped if_sequence_revision")]);
  });

  it("SEQUENCE_CONFLICT exits 2 and names the newer revision and who saved it", async () => {
    sink.reply = () => ({
      status: 409,
      body: { code: "SEQUENCE_CONFLICT", message: "The Sequence changed since revision 3.", current: { sequence_revision: 5, sequence_version: 2, sequence: SEQUENCE, sequence_updated_by_user_id: "usr_9", updated_at: "2026-10-21T10:00:00Z" } },
    });
    const r = await sink.run(["motion", "update", "mot_1", "--file", put("c.json", JSON.stringify(REQUEST)), "--if-revision", "3", "--json"]);
    expect([r.status, JSON.parse(r.stdout).error.code]).toEqual([2, "SEQUENCE_CONFLICT"]);
    expect(r.stderr).toContain("saved since revision 3: revision 5 by usr_9 at 2026-10-21T10:00:00Z");
    expect(r.stderr).toContain("--if-revision 5");
  });
});

describe("motion init --template", () => {
  it.each(Object.keys(TEMPLATES))("%s: a Motion file motion create accepts, in this machine's timezone", async (name) => {
    const r = await runCli(["motion", "init", "--template", name], { ...NO_KEY, env: { ...NO_KEY.env, TZ: "Asia/Tokyo" } });
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout) as { schedule: { timezone: string }; sequence: { steps: Array<Record<string, unknown>> } };
    expect(doc.schedule.timezone).toBe("Asia/Tokyo");
    const v = validateSequence(doc.sequence);
    expect([v.errors, v.warnings.map((w) => `${w.code} ${w.path}`)]).toEqual([[], name === "nurture-connections" ? [] : ["W1 w_invite"]]);
    const text = JSON.stringify(doc.sequence);
    expect([text.includes('"emit"'), /\{\{\s*(contact|account|motion)\./.test(text)]).toEqual([false, false]);
    const sent = await sink.run(["motion", "create", "--file", "-"], { stdin: r.stdout });
    expect([sent.status, sent.requests.map(line)]).toEqual([0, ["POST /v1/motions"]]);
  });

  it("nurture-connections follows up only when seen; -o writes the file and nothing to stdout; an unknown template exits 2", async () => {
    expect(JSON.stringify(TEMPLATES["nurture-connections"])).toContain('"message.seen":true');
    const out = join(dir, "init.json");
    const r = await runCli(["motion", "init", "--template", "nurture-connections", "-o", out], NO_KEY);
    expect([r.status, r.stdout, JSON.parse(readFileSync(out, "utf8")).name]).toEqual([0, "", "Nurture connections"]);
    for (const name of ["nope", "constructor", "toString", "__proto__"]) expect((await runCli(["motion", "init", "--template", name], NO_KEY)).status, name).toBe(2);
  });
});

describe("motion add / remove: id batches", () => {
  const openapi = JSON.parse(readFileSync(join(pkgRoot, "test/fixtures/openapi.json"), "utf8")) as { paths: Record<string, { post: { "x-curviate-limits": { items: number } } }> };
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `con_${i + 1}`);

  it("the chunk size is the served x-curviate-limits.items of both operations", () => {
    expect([openapi.paths["/v1/motions/{id}/contacts"]!.post["x-curviate-limits"].items, openapi.paths["/v1/motions/{id}/contacts/remove"]!.post["x-curviate-limits"].items]).toEqual([BULK_MAX_IDS, BULK_MAX_IDS]);
  });

  it.each([
    ["add", "POST /v1/motions/mot_1/contacts"],
    ["remove", "POST /v1/motions/mot_1/contacts/remove"],
  ])("%s: N ids send 1 request, N+1 send 2 in input order", async (verb, request) => {
    const one = await sink.run(["motion", verb, "mot_1", "--contact", ids(BULK_MAX_IDS).join(",")]);
    expect([one.status, one.requests.map(line)]).toEqual([0, [request]]);
    const two = await sink.run(["motion", verb, "mot_1", "--contact", ids(BULK_MAX_IDS + 1).join(",")]);
    expect([two.status, two.requests.map(line), two.requests.map((q) => (JSON.parse(q.body) as { contact_ids: string[] }).contact_ids)]).toEqual([
      0, [request, request], [ids(BULK_MAX_IDS), [`con_${BULK_MAX_IDS + 1}`]],
    ]);
  });

  it("a failed chunk 2 of 3 stops: no chunk 3, one JSON document with error and progress, the chunk's exit", async () => {
    let n = 0;
    sink.reply = () => (++n === 2 ? { status: 409, body: { code: "MOTION_STATUS_CONFLICT", message: "Archived." } } : { body: { object: "motion_contacts_result", results: [] } });
    const r = await sink.run(["motion", "add", "mot_1", "--contact", ids(2 * BULK_MAX_IDS + 1).join(","), "--json"]);
    expect([r.status, r.requests.length]).toEqual([2, 2]);
    expect(JSON.parse(r.stdout)).toEqual({
      error: expect.objectContaining({ code: "MOTION_STATUS_CONFLICT" }),
      progress: { chunks: { sent: 1, total: 3 }, items: { accepted: BULK_MAX_IDS, total: 2 * BULK_MAX_IDS + 1 }, failed_chunk: { index: 2, first_row: BULK_MAX_IDS + 1, last_row: 2 * BULK_MAX_IDS } },
    });
  });

  it("--account is sent only when given, never from the configured default; --contact is required and never empty", async () => {
    const env = { env: { CURVIATE_ACCOUNT: "acc_default" } };
    const plain = await sink.run(["motion", "add", "mot_1", "--contact", "con_1"], env);
    const fixed = await sink.run(["motion", "add", "mot_1", "--contact", "con_1", "--account", "acc_2"], env);
    expect([sent(plain), sent(fixed)]).toEqual([[["POST /v1/motions/mot_1/contacts", { contact_ids: ["con_1"] }]], [["POST /v1/motions/mot_1/contacts", { contact_ids: ["con_1"], account_id: "acc_2" }]]]);
    for (const argv of [["--contact", ""], ["--contact", "con_1,,con_2"], []]) {
      const r = await sink.run(["motion", "add", "mot_1", ...argv]);
      expect([argv.join(" "), r.status, r.requests.length]).toEqual([argv.join(" "), 2, 0]);
    }
  });
});

describe("one request per command", () => {
  it.each<[string[], string]>([
    [["motion", "list", "--status", "active,paused"], "GET /v1/motions?status=active%2Cpaused"],
    [["motion", "get", "mot_1", "--version", "2"], "GET /v1/motions/mot_1/sequence?version=2"],
    [["motion", "start", "mot_1"], "POST /v1/motions/mot_1/start"],
    [["motion", "pause", "mot_1"], "POST /v1/motions/mot_1/pause"],
    [["motion", "resume", "mot_1"], "POST /v1/motions/mot_1/resume"],
    [["motion", "archive", "mot_1"], "POST /v1/motions/mot_1/archive"],
    [["motion", "delete", "mot_1"], "DELETE /v1/motions/mot_1"],
    [["motion", "preview", "mot_1", "--sample", "3"], "GET /v1/motions/mot_1/preview?sample=3"],
    [["motion", "preview", "mot_1", "--contact", "con_1,con_2"], "GET /v1/motions/mot_1/preview?contact_ids=con_1%2Ccon_2"],
  ])("%j", async (argv, request) => {
    const r = await sink.run([...argv, "--json"]);
    expect([r.status, r.requests.map((q) => `${q.method} ${q.url}`)], r.stderr).toEqual([0, [request]]);
  });

  it("refused before any request: an unknown --status, --sample with --contact, --sample out of range", async () => {
    for (const argv of [["motion", "list", "--status", "running"], ["motion", "preview", "mot_1", "--sample", "2", "--contact", "con_1"], ["motion", "preview", "mot_1", "--sample", "21"]]) {
      const r = await sink.run(argv);
      expect([argv.join(" "), r.status, r.requests.length]).toEqual([argv.join(" "), 2, 0]);
    }
  });
});
