/**
 * A single-object read's 2xx must be a readable object: `null`, a scalar, a
 * bare array, or an empty object is no API answer for a single-resource
 * read — a platform fault, exit 7 (per the exit-code spec's As-built note),
 * never a silent exit 0 (e.g. `company x1` with a `null` body, the reported
 * bug) and never a fabricated all-null object (found by qa verifying the prior As-built: an
 * empty or absent 2xx body decodes to `{}` in the SDK, which the original
 * `readableObject` let through — `company 1` against an empty body exited 0
 * printing `{"id":null,"name":null,...}`). Every read variant is swept
 * against all four unreadable shapes (`null`, an empty 200 body, an empty
 * 204, and a literal `{}`), below.
 *
 * The authority here is a RUNTIME SWEEP over the live command registry and
 * observed wire behaviour, not a source-code pattern (the exit-code spec's As-built
 * amendment, qa cycle 2 — the prior AST-based
 * derivation was proven fragile to how a read happens to be written; see
 * `helpers/live-command-sweep.ts`'s module doc for the full list of shapes
 * that defeated it). Every leaf command and every one of its own boolean
 * flags is discovered from the live citty registry, invoked against a
 * local stub that answers every request with a `null` 200 body, and
 * classified by the HTTP methods it actually sent: a variant that sent
 * only `GET`s is a read and MUST exit 7; a variant that sent a non-GET is
 * a write, not constrained here. A variant that sent ZERO requests is not
 * silently skipped (qa cycle 3): it must be a reviewed, named entry in
 * `ZERO_REQUEST_ALLOWLIST`, or the sweep reds on it by name — this is what
 * would have caught `profile <id>` and `recruiter applicant <p> <a>`
 * escaping the first version of this sweep, both zero-request purely
 * because their generated argv was wrong, not because they have nothing to
 * test. `READ_BY_POST` separately covers the small number of reads that
 * use a non-GET verb, invisible to the GET-only rule.
 *
 * One process at a time (RAM discipline, `test-runtime` skill): the sweep
 * runs sequentially during collection, never fanned out.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { cliPath } from "./helpers/built-cli.js";
import {
  discoverSweepVariants,
  runAgainstNullStub,
  runAgainstStub,
  BINARY_DOWNLOAD_ALLOWLIST,
  ZERO_REQUEST_ALLOWLIST,
  READ_BY_POST,
  NULL_BODY,
  EMPTY_200_BODY,
  EMPTY_204_BODY,
  EMPTY_OBJECT_BODY,
  type SweepResult,
  type StubBody,
} from "./helpers/live-command-sweep.js";

/** The three empty-decoding-to-`{}` shapes, swept alongside the original `null` body. */
const EMPTY_SHAPES: Array<{ label: string; body: StubBody }> = [
  { label: "empty 200 body", body: EMPTY_200_BODY },
  { label: "empty 204 body", body: EMPTY_204_BODY },
  { label: "literal {} body", body: EMPTY_OBJECT_BODY },
];

type Classified = {
  key: string;
  variant: string;
  argv: string[];
  kind: "read" | "write" | "zero-request" | "binary-allowlisted";
  result: SweepResult;
};

