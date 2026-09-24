/**
 * The harness `meta.examples` run in: the BUILT bin on PATH as `curviate`, a
 * local stub standing in for the API, two saved profiles, and the files the
 * examples name. Shared by the tests that execute examples.
 *
 * The stub answers every request with one object in both a single-object and
 * a list-envelope shape.
 */

import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureFreshBuild, pkgRoot } from "./built-cli.js";

export type ManifestCommand = { path: string[]; usageOnly: boolean; examples: string[]; globals: string[]; args: Array<{ name: string; type?: string; required?: boolean }> };

export function readManifest(): ManifestCommand[] {
  return (JSON.parse(readFileSync(join(pkgRoot, "commands.json"), "utf8")) as { commands: ManifestCommand[] }).commands;
}

/** Prompts on a TTY for a masked key: no pty here. */
export const INTERACTIVE_ONLY = new Set(["curviate login"]);

const ITEM = { object: "fixture", id: "id_1", account_id: "acc_1", status: "active", name: "Fixture" };
// A terminal status ends each `--wait` poll loop on its first poll: `resolved`
// for a connect session, `active` for a checkpoint.
const BODY = { ...ITEM, status: "resolved", items: [ITEM], cursor: null };

/** One free seat, so `account link` without --seat-id picks it, as for a first-time reader. */
const SEATS = { object: "seat_list", items: [{ seat_id: "seat_free", occupied: false, account_id: null }] };

export type ExamplesStub = {
  baseUrl: string;
  /** Run one shell line. `fresh`: in its own copy of the seeded config, so earlier runs cannot change what it sees. */
  run(line: string, opts?: { fresh?: boolean }): Promise<{ code: number | null; stdout: string; stderr: string }>;
  stop(): Promise<void>;
};

export async function startExamplesStub(): Promise<ExamplesStub> {
  const cliPath = ensureFreshBuild();
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url?.startsWith("/v1/accounts/seats")) res.end(JSON.stringify(SEATS));
      else res.end(JSON.stringify(req.url?.includes("checkpoint") ? { ...BODY, status: "active" } : BODY));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const workDir = mkdtempSync(join(tmpdir(), "curviate-examples-work-"));
  const shimDir = mkdtempSync(join(tmpdir(), "curviate-examples-bin-"));
  const xdgDir = mkdtempSync(join(tmpdir(), "curviate-examples-xdg-"));
  writeFileSync(join(shimDir, "curviate"), `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} "$@"\n`);
  chmodSync(join(shimDir, "curviate"), 0o755);
  // Two saved profiles, so the `config` examples act on names that exist.
  mkdirSync(join(xdgDir, "curviate"));
  writeFileSync(
    join(xdgDir, "curviate", "config.json"),
    JSON.stringify({ active: "default", profiles: { default: {}, work: {} } }),
    { mode: 0o600 },
  );

  // The files the examples name, as a reader would have them.
  writeFileSync(join(workDir, "description.txt"), "We are hiring a staff engineer to build agent infrastructure. ".repeat(5));
  writeFileSync(join(workDir, "filters.json"), "{}");
  writeFileSync(join(workDir, "job.json"), JSON.stringify({
    job_title: { id: "9", name: "Staff Engineer" },
    company: { name: "Acme" },
    workplace_type: "REMOTE",
    location: "106967730",
    employment_status: "FULL_TIME",
    seniority_level: "MID_SENIOR_LEVEL",
    description: "x".repeat(200),
    industry: ["4"],
    job_function: ["8"],
    apply_method: { method: "external", website_url: "https://acme.example/jobs/1" },
  }));
  writeFileSync(join(workDir, "brief.pdf"), "%PDF-1.4 fixture\n");
  writeFileSync(join(workDir, "screenshot.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  const secret = "whsec_examples_fixture";
  const payload = JSON.stringify({ id: "wdl_1", event: "message.received", delivered_at: new Date().toISOString() });
  writeFileSync(join(workDir, "payload.json"), payload);
  const t = Math.floor(Date.now() / 1000);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${shimDir}:${process.env["PATH"] ?? ""}`,
    NODE_ENV: "production",
    XDG_CONFIG_HOME: xdgDir,
    CURVIATE_API_KEY: "rdc_live_examples_fixture",
    CURVIATE_BASE_URL: baseUrl,
    CURVIATE_WEBHOOK_SECRET: secret,
    SIGNATURE_HEADER: `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`,
  };
  delete env["CURVIATE_ACCOUNT"];
  const scratch: string[] = [workDir, shimDir, xdgDir];

  return {
    baseUrl,
    run(line, opts) {
      let runEnv = env;
      if (opts?.fresh) {
        const own = mkdtempSync(join(tmpdir(), "curviate-examples-xdg-"));
        cpSync(xdgDir, own, { recursive: true });
        scratch.push(own);
        runEnv = { ...env, XDG_CONFIG_HOME: own };
      }
      return new Promise((resolve) => {
        const child = execFile("bash", ["-c", line], { cwd: workDir, env: runEnv, timeout: 15_000 }, (err, stdout, stderr) => {
          resolve({ code: err ? (typeof err.code === "number" ? err.code : null) : 0, stdout, stderr });
        });
        child.stdin?.end("stdin-fixture\n");
      });
    },
    async stop() {
      await new Promise<void>((r) => server.close(() => r()));
      for (const d of scratch) rmSync(d, { recursive: true, force: true });
    },
  };
}
