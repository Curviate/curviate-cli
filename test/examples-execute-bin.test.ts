/**
 * Every `meta.examples` line is a real invocation: run through bash against
 * the BUILT binary and a local stub standing in for the API, none may be
 * refused as a usage error (exit 2) or crash (exit 1). The docs site prints
 * these lines verbatim, so a renamed flag or a wrong positional count here is
 * a broken docs page.
 *
 * The stub answers every request with one object in both a single-object and
 * a list-envelope shape, so a read may still exit 7 on a body it cannot use:
 * that is the API's answer, not the example's usage, and is allowed.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createHmac } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureFreshBuild, pkgRoot } from "./helpers/built-cli.js";

/** Prompts on a TTY for a masked key: no pty here. */
const INTERACTIVE_ONLY = new Set(["curviate login"]);

const ITEM = { object: "fixture", id: "id_1", account_id: "acc_1", status: "active", name: "Fixture" };
// A terminal status ends each `--wait` poll loop on its first poll: `resolved`
// for a connect session, `active` for a checkpoint.
const BODY = { ...ITEM, status: "resolved", items: [ITEM], cursor: null };

/** One free seat, so `account link` without --seat-id picks it, as for a first-time reader. */
const SEATS = { object: "seat_list", items: [{ seat_id: "seat_free", occupied: false, account_id: null }] };

let server: Server;
let workDir: string;
let shimDir: string;
let xdgDir: string;
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  const cliPath = ensureFreshBuild();
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url?.startsWith("/v1/accounts/seats")) res.end(JSON.stringify(SEATS));
      else res.end(JSON.stringify(req.url?.includes("checkpoint") ? { ...BODY, status: "active" } : BODY));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  workDir = mkdtempSync(join(tmpdir(), "curviate-examples-work-"));
  shimDir = mkdtempSync(join(tmpdir(), "curviate-examples-bin-"));
  xdgDir = mkdtempSync(join(tmpdir(), "curviate-examples-xdg-"));
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

  env = {
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
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const d of [workDir, shimDir, xdgDir]) rmSync(d, { recursive: true, force: true });
});

function run(line: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile("bash", ["-c", line], { cwd: workDir, env, timeout: 15_000 }, (err, _stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : null) : 0, stderr });
    });
    child.stdin?.end("stdin-fixture\n");
  });
}

describe("meta.examples execute", () => {
  it("no example is a usage error or a crash", async () => {
    const { commands } = JSON.parse(readFileSync(join(pkgRoot, "commands.json"), "utf8")) as {
      commands: Array<{ examples: string[] }>;
    };
    const lines = commands.flatMap((c) => c.examples).filter((l) => !INTERACTIVE_ONLY.has(l));
    expect(lines.length).toBeGreaterThan(150);
    const bad: string[] = [];
    for (const line of lines) {
      const r = await run(line);
      // `setup --code -` finishes a key exchange whose response the stub cannot fake.
      const stubShape = r.code === 1 && r.stderr.includes("The API returned an unreadable response");
      if (!stubShape && (r.code === null || r.code === 1 || r.code === 2)) bad.push(`${line}\n  exit ${r.code}: ${r.stderr.trim().split("\n")[0]}`);
    }
    expect(bad).toEqual([]);
  }, 600_000);
});
