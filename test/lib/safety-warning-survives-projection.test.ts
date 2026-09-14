/**
 * `safety_warning` must survive the render pipeline on every command.
 *
 * The API attaches `safety_warning` to a successful object response when the
 * account crossed a safety ceiling on the warn posture: the action happened,
 * and this is the only signal that the next one may be refused. The slim
 * projectors rebuild the body from an allowlist and `--fields` is a strict
 * allowlist, so without an explicit reattach the warning is discarded before
 * the caller ever sees it.
 *
 * Projectors are enumerated from `lib/slim.ts`, so a new one is covered
 * automatically.
 */

import { describe, it, expect } from "vitest";
import { renderSuccess, type OutputStreams } from "../../src/lib/output.js";
import * as slimModule from "../../src/lib/slim.js";

const WARNING = {
  row: "profile_views",
  reset_at: "2026-09-15T00:00:00Z",
  hint: { parameter: "profile_views.daily", message: "The action went through." },
  reason: "ceiling",
  blocked: false,
};

function capture(): OutputStreams & { captured: { stdout: string; stderr: string } } {
  const captured = { stdout: "", stderr: "" };
  return {
    captured,
    stdout: { write: (s: string) => void (captured.stdout += s) },
    stderr: { write: (s: string) => void (captured.stderr += s) },
  };
}

const projectors: Array<[string, (data: unknown) => unknown]> = Object.entries(
  slimModule as unknown as Record<string, unknown>,
)
  .filter(([n, v]) => typeof v === "function" && n.startsWith("slim") && !n.endsWith("Item"))
  .map(([n, v]) => [n, v as (data: unknown) => unknown]);

const listWith = (extra: Record<string, unknown>) => ({
  object: "some_list",
  items: [{ id: "item_1", extra: 1 }],
  cursor: null,
  ...extra,
});

describe("safety_warning survives slim projection", () => {
  it("the reflection found the projectors", () => {
    expect(projectors.length).toBeGreaterThanOrEqual(12);
  });

  it.each(projectors)("%s: list envelope keeps safety_warning in JSON", (_n, slim) => {
    const out = capture();
    renderSuccess(listWith({ safety_warning: WARNING }), { json: true, isTTY: false, slim }, out);
    expect((JSON.parse(out.captured.stdout) as Record<string, unknown>)["safety_warning"]).toEqual(WARNING);
  });

  it.each(projectors)("%s: single object keeps safety_warning in JSON", (_n, slim) => {
    const out = capture();
    renderSuccess({ id: "x", object: "thing", safety_warning: WARNING }, { json: true, isTTY: false, slim }, out);
    expect((JSON.parse(out.captured.stdout) as Record<string, unknown>)["safety_warning"]).toEqual(WARNING);
  });

  it.each(projectors)("%s: no safety_warning key invented when absent", (_n, slim) => {
    const out = capture();
    renderSuccess(listWith({}), { json: true, isTTY: false, slim }, out);
    expect(out.captured.stdout).not.toContain("safety_warning");
  });
});

describe("safety_warning survives --fields", () => {
  it("single object: --fields keeps it, projection still applies", () => {
    const out = capture();
    renderSuccess(
      { id: "acc_1", status: "active", safety_warning: WARNING },
      { json: true, isTTY: false, fields: "id" },
      out,
    );
    expect(JSON.parse(out.captured.stdout)).toEqual({ id: "acc_1", safety_warning: WARNING });
  });

  it("slim + --fields on a list keeps it", () => {
    const out = capture();
    renderSuccess(
      listWith({ safety_warning: WARNING }),
      { json: true, isTTY: false, fields: "id", slim: slimModule.slimSearchPeople },
      out,
    );
    expect((JSON.parse(out.captured.stdout) as Record<string, unknown>)["safety_warning"]).toEqual(WARNING);
  });

  it("--fields safety_warning does not warn about an unknown field", () => {
    const out = capture();
    renderSuccess(
      { id: "acc_1", object: "account", safety_warning: WARNING },
      { json: true, isTTY: false, fields: "safety_warning", slim: slimModule.slimAccountGet },
      out,
    );
    expect(out.captured.stderr).not.toContain("not present");
    expect(JSON.parse(out.captured.stdout)).toEqual({ safety_warning: WARNING });
  });

  it("human mode surfaces it on a list response", () => {
    const out = capture();
    renderSuccess(
      listWith({ safety_warning: WARNING }),
      { json: false, isTTY: true, slim: slimModule.slimSearchPeople },
      out,
    );
    expect(out.captured.stdout).toContain("safety_warning:");
    expect(out.captured.stdout).toContain("profile_views");
  });

  it("human mode surfaces it on a single object under --fields", () => {
    const out = capture();
    renderSuccess(
      { id: "acc_1", object: "account", status: "active", safety_warning: WARNING },
      { json: false, isTTY: true, fields: "id" },
      out,
    );
    expect(out.captured.stdout).toContain("id: acc_1");
    expect(out.captured.stdout).toContain(`safety_warning: ${JSON.stringify(WARNING)}`);
    expect(out.captured.stdout).not.toContain("status");
  });

  it("a non-object safety_warning is not carried", () => {
    const out = capture();
    renderSuccess(
      { id: "a", status: "x", safety_warning: null },
      { json: true, isTTY: false, fields: "id" },
      out,
    );
    expect(JSON.parse(out.captured.stdout)).toEqual({ id: "a" });
  });
});
