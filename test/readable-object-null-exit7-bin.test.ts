/**
 * A single-object read's 2xx must be a readable object: `null`, a scalar, or
 * a bare array is no API answer for a single-resource read — a platform
 * fault, exit 7 (per the exit-code spec's As-built note), never a silent
 * exit 0 (e.g. `company x1` with a `null` body, the reported bug).
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
 * only `GET`s is a read and MUST exit 7; anything else (a write, or a
 * usage error that sent nothing) is not constrained here.
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
  BINARY_DOWNLOAD_ALLOWLIST,
  type SweepResult,
} from "./helpers/live-command-sweep.js";

type Classified = { key: string; variant: string; kind: "read" | "write-or-usage-error" | "binary-allowlisted"; result: SweepResult };

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
      : allGet
        ? "read"
        : "write-or-usage-error";
    classified.push({ key, variant: v.variant, kind, result });
  }

  it("at least one variant is classified a write or usage error (control: the classifier discriminates)", () => {
    // Same-path positive control for the classifier itself: proves
    // "write-or-usage-error" isn't a label nothing ever gets.
    expect(classified.some((c) => c.kind === "write-or-usage-error")).toBe(true);
  });

  it("the binary-download allowlist is exactly the commands that hit it (control: no stale or missing entries)", () => {
    const seen = new Set(classified.filter((c) => c.kind === "binary-allowlisted").map((c) => c.key));
    expect(seen).toEqual(BINARY_DOWNLOAD_ALLOWLIST);
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
// A companion regression: a WRITE that gets a genuine `204` (null body)
// must keep exiting 0 — `renderSuccess` is shared between reads and
// writes, and only a read's call site passes its result through
// `readableObject`.
// ---------------------------------------------------------------------------

describe("writes keep rendering a null 204 body: renderSuccess is shared, only a READ's call site adds readableObject", () => {
  it("comment delete: a genuine 204 (empty body, decodes to null) still exits 0", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(204);
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const result = await run(["comment", "delete", "1", "1", "--verbose"], `http://127.0.0.1:${port}`);
      expect(result.status, `stdout=${result.stdout} stderr=${result.stderr}`).toBe(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
