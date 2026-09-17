/**
 * Reaction listings carry no time of the reaction. `parent_post.created_at` is
 * the post's time, which reads like a recency signal and is not one, so every
 * help string that lists reactions says so and points at `--limit` instead.
 */
import { describe, it, expect } from "vitest";
import { postCommand } from "../../src/commands/post.js";
import { profileCommand } from "../../src/commands/profile.js";

type Node = {
  meta?: { description?: string };
  args?: Record<string, { description?: string }>;
  subCommands?: Record<string, Node>;
};

const surfaces: Array<[string, () => string | undefined]> = [
  ["post user-reactions", () => (postCommand as unknown as Node).subCommands?.["user-reactions"]?.meta?.description],
  ["profile me --reactions", () => (profileCommand as unknown as Node).subCommands?.["me"]?.args?.["reactions"]?.description],
  ["profile <id> --reactions", () => (profileCommand as unknown as Node).args?.["reactions"]?.description],
];

describe("reaction listings: no reaction timestamp caveat", () => {
  it.each(surfaces)("%s help names the missing timestamp and --limit", (_name, read) => {
    const desc = read();
    expect(desc).toBeTypeOf("string");
    expect(desc).toContain("parent_post.created_at");
    expect(desc).toContain("--limit");
  });

  it("control: a sibling listing without the caveat does not match", () => {
    const desc = (profileCommand as unknown as Node).args?.["comments"]?.description;
    expect(desc).toBeTypeOf("string");
    expect(desc).not.toContain("parent_post.created_at");
  });
});
