/** `feed home`: flag -> feed.home params, output, --all, account refusal. */
import { describe, expect } from "vitest";
import { runFeedHome } from "../../src/commands/feed.js";
import { calls, prints, refuses, streams } from "../helpers/f3-unit.js";

const SHAPE = { feed: { home: { object: "feed", items: [{ activity_id: "1", author_name: "Jane Doe" }], cursor: null } } };

describe("feed home", () => {
  calls(SHAPE, [
    ["no params by default", runFeedHome, {}, "feed.home", [{}]],
    ["--sort maps to sort", runFeedHome, { sort: "relevant" }, "feed.home", [expect.objectContaining({ sort: "relevant" })]],
    ["--limit/--cursor pass through", runFeedHome, { limit: "10", cursor: "cur_1" }, "feed.home", [expect.objectContaining({ limit: 10, cursor: "cur_1" })]],
  ]);
  prints(SHAPE, [["--json prints the response", runFeedHome, {}, "feed.home"]]);
  streams(SHAPE, [["feed home", runFeedHome, {}, "feed.home"]]);
  refuses(SHAPE, [["no connected account", runFeedHome, { account: null }, 2]]);
});