describe("readableObject guard: runtime sweep over the live command registry", async () => {
  const variants = await discoverSweepVariants();

  it("the sweep covers a real, non-trivial command surface", () => {
    // Guards the guard: if this regresses to 0, the registry walk broke
    // (moved directory, renamed helper) and every test below would
    // vacuously pass having checked nothing. 193 variants (168 leaves + own
    // boolean flags) at authoring time; a wide floor so an unrelated future
    // command or two doesn't need this bumped.
    expect(variants.length).toBeGreaterThanOrEqual(150);
  });

  // Sequential, during collection (RAM discipline): one child process at a
  // time, same technique the rest of this suite already uses for its
  // async-describe-computed node lists.
  const classified: Classified[] = [];
  for (const v of variants) {
    const key = v.path.join(" ");
    const result = await runAgainstNullStub(v.argv);
    const allGet = result.methods.length > 0 && result.methods.every((m) => m === "GET");
    const kind: Classified["kind"] = BINARY_DOWNLOAD_ALLOWLIST.has(key)
      ? "binary-allowlisted"
      : result.methods.length === 0
        ? "zero-request"
        : allGet
          ? "read"
          : "write";
    classified.push({ key, variant: v.variant, argv: v.argv, kind, result });
  }

  it("at least one variant is classified a write (control: the classifier discriminates)", () => {
    // Same-path positive control for the classifier itself: proves "write"
    // isn't a label nothing ever gets.
    expect(classified.some((c) => c.kind === "write")).toBe(true);
  });

  it("the binary-download allowlist is exactly the commands that hit it (control: no stale or missing entries)", () => {
    const seen = new Set(classified.filter((c) => c.kind === "binary-allowlisted").map((c) => c.key));
    expect(seen).toEqual(BINARY_DOWNLOAD_ALLOWLIST);
  });

  // Fail closed (qa cycle 3): a leaf that sent zero requests is NOT quietly
  // "not constrained" — it must be one of the reviewed, named entries, or
  // the sweep reds on it. This is what would have caught `profile <id>`
  // silently escaping the sweep the first time (it sent zero requests for
  // an argv-generation reason, not a legitimate one).
  it("every zero-request variant is a reviewed, named entry in ZERO_REQUEST_ALLOWLIST", () => {
    const zeroRequestKeys = classified.filter((c) => c.kind === "zero-request").map((c) => `${c.key} ${c.variant}`);
    const unexpected = zeroRequestKeys.filter((k) => !ZERO_REQUEST_ALLOWLIST.has(k));
    expect(unexpected, "a leaf sent zero requests but is not a reviewed allowlist entry").toEqual([]);
  });

  it("ZERO_REQUEST_ALLOWLIST has no stale entries (control: every named entry actually sends zero requests)", () => {
    const zeroRequestKeys = new Set(classified.filter((c) => c.kind === "zero-request").map((c) => `${c.key} ${c.variant}`));
    const stale = [...ZERO_REQUEST_ALLOWLIST].filter((k) => !zeroRequestKeys.has(k));
    expect(stale, "an allowlist entry no longer sends zero requests — a fixed leaf must be removed from it").toEqual([]);
  });

  for (const c of classified) {
    if (c.kind !== "read") continue;
    it(`${c.key} ${c.variant}: a read-only leaf (methods=${c.result.methods.join(",")}) exits 7 on a null body`, () => {
      expect(
        c.result.status,
        `stdout=${c.result.stdout} stderr=${c.result.stderr}`,
      ).toBe(7);
    });
  }

  // Found by qa verifying the prior As-built: an empty (or absent) 2xx body decodes to `{}`
  // in the SDK — a second unreadable shape distinct from a literal `null`,
  // which `readableObject` didn't originally reject. Every read variant,
  // swept against all three empty-decoding shapes, same as the null sweep
  // above (sequential, during collection).
  const emptyResults: Array<{ c: Classified; label: string; result: SweepResult }> = [];
  for (const c of classified) {
    if (c.kind !== "read") continue;
    for (const { label, body } of EMPTY_SHAPES) {
      const result = await runAgainstStub(c.argv, body);
      emptyResults.push({ c, label, result });
    }
  }

  for (const { c, label, result } of emptyResults) {
    it(`${c.key} ${c.variant}: a read-only leaf exits 7 on a ${label}`, () => {
      expect(result.status, `stdout=${result.stdout} stderr=${result.stderr}`).toBe(7);
    });
  }
});

