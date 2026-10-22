/**
 * Run documented command lines (`meta.examples`, README) in-process, the way a
 * shell would hand them over: quotes, $VAR, ${VAR} and $(cat file) are expanded,
 * `curviate` is dropped, the rest goes to the entry point. Lines with pipes or
 * redirects are shell, not CLI, and are not supported.
 */

import { createHmac } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";
import { pkgRoot } from "./pkg.js";
import { useSink, type Hit } from "./sink.js";

export type ManifestCommand = { path: string[]; usageOnly: boolean; examples: string[]; globals: string[]; requires: string[]; args: Array<{ name: string; type?: string; required?: boolean }> };

export function readManifest(): ManifestCommand[] {
  return (JSON.parse(readFileSync(join(pkgRoot, "commands.json"), "utf8")) as { commands: ManifestCommand[] }).commands;
}

/** Prompts on a TTY for a masked key: no pty here. */
export const INTERACTIVE_ONLY = new Set(["curviate login"]);

/** A `--file -` heredoc example: the command line and the document it pipes. */
export const HEREDOC = /^([^\n]*?) <<'EOF'\n([\s\S]*)\nEOF$/;

/** Append to an example's command line, before its heredoc if it has one. */
export const withArgs = (line: string, extra: string) => {
  const h = HEREDOC.exec(line);
  return h ? `${h[1]} ${extra} <<'EOF'\n${h[2]}\nEOF` : `${line} ${extra}`;
};

export function shellWords(line: string, vars: Record<string, string>, cwd: string): string[] {
  const words: string[] = [];
  let cur: string | null = null;
  const sub = (s: string) =>
    s
      .replace(/\$\(cat ([^)]+)\)/g, (_m, f: string) => readFileSync(join(cwd, f.trim()), "utf8").replace(/\n+$/, ""))
      .replace(/\$\{(\w+)\}|\$(\w+)/g, (_m, a: string, b: string) => vars[a ?? b] ?? "");
  const s = line.replace(/\\\n/g, " ");
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"' || c === "'") {
      const end = s.indexOf(c, i + 1);
      const body = s.slice(i + 1, end);
      cur = (cur ?? "") + (c === '"' ? sub(body) : body);
      i = end;
    } else if (/\s/.test(c)) {
      if (cur !== null) words.push(cur);
      cur = null;
    } else {
      let j = i;
      while (j < s.length && !/\s/.test(s[j]!) && s[j] !== '"' && s[j] !== "'") j++;
      cur = (cur ?? "") + sub(s.slice(i, j));
      i = j - 1;
    }
  }
  if (cur !== null) words.push(cur);
  return words;
}

const ITEM = { object: "fixture", id: "id_1", account_id: "acc_1", status: "active", name: "Fixture" };
// A terminal status ends each `--wait` poll loop on its first poll.
const BODY = { ...ITEM, status: "resolved", items: [ITEM], cursor: null };
const SEATS = { object: "seat_list", items: [{ seat_id: "seat_free", occupied: false, account_id: null }] };

/** The harness the examples run in: a sink answering every request with one object in both shapes, two saved profiles, and the files the examples name. */
export function useExamples() {
  const workDir = mkdtempSync(join(tmpdir(), "curviate-examples-work-"));
  const xdgDir = mkdtempSync(join(tmpdir(), "curviate-examples-xdg-"));
  const seedDir = mkdtempSync(join(tmpdir(), "curviate-examples-seed-"));
  const secret = "whsec_examples_fixture";
  const payload = JSON.stringify({ id: "wdl_1", event: "message.received", delivered_at: new Date().toISOString() });
  const t = Math.floor(Date.now() / 1000);
  const vars: Record<string, string> = {
    CURVIATE_WEBHOOK_SECRET: secret,
    CURVIATE_API_KEY: "rdc_live_examples_fixture",
    SOME_ID: "prof_fixture", PROJECT_ID: "proj_fixture", JOB_ID: "job_fixture", CHANNEL_ID: "chan_fixture", STAGE_ID: "stage_fixture",
    SIGNATURE_HEADER: `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`,
  };
  vars["CURVIATE_SIG_HEADER"] = vars["SIGNATURE_HEADER"]!;
  const sink = useSink((h: Hit) => ({
    body: h.url.startsWith("/v1/accounts/seats") ? SEATS : h.url.includes("checkpoint") ? { ...BODY, status: "active" } : BODY,
  }));
  let cwd = "";
  beforeAll(() => {
    for (const d of [xdgDir, seedDir]) {
      mkdirSync(join(d, "curviate"));
      writeFileSync(join(d, "curviate", "config.json"), JSON.stringify({ active: "default", profiles: { default: {}, work: {} } }), { mode: 0o600 });
    }
    writeFileSync(join(workDir, "description.txt"), "We are hiring a staff engineer to build agent infrastructure. ".repeat(5));
    writeFileSync(join(workDir, "filters.json"), "{}");
    writeFileSync(join(workDir, "motion.json"), JSON.stringify({ name: "Fixture", sequence: { on_reply: "end", steps: [{ id: "invite", do: "invite.send", with: { note: null }, next: "end" }] } }));
    writeFileSync(
      join(workDir, "job.json"),
      JSON.stringify({
        job_title: { id: "9", name: "Staff Engineer" }, company: { name: "Acme" }, workplace_type: "REMOTE", location: "106967730",
        employment_status: "FULL_TIME", seniority_level: "MID_SENIOR_LEVEL", description: "x".repeat(200), industry: ["4"], job_function: ["8"],
        apply_method: { method: "external", website_url: "https://acme.example/jobs/1" },
      }),
    );
    writeFileSync(join(workDir, "brief.pdf"), "%PDF-1.4 fixture\n");
    writeFileSync(join(workDir, "screenshot.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    writeFileSync(join(workDir, "payload.json"), payload);
    writeFileSync(join(workDir, "webhook-payload.json"), payload);
    cwd = process.cwd();
    process.chdir(workDir);
  });
  afterAll(() => process.chdir(cwd));

  return {
    sink,
    vars,
    workDir,
    /** One example line; `fresh`: its own copy of the seeded config, so earlier runs cannot change what it sees. */
    setVar: (k: string, v: string) => void (vars[k] = v),
    async run(line: string, opts: { fresh?: boolean; stdin?: string } = {}) {
      const here = HEREDOC.exec(line);
      if (here) [line, opts] = [here[1]!, { ...opts, stdin: here[2]! + "\n" }];
      const xdg = opts.fresh ? mkdtempSync(join(tmpdir(), "curviate-examples-xdg-")) : xdgDir;
      if (opts.fresh) cpSync(seedDir, xdg, { recursive: true });
      const words = shellWords(line.replace(/<your-api-key>/g, vars["CURVIATE_API_KEY"]!), vars, workDir);
      if (words.shift() !== "curviate") throw new Error(`not a curviate line: ${line}`);
      return sink.run(words, { xdg, stdin: opts.stdin ?? "stdin-fixture\n", env: { CURVIATE_API_KEY: "rdc_live_examples_fixture", CURVIATE_WEBHOOK_SECRET: secret } });
    },
  };
}
