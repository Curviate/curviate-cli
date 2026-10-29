/** `account warm-up on|off`: the one PATCH it sends, the policy it prints, and a refusal's exit code. */
import { describe, it, expect } from "vitest";
import { useSink, line, type Hit } from "../helpers/sink.js";

const policy = (enabled: boolean) => ({ warm_up: { enabled, state: enabled ? "ramping" : "none", factor: enabled ? 0.15 : 1, dormant: false }, rows: [] });
const sink = useSink((h: Hit) =>
  h.url.includes("acc_gone")
    ? { status: 404, body: { code: "ACCOUNT_NOT_FOUND", message: "no such account", user_fixable: true, retry_likely_to_succeed: false } }
    : { body: policy(JSON.parse(h.body || "{}").warm_up?.enabled ?? true) });

describe("account warm-up", () => {
  it.each([
    ["on", true],
    ["off", false],
  ])("%s sends one PATCH with warm_up.enabled and prints the policy", async (verb, enabled) => {
    const r = await sink.run(["account", "warm-up", verb, "acc_1", "--json"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.requests.map(line)).toEqual(["PATCH /v1/acc_1/safety-policy"]);
    expect(JSON.parse(r.requests[0]!.body)).toEqual({ warm_up: { enabled } });
    expect(JSON.parse(r.stdout)).toEqual(policy(enabled));
  });

  it("--preview sends nothing; an unknown account exits with the API code", async () => {
    const preview = await sink.run(["account", "warm-up", "off", "acc_1", "--preview"]);
    expect(preview.requests).toHaveLength(0);
    expect(JSON.parse(preview.stdout).body).toEqual({ warm_up: { enabled: false } });
    const gone = await sink.run(["account", "warm-up", "on", "acc_gone", "--json"]);
    expect(gone.status).toBe(4);
    expect(gone.stderr + gone.stdout).toContain("ACCOUNT_NOT_FOUND");
  });
});
