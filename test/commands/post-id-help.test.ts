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
 * A video or image post is a `ugcPost` object wrapped in an activity, and the
 * two carry different numbers. The share URL carries the wrapper, so the bare
 * numeric and `urn:li:activity:` forms derived from it read fine and a reaction
 * sent to them is rejected. The help named only those three forms, so the one
 * form that works was undiscoverable and was found by trial, at the cost of
 * failed live write attempts on a real account.
 *
 * Two things the text must NOT do, both of which an earlier revision did:
 *
 *   - recommend the `urn` unconditionally. The `urn` names the post's canonical
 *     content object, and a repost's canonical object is the post it reposted,
 *     so a reaction sent to a repost's `urn` lands on the original with a 200
 *     and nothing to warn the caller. The `urn` is the fallback for a rejected
 *     reaction; the `id` stays the default.
 *   - claim "a write" is rejected. Only a reaction was measured.
 *
 * `save` and `unsave` reach a DIFFERENT seam (the server declares their id as a
 * urn and builds a save-state key from it), where the rejection was never
 * observed and the remedy is inert, so they carry the grammar alone.
 *
 * The covered set is derived from the command tree at run time, never a hand
 * list: the old text was three near-copies, and a fourth copy is exactly how
 * this comes back. Counts are EXACT, so a new subcommand landing on the wrong
 * variant reds this file rather than passing a `>=` floor.
 */
describe("every POSTID description carries the right variant for its seam", () => {
  async function postIdDescriptions(): Promise<Array<[string, string]>> {
    const subCmds = await getPostSubCmdArgs();
    return Object.entries(subCmds)
      .filter(([, cmd]) => cmd?.args?.["postId"] !== undefined)
      .map(([name, cmd]) => [name, cmd.args!["postId"]!.description ?? ""]);
  }

  const REACTION_SENTENCE = "If a reaction on a video or image post is rejected";

  it("exactly 7 post subcommands take a POSTID: 5 on the posts/reactions seam, 2 on the saved-post seam", async () => {
    const found = await postIdDescriptions();
    expect(found.map(([n]) => n).sort()).toEqual(
      ["delete", "get", "react", "reactions", "save", "unreact", "unsave"],
    );
    expect(found).toHaveLength(7);

    const withException = found.filter(([, d]) => d.includes(REACTION_SENTENCE));
    expect(withException.map(([n]) => n).sort()).toEqual(["delete", "get", "react", "reactions", "unreact"]);
    expect(withException).toHaveLength(5);

    const grammarOnly = found.filter(([, d]) => !d.includes(REACTION_SENTENCE));
    expect(grammarOnly.map(([n]) => n).sort()).toEqual(["save", "unsave"]);
    expect(grammarOnly).toHaveLength(2);
  });

  it("all 7 name the full grammar, including the opaque id and the ugcPost/share URNs", async () => {
    const found = await postIdDescriptions();
    expect(found).toHaveLength(7);
    for (const [name, desc] of found) {
      expect(desc, name).toContain("post get");
      expect(desc, name).toContain("urn:li:activity:N");
      expect(desc, name).toContain("urn:li:ugcPost:N");
      expect(desc, name).toContain("urn:li:share:N");
      expect(desc.toLowerCase(), name).toContain("share url");
    }
  });

  it("the 5 posts/reactions ones offer the urn as a FALLBACK and warn about a repost, and never claim a write is rejected", async () => {
    const found = (await postIdDescriptions()).filter(([, d]) => d.includes(REACTION_SENTENCE));
    expect(found).toHaveLength(5);
    for (const [name, desc] of found) {
      expect(desc, name).toContain("Prefer the id a read returns.");
      expect(desc.toLowerCase(), name).toContain("video");
      expect(desc.toLowerCase(), name).toContain("repost");
      expect(desc, name).toContain("that urn names the original");
      // Only a reaction was measured. These two overclaim.
      expect(desc, name).not.toContain("a write sent to that number is rejected");
      expect(desc, name).not.toContain("For a write on one of those");
    }
  });

  it("the 2 saved-post ones carry the grammar and NOT the reaction claim", async () => {
    const found = (await postIdDescriptions()).filter(([n]) => n === "save" || n === "unsave");
    expect(found).toHaveLength(2);
    for (const [name, desc] of found) {
      expect(desc.toLowerCase(), name).not.toContain("reaction");
      expect(desc.toLowerCase(), name).not.toContain("rejected");
      expect(desc.toLowerCase(), name).not.toContain("repost");
    }
  });

  it("the two variants are different strings, and the long one extends the short one", async () => {
    const found = await postIdDescriptions();
    const long = found.find(([n]) => n === "react")![1];
    const short = found.find(([n]) => n === "save")![1];
    // Anti-vacuity: without this the per-variant arms could both be reading one text.
    expect(long).not.toBe(short);
    expect(long.startsWith(short)).toBe(true);
  });
});
