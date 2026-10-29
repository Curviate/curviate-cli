/**
 * `curviate motion` and `curviate enrollment` list filters on the wire: comma
 * lists stay lists.
 */
import { describe, it, expect } from "vitest";
import { lines, wire } from "../helpers/wire.js";

describe("motion and enrollment lists: the request each filter sends", () => {
  it.each([
    [["enrollment", "list", "--motion", "mot_1", "--step", "opener,bump", "--step", "follow"],
      { call: "GET /v1/enrollments", query: { motion_id: "mot_1", step_id: "opener,bump,follow" }, body: undefined }],
  ])("%j", async (args, expected) => {
    const r = await wire(args, () => ({ body: { object: "list", items: [], cursor: null } }));
    expect([r.status, lines(r.sent)]).toEqual([0, [expected]]);
  });
});