// ---------------------------------------------------------------------------
// POST-shaped reads (qa cycle 2 named exceptions: `account checkpoint
// poll`/`solve` check `--preview` inline instead of `rejectPreviewOnRead`;
// `recruiter search parameters` is a POST-as-search read): invisible to the
// GET-only classification above, held to the exit-7 standard by name
// instead. Each is also verified to genuinely be non-GET, so this list
// cannot silently duplicate the sweep above or go unnoticed if a future
// change makes one of them GET (at which point the sweep above would cover
// it and this entry becomes redundant, not wrong).
// ---------------------------------------------------------------------------

describe("readableObject guard: named POST-shaped reads", () => {
  for (const { key, argv } of READ_BY_POST) {
    it(`${key}: a non-GET read (verified) exits 7 on a null body`, async () => {
      const result = await runAgainstNullStub(argv);
      expect(result.methods.some((m) => m !== "GET"), `expected a non-GET request, got methods=${result.methods.join(",")}`).toBe(true);
      expect(result.status, `stdout=${result.stdout} stderr=${result.stderr}`).toBe(7);
    });

    for (const { label, body } of EMPTY_SHAPES) {
      it(`${key}: exits 7 on a ${label}`, async () => {
        const result = await runAgainstStub(argv, body);
        expect(result.status, `stdout=${result.stdout} stderr=${result.stderr}`).toBe(7);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// A valid object body is the same-path positive control: the identical
// argv against a server that DOES return a real object exits 0, proving a
// green sweep above means the guard fires correctly, not that the command
// is broken in general (`--verbose` bypasses each command's own slim
// projector, which may assume fields a minimal fixture object doesn't
// carry; the guard runs before any projection either way).
// ---------------------------------------------------------------------------

function run(args: string[], baseUrl: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: validObjectXdg, NODE_ENV: "production" };
    delete env["CURVIATE_API_KEY"];
    delete env["CURVIATE_ACCOUNT"];
    delete env["CURVIATE_BASE_URL"];
    const child = spawn(process.execPath, [cliPath, ...args, "--json", "--beta", "--api-key", "cvt_test_x", "--account", "acc_1", "--base-url", baseUrl], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (status) => done({ status, stdout, stderr }));
    child.stdin.end("");
  });
}

const validObjectXdg = mkdtempSync(join(tmpdir(), "curviate-readable-object-control-"));

describe("readableObject guard: same-path positive control (one representative node)", async () => {
  const variants = await discoverSweepVariants();
  const representative = variants.find((v) => v.path.join(" ") === "company" && v.variant === "read");

  it("found the representative node (sanity: the fixture didn't drift)", () => {
    expect(representative).toBeDefined();
  });

  it("company <id>: a valid object body exits 0", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "ok_1", name: "ok" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const good = await run([...representative!.argv, "--verbose"], `http://127.0.0.1:${port}`);
      expect(good.status, `stdout=${good.stdout} stderr=${good.stderr}`).toBe(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// ---------------------------------------------------------------------------
// A companion regression: a WRITE that gets a genuine empty/`{}` body
// (the empty/{} shapes included) must keep exiting 0 —
// `renderSuccess` is shared between reads and writes, and only a read's
// call site passes its result through `readableObject`. Every writes
// variant is structurally unaffected by this change (they never call
// `readableObject`), so a representative write (`comment delete`) swept
// against all four bodies is the proportionate regression check, not an
// exhaustive re-sweep of the ~66 write variants already proven
// unconstrained above.
// ---------------------------------------------------------------------------

describe("writes keep rendering an empty/`{}` body: renderSuccess is shared, only a READ's call site adds readableObject", () => {
  for (const { label, body } of [{ label: "null body", body: NULL_BODY }, ...EMPTY_SHAPES]) {
    it(`comment delete: a genuine write response (${label}) still exits 0`, async () => {
      const result = await runAgainstStub(["comment", "delete", "1", "1", "--verbose"], body);
      expect(result.status, `stdout=${result.stdout} stderr=${result.stderr}`).toBe(0);
    });
  }
});
