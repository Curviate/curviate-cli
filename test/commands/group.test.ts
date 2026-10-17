/** `group list|get|members`: flag -> SDK params, output, --all, refusals. */
import { describe, expect } from "vitest";
import { runGroupGet, runGroupList, runGroupMembers } from "../../src/commands/group.js";
import { calls, prints, refuses, streams } from "../helpers/f3-unit.js";

const SHAPE = {
  groups: {
    list: { object: "group_list", items: [{ object: "group", id: "9123014", name: "Alumni Network" }], cursor: null },
    get: { object: "group", id: "9123014", name: "Alumni Network" },
    members: { items: [{ id: "ACoAA1", name: "Jane Doe" }], cursor: null },
  },
};

describe("group", () => {
  calls(SHAPE, [
    ["list: no target by default", runGroupList, {}, "groups.list", [{}]],
    ["list --target maps to the SDK's profile param", runGroupList, { target: "raphael-redmer" }, "groups.list", [expect.objectContaining({ profile: "raphael-redmer" })]],
    ["list --limit/--cursor pass through", runGroupList, { limit: "5", cursor: "cur_1" }, "groups.list", [expect.objectContaining({ limit: 5, cursor: "cur_1" })]],
    ["get passes the id verbatim", runGroupGet, { groupId: "9123014" }, "groups.get", ["9123014"]],
    ["members passes the id verbatim", runGroupMembers, { groupId: "9123014" }, "groups.members", ["9123014", {}]],
    ["members --name maps to the name filter", runGroupMembers, { groupId: "9123014", name: "raphael red" }, "groups.members", ["9123014", expect.objectContaining({ name: "raphael red" })]],
  ]);
  prints(SHAPE, [
    ["list --json", runGroupList, {}, "groups.list"],
    ["get --json", runGroupGet, { groupId: "9123014" }, "groups.get"],
  ]);
  streams(SHAPE, [
    ["list", runGroupList, {}, "groups.list"],
    ["members", runGroupMembers, { groupId: "9123014" }, "groups.members"],
  ]);
  refuses(SHAPE, [
    ["list with no connected account", runGroupList, { account: null }, 2],
    ["get --all (not paginated)", runGroupGet, { groupId: "9123014", all: true }, 2],
  ]);
});
