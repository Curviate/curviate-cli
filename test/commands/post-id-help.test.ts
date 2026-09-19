/**
 * post <post_id> help text — URL acceptance + comment guidance
 *
 * All post subcommands taking <post_id> must describe it as accepting:
 *   - numeric id
 *   - urn:li:activity:N
 *   - full LinkedIn share URL
 *
 * post get: description notes POSTID is the post's id and points at the
 *   `comment list <post_id>` command for a post's comments.
 * post react: v2 has no --comment-id (comment-level reactions moved to the
 *   comment group) — the description must not claim it exists.
 *
 * Note: actual URL extraction round-trip is server scope.
 * This test covers help text only.
 */

import { describe, it, expect } from "vitest";

async function getPostSubCmdArgs() {
  const { postCommand } = await import("../../src/commands/post.js");
  return (postCommand as Record<string, unknown>).subCommands as Record<
    string,
    { args?: Record<string, { description?: string }> }
  >;
}

describe("post <post_id> descriptions — URL acceptance + comment guidance", () => {
  it("post get — postId description mentions LinkedIn share URL", async () => {
    const subCmds = await getPostSubCmdArgs();
    const postIdDesc = subCmds["get"]?.args?.["postId"]?.description ?? "";
    expect(postIdDesc.toLowerCase()).toMatch(/url|share url|linkedin/i);
  });

  it("post reactions — postId description mentions LinkedIn share URL", async () => {
    const subCmds = await getPostSubCmdArgs();
    const postIdDesc = subCmds["reactions"]?.args?.["postId"]?.description ?? "";
    expect(postIdDesc.toLowerCase()).toMatch(/url|share url|linkedin/i);
  });

  it("post react — postId description mentions LinkedIn share URL or urn", async () => {
    const subCmds = await getPostSubCmdArgs();
    const postIdDesc = subCmds["react"]?.args?.["postId"]?.description ?? "";
    expect(postIdDesc.toLowerCase()).toMatch(/url|urn|linkedin/i);
  });

  it("post get — postId description points at the comment group for a post's comments", async () => {
    const subCmds = await getPostSubCmdArgs();
    const postIdDesc = subCmds["get"]?.args?.["postId"]?.description ?? "";
    expect(postIdDesc.toLowerCase()).toMatch(/comment list/i);
  });

  it("post react — has no --comment-id flag (v2: comment reactions moved to the comments.* group)", async () => {
    const subCmds = await getPostSubCmdArgs();
    expect(subCmds["react"]?.args?.["comment-id"]).toBeUndefined();
  });
});

/**
 * A video or image post is a `ugcPost` object wrapped in an activity,
 * and the two carry different numbers. The share URL carries the wrapper, so
 * the bare numeric and `urn:li:activity:` forms derived from it read fine and
 * are REJECTED on a write. The help text named only those three forms, so the
 * one form that works was undiscoverable and was found by trial, at the cost of
 * failed live write attempts on a real account.
 *
 * The set under test is derived from the command tree at run time, never a hand
 * list: the old text was three near-copies, and a fourth copy is exactly how
 * this comes back.
 */
describe("every POSTID description names the form that works on a video or image post", () => {
  async function postIdDescriptions(): Promise<Array<[string, string]>> {
    const subCmds = await getPostSubCmdArgs();
    return Object.entries(subCmds)
      .filter(([, cmd]) => cmd?.args?.["postId"] !== undefined)
      .map(([name, cmd]) => [name, cmd.args!["postId"]!.description ?? ""]);
  }

  it("covers every post subcommand that takes a POSTID, and there is more than one", async () => {
    const found = await postIdDescriptions();
    // Anti-vacuity: a filter that matched nothing would make every arm below pass.
    expect(found.length).toBeGreaterThan(4);
  });

  it("each one names urn:li:ugcPost: and says it is for the write", async () => {
    for (const [name, desc] of await postIdDescriptions()) {
      expect(desc, name).toContain("urn:li:ugcPost:");
      expect(desc.toLowerCase(), name).toContain("video");
      expect(desc.toLowerCase(), name).toContain("write");
    }
  });

  it("each one still names the opaque id a read returns, alongside the three derived forms", async () => {
    for (const [name, desc] of await postIdDescriptions()) {
      expect(desc, name).toContain("post get");
      expect(desc, name).toContain("urn:li:activity:N");
      expect(desc.toLowerCase(), name).toContain("share url");
    }
  });
});
