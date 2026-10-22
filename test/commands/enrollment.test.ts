/**
 * `curviate enrollment` against the recording sink. `retry` is pinned to the
 * guarded path (bulk retry), never the unguarded `resume --at` jump.
 */
import { describe, it, expect } from "vitest";
import { useSink, line, type Hit, type Reply } from "../helpers/sink.js";

const sink = useSink((h) => ({ body: h.method === "GET" && !h.url.includes("?") && h.url !== "/v1/enrollments" ? { object: "enrollment", id: "enr_1", history: [] } : { object: "list", items: [], cursor: null } }));
const sent = (r: { requests: Hit[] }) => r.requests.map((q) => [line(q), q.body ? JSON.parse(q.body) : null]);
const query = (h: Hit) => Object.fromEntries(new URL(h.url, "http://x").searchParams);

describe("enrollment list: every filter reaches the query", () => {
  it.each<[string[], Record<string, string>]>([
    [["--motion", "mot_1", "--status", "active,paused"], { motion_id: "mot_1", status: "active,paused" }],
    [["--motion", "mot_1", "--done-step", "opener", "--outcome", "failed"], { motion_id: "mot_1", done_step: "opener", outcome: "failed" }],
    [["--reason", "already_connected,known_chat", "--variant", "v_a", "--relationship", "connected,invite_pending"], { reason: "already_connected,known_chat", variant_id: "v_a", relationship_at_enrollment: "connected,invite_pending" }],
    [["--contact", "con_1", "--step", "w_accept", "--version", "2"], { contact_id: "con_1", step_id: "w_accept", version: "2" }],
  ])("%j", async (flags, expected) => {
    const r = await sink.run(["enrollment", "list", ...flags]);
    expect([r.status, r.requests.map(query)], r.stderr).toEqual([0, [expected]]);
  });

  it("refused before any request: an empty filter, a version that is not a whole number", async () => {
    for (const flags of [["--motion", ""], ["--reason", "a,,b"], ["--version", "x"]]) {
      const r = await sink.run(["enrollment", "list", ...flags]);
      expect([flags.join(" "), r.status, r.requests.length]).toEqual([flags.join(" "), 2, 0]);
    }
  });
});

describe("one Enrollment, one request", () => {
  it.each<[string[], string, unknown]>([
    [["get", "enr_1"], "GET /v1/enrollments/enr_1", null],
    [["pause", "enr_1"], "POST /v1/enrollments/enr_1/pause", null],
    [["stop", "enr_1"], "POST /v1/enrollments/enr_1/stop", null],
    [["resume", "enr_1"], "POST /v1/enrollments/enr_1/resume", null],
    [["resume", "enr_1", "--at", "bump"], "POST /v1/enrollments/enr_1/resume", { at: "bump" }],
    [["event", "enr_1", "research_ready"], "POST /v1/enrollments/enr_1/events", { name: "research_ready" }],
    [["signal", "enr_1", "research_ready"], "POST /v1/enrollments/enr_1/events", { name: "research_ready" }],
    [["reassign", "enr_1", "--account", "acc_2"], "POST /v1/enrollments/enr_1/reassign", { account_id: "acc_2" }],
  ])("%j", async (argv, request, body) => {
    const r = await sink.run(["enrollment", ...argv], { env: { CURVIATE_ACCOUNT: "acc_default" } });
    expect([r.status, sent(r)], r.stderr).toEqual([0, [[request, body]]]);
    expect(r.stderr.includes("`curviate enrollment signal` is deprecated")).toBe(argv[0] === "signal");
  });

  it("resume's help says the jump is not guarded and points to retry", async () => {
    const h = await sink.run(["enrollment", "resume", "--help"]);
    expect(h.stdout.replace(/\s+/g, " ")).toContain("The jump is not guarded: it re-enters the Step even when that Step already sent, so a message can go out again. To retry a failed Step use `curviate enrollment retry <enrollment_id>`");
  });

  it("reassign needs --account, never filled from the configured default", async () => {
    const r = await sink.run(["enrollment", "reassign", "enr_1"], { env: { CURVIATE_ACCOUNT: "acc_default" } });
    expect([r.status, r.requests.length]).toEqual([2, 0]);
  });
});

