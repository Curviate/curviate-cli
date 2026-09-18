/**
 * Coverage for the check:vendored-descriptions drift guard
 * (scripts/check-vendored-descriptions.mjs).
 *
 * Unlike check:fixture-pin (a whole-file hash), this compares description
 * strings field by field so a stale wording is caught regardless of what it
 * says — the phrase-grep it replaces missed six stale retention sentences
 * because it was tuned to the wrong wording.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffDescriptions } from "../scripts/check-vendored-descriptions.mjs";

const tmpDirs: string[] = [];

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

async function writeFixture(name: string, content: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "check-vendored-descriptions-"));
  tmpDirs.push(dir);
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(content), "utf8");
  return path;
}

describe("check:vendored-descriptions — diffDescriptions (RED)", () => {
  it("flags a description that changed wording as STALE", async () => {
    const sdk = await writeFixture("sdk.json", {
      paths: { "/v1/foo": { post: { description: "the new wording" } } },
    });
    const cli = await writeFixture("cli.json", {
      paths: { "/v1/foo": { post: { description: "the OLD wording" } } },
    });
    const rows = diffDescriptions(sdk, cli);
    expect(rows).toEqual([["STALE", "paths\0/v1/foo\0post", "the OLD wording"]]);
  });

  it("flags a description present upstream but absent from the vendored copy as MISSING", async () => {
    const sdk = await writeFixture("sdk.json", {
      paths: { "/v1/foo": { post: { description: "new field, not yet vendored" } } },
    });
    const cli = await writeFixture("cli.json", { paths: {} });
    const rows = diffDescriptions(sdk, cli);
    expect(rows).toEqual([
      ["MISSING", "paths\0/v1/foo\0post", "new field, not yet vendored"],
    ]);
  });

  it("flags a description present in the vendored copy but gone upstream as EXTRA", async () => {
    const sdk = await writeFixture("sdk.json", { paths: {} });
    const cli = await writeFixture("cli.json", {
      paths: { "/v1/foo": { post: { description: "removed upstream" } } },
    });
    const rows = diffDescriptions(sdk, cli);
    expect(rows).toEqual([["EXTRA", "paths\0/v1/foo\0post", "removed upstream"]]);
  });

  it("distinguishes two paths-keys that would collide if joined on '/' (the delimiter this guard uses NUL to avoid)", async () => {
    // Two distinct OpenAPI locations whose ancestor-key chains would produce
    // the identical "/"-joined string: paths["/a"].post.description vs.
    // paths["/a/post"].description. A "/"-joined key merges these into one
    // Map entry and silently drops one comparison; NUL-joining keeps them
    // distinct.
    const sdk = await writeFixture("sdk.json", {
      paths: {
        "/a": { post: { description: "desc for /a POST" } },
        "/a/post": { description: "desc for /a/post itself" },
      },
    });
    const cli = await writeFixture("cli.json", {
      paths: {
        "/a": { post: { description: "STALE desc for /a POST" } },
        "/a/post": { description: "desc for /a/post itself" },
      },
    });
    const rows = diffDescriptions(sdk, cli);
    // Both locations must be visited independently: exactly one STALE row,
    // for the one that actually differs — not zero (merged away) and not
    // two (double-counted).
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.[0]).toBe("STALE");
    expect(row?.[2]).toBe("STALE desc for /a POST");
  });

  it("matching fixtures produce zero diffs", async () => {
    const sdk = await writeFixture("sdk.json", {
      paths: { "/v1/foo": { post: { description: "same" } } },
    });
    const cli = await writeFixture("cli.json", {
      paths: { "/v1/foo": { post: { description: "same" } } },
    });
    expect(diffDescriptions(sdk, cli)).toEqual([]);
  });
});
