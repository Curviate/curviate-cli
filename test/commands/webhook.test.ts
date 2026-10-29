/**
 * `curviate webhook` (templates, deliveries, rotation, test), `curviate
 * incoming`, `curviate beta`: each command's request on the wire, the offline
 * lints, `webhook verify` on either secret during a rotation, and the one
 * `Curviate-Client` header every request carries.
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lines, wire } from "../helpers/wire.js";
import { runCli } from "../helpers/run-inproc.js";
import { version } from "../../package.json";

const file = (name: string, text: string) => {
  const p = join(mkdtempSync(join(tmpdir(), "cv-wh-")), name);
  writeFileSync(p, text);
  return p;
};
const TEMPLATE = '{"email": "{{contact.email}}"}';
const q = (call: string, query: Record<string, string> = {}, body?: unknown) => ({ call, query, body });

describe("webhook, incoming, beta: the request each command sends", () => {
  it.each([
    [["webhook", "create", "--source", "motion", "--request-url", "https://example.com/h", "--template-file", file("t.json", TEMPLATE), "--custom-events", "research_ready", "--header", "X-Token: abc", "--header", "X-Keep"],
      q("POST /v1/webhooks", {}, { source: "motion", request_url: "https://example.com/h", enabled: true, body_template: TEMPLATE, custom_event_names: ["research_ready"], headers: [{ key: "X-Token", value: "abc" }, { key: "X-Keep" }] })],
    [["webhook", "update", "wh_1", "--header", "X-Keep"], q("PATCH /v1/webhooks/wh_1", {}, { headers: [{ key: "X-Keep" }] })],
    [["webhook", "variables", "--source", "motion"], q("GET /v1/webhooks/variables", { source: "motion" })],
    [["webhook", "deliveries", "wh_1", "--failed"], q("GET /v1/webhooks/wh_1/deliveries", { failed: "true" })],
    [["webhook", "deliveries", "wh_1", "dlv_1"], q("GET /v1/webhooks/wh_1/deliveries/dlv_1")],
    [["webhook", "redeliver", "wh_1", "dlv_1"], q("POST /v1/webhooks/wh_1/deliveries/dlv_1/redeliver")],
    [["webhook", "rotate", "wh_1"], q("POST /v1/webhooks/wh_1/rotate-secret")],
    [["webhook", "test", "wh_1", "--event", "enrollment.finished"], q("POST /v1/webhooks/wh_1/test", {}, { event: "enrollment.finished" })],
    [["incoming", "create", "--event-name", "reply_received", "--match-email", "lead_email", "--required-header", "X-Auth: s3"],
      q("POST /v1/incoming-events", {}, { event_name: "reply_received", match: { email: "lead_email" }, required_header: { name: "X-Auth", value: "s3" } })],
    [["incoming", "list", "--event", "reply_received"], q("GET /v1/incoming-events", { event: "reply_received" })],
    [["incoming", "get", "inc_1"], q("GET /v1/incoming-events/inc_1")],
    [["incoming", "update", "inc_1", "--no-enabled", "--motion", ""], q("PATCH /v1/incoming-events/inc_1", {}, { motion_id: null, enabled: false })],
    [["incoming", "delete", "inc_1"], q("DELETE /v1/incoming-events/inc_1")],
    [["incoming", "rotate", "inc_1"], q("POST /v1/incoming-events/inc_1/rotate")],
    [["incoming", "capture", "inc_1"], q("POST /v1/incoming-events/inc_1/capture")],
    [["incoming", "arrivals", "inc_1"], q("GET /v1/incoming-events/inc_1/arrivals")],
    [["beta", "status"], q("GET /v1/tenant/beta")],
    [["beta", "update", "--enabled", "false"], q("PATCH /v1/tenant/beta", {}, { beta_enabled: false })],
  ])("%j", async (args, expected) => {
    const r = await wire(args, () => ({ body: { object: "x", items: [], cursor: null } }));
    expect([r.status, lines(r.sent)]).toEqual([0, [expected]]);
  });

  it.each([
    [["incoming", "create", "--match-email", "lead_email"]],
    [["incoming", "create", "--event-name", "a", "--event-name-field", "b"]],
    [["beta", "update", "--enabled", "yes"]],
  ])("%j exits 2 with no request", async (args) => {
    const r = await wire(args);
    expect([r.status, r.sent.length]).toEqual([2, 0]);
  });

  it("every request carries exactly one Curviate-Client header, cli/<version>", async () => {
    const r = await wire(["beta", "status"]);
    expect(r.sent[0]!.headers.get("curviate-client")).toBe(`cli/${version}`);
  });
});

describe("offline lints (no request, exit 2 on a finding)", () => {
  it("webhook lint: a clean template exits 0; an unknown variable is reported with its code and place", async () => {
    const ok = await wire(["webhook", "lint", "--template-file", file("ok.json", TEMPLATE), "--source", "motion"]);
    expect([ok.status, ok.sent.length]).toEqual([0, 0]);
    const bad = await wire(["webhook", "lint", "--template-file", file("bad.json", '{"x": "{{nope.var}}"}'), "--source", "motion", "--json"]);
    expect([bad.status, bad.sent.length]).toEqual([2, 0]);
    expect(JSON.parse(bad.stdout).error.errors.map((e: { code: string }) => e.code)).toEqual(["T6"]);
    expect(bad.stderr).toMatch(/bad\.json:1:\d+ error T6/);
  });

  it("motion lint inherits the Enrollment value rules: save outside an until step is R25", async () => {
    const seq = file("s.json", JSON.stringify({ version: 1, steps: [{ id: "invite", do: "invite.send", save: { score: "lead.score" } }] }));
    const r = await wire(["motion", "lint", "--file", seq]);
    expect([r.status, r.sent.length]).toEqual([2, 0]);
    expect(r.stderr).toContain("R25");
  });
});

describe("webhook verify during a rotation", () => {
  const body = JSON.stringify({ event: "enrollment.finished", data: {} });
  const t = Math.floor(Date.now() / 1000);
  const mac = (secret: string) => createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  const header = `t=${t},v1=${mac("whsec_new")},v1=${mac("whsec_old")}`;

  it.each([["whsec_new", 0], ["whsec_old", 0], ["whsec_other", 2]])("secret %s exits %i", async (secret, code) => {
    const r = await runCli(["webhook", "verify", "--secret", secret, "--header", header, "--file", file("b.json", body)]);
    expect(r.status).toBe(code);
  });
});