describe("enrollment retry: the guarded Retry, then the re-run's record", () => {
  const FAILED = { step_id: "opener", outcome: "failed", reason: "platform_error", reason_message: "LinkedIn did not answer." };
  const RERUN = { step_id: "opener", outcome: "executed", reason: null, reason_message: null };
  const bulk = (item: Record<string, unknown>): Reply => ({ body: { object: "enrollment_bulk_result", action: "retry", matched: 1, results: [{ enrollment_id: "enr_1", warnings: [], ...item }] } });
  /** GETs answer `histories` in turn (the last one repeats); the bulk call answers `answer`. */
  const script = (histories: unknown[][], answer: Reply) => {
    let n = 0;
    sink.reply = (h) => (h.method === "GET" ? { body: { object: "enrollment", id: "enr_1", history: histories[Math.min(n++, histories.length - 1)] } } : answer);
  };

  it("resumes through bulk retry (never resume --at), waits for the Step's next record, prints {outcome, reason, message}, exit 0", async () => {
    script([[FAILED], [FAILED], [FAILED, RERUN]], bulk({ outcome: "ok", error: null }));
    const r = await sink.run(["enrollment", "retry", "enr_1", "--json"]);
    expect([r.status, sent(r)], r.stderr).toEqual([0, [
      ["GET /v1/enrollments/enr_1", null],
      ["POST /v1/enrollments/bulk", { action: "retry", ids: ["enr_1"] }],
      ["GET /v1/enrollments/enr_1", null],
      ["GET /v1/enrollments/enr_1", null],
    ]]);
    expect(JSON.parse(r.stdout)).toEqual({ step_id: "opener", outcome: "executed", reason: null, message: null });
  });

  it.each<[string, Reply, number, RegExp]>([
    ["nothing failed", bulk({ outcome: "error", error: { code: "NOTHING_TO_RETRY", message: "Nothing to retry: the latest Step outcome is executed." } }), 2, /nothing to retry/i],
    ["a Step in flight", bulk({ outcome: "error", error: { code: "STEP_IN_FLIGHT", message: "A Step is being sent." } }), 7, /STEP_IN_FLIGHT/],
    ["an answer it cannot read", { body: { object: "enrollment_bulk_result" } }, 7, /may have been applied: check with `curviate enrollment get enr_1`/],
  ])("%s: exit %#, one retry call, nothing waited for", async (_why, answer, exit, message) => {
    script([[FAILED]], answer);
    const r = await sink.run(["enrollment", "retry", "enr_1", "--json"]);
    expect([r.status, r.requests.map(line)]).toEqual([exit, ["GET /v1/enrollments/enr_1", "POST /v1/enrollments/bulk"]]);
    expect(r.stdout + r.stderr).toMatch(message);
  });

  it("the wait runs out (--timeout 0): exit 7, the Step is resumed, read it later, do not retry", async () => {
    script([[FAILED]], bulk({ outcome: "ok", error: null }));
    const r = await sink.run(["enrollment", "retry", "enr_1", "--timeout", "0"]);
    expect([r.status, r.requests.map(line)]).toEqual([7, ["GET /v1/enrollments/enr_1", "POST /v1/enrollments/bulk", "GET /v1/enrollments/enr_1"]]);
    expect(r.stderr).toContain("Step opener was resumed but has not run within 0 ms");
  });
});

describe("enrollment bulk", () => {
  const ANSWER = { object: "enrollment_bulk_result", action: "stop", matched: 2, results: [
    { enrollment_id: "enr_A", outcome: "ok", error: null, warnings: [] },
    { enrollment_id: "enr_B", outcome: "error", error: { code: "ENROLLMENT_NOT_ACTIVE", message: "Already finished." }, warnings: [] },
  ] };

  it.each<[string[], unknown]>([
    [["--action", "stop", "--id", "enr_A,enr_B"], { action: "stop", ids: ["enr_A", "enr_B"] }],
    [["--action", "stop", "--id", "enr_A", "--id", "enr_B"], { action: "stop", ids: ["enr_A", "enr_B"] }],
    [["--action", "retry", "--motion", "mot_1", "--done-step", "opener", "--outcome", "failed"], { action: "retry", filter: { motion_id: "mot_1", done_step: "opener", outcome: "failed" } }],
    [["--action", "resume", "--id", "enr_A", "--at", "bump"], { action: "resume", ids: ["enr_A"], at: "bump" }],
    [["--action", "event", "--motion", "mot_1", "--name", "research_ready"], { action: "event", filter: { motion_id: "mot_1" }, name: "research_ready" }],
    [["--action", "reassign", "--id", "enr_A", "--account", "acc_2"], { action: "reassign", ids: ["enr_A"], account_id: "acc_2" }],
  ])("%j sends one call", async (flags, body) => {
    sink.reply = { body: { ...ANSWER, results: [ANSWER.results[0]] } };
    const r = await sink.run(["enrollment", "bulk", ...flags]);
    expect([r.status, sent(r)], r.stderr).toEqual([0, [["POST /v1/enrollments/bulk", body]]]);
  });

  it("one refused Enrollment: the API's answer printed whole, the refusal's exit", async () => {
    sink.reply = { body: ANSWER };
    const r = await sink.run(["enrollment", "bulk", "--action", "stop", "--id", "enr_A,enr_B", "--json"]);
    expect([r.status, JSON.parse(r.stdout), r.stderr]).toEqual([2, ANSWER, expect.stringContaining("1 of 2 Enrollments were refused")]);
  });

  it("refused before any request: --id with --motion, neither, --id with a filter, an unknown action", async () => {
    for (const flags of [["--action", "stop", "--id", "enr_A", "--motion", "mot_1"], ["--action", "stop"], ["--action", "stop", "--id", "enr_A", "--status", "active"], ["--action", "explode", "--id", "enr_A"]]) {
      const r = await sink.run(["enrollment", "bulk", ...flags]);
      expect([flags.join(" "), r.status, r.requests.length]).toEqual([flags.join(" "), 2, 0]);
    }
  });
});
