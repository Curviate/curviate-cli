/**
 * `curviate motion` and `curviate enrollment` list filters on the wire: comma
 * lists stay lists.
 */
import { describe, it, expect, afterEach } from "vitest";
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
