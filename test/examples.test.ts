/**
 * Documented command lines are real invocations: `meta.examples` (the docs site
 * prints them verbatim) and the README's. Run in-process against a sink that
 * answers every request with one object, so a usage error (exit 2) or a crash
 * (exit 1) means the documentation is wrong, not the API.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INTERACTIVE_ONLY, readManifest, useExamples, withArgs } from "./helpers/examples.js";
import { pkgRoot } from "./helpers/pkg.js";
import { runCli } from "./helpers/run-inproc.js";

const ex = useExamples();
const manifest = readManifest();
const runnable = manifest.filter((c) => !c.usageOnly && c.examples[0] && !INTERACTIVE_ONLY.has(c.examples[0]));
const BAD_STUB = "The API returned an unreadable response"; // a read the stub's shape cannot satisfy: the API's answer, not a usage error
const SLOW = 300_000;
/** The checkpoint flow reads its next step from the body: an unreadable one stays exit 7, saying the request may have been applied (sweeps.test.ts). */
/** The SDK method returns nothing (a documented 204), so any body prints as {}. */
const VOID_RESULT = new Set(["core draft delete"]);
const CHECKPOINT_FLOW = new Set(["account checkpoint solve", "account checkpoint poll", "account checkpoint request", "account connect-session poll"]);

describe("meta.examples", () => {
  it("no example is a usage error or a crash", { timeout: SLOW }, async () => {
    const lines = manifest.flatMap((c) => c.examples).filter((l) => !INTERACTIVE_ONLY.has(l));
    expect(lines.length).toBeGreaterThan(150);
    const bad: string[] = [];
    for (const line of lines) {
      const r = await ex.run(line);
      if (!(r.status === 1 && r.stderr.includes(BAD_STUB)) && (r.status === 1 || r.status === 2)) bad.push(`${line}\n  exit ${r.status}: ${r.stderr.trim().split("\n")[0]}`);
    }
    expect(bad).toEqual([]);
  });

  it("each global flag a command lists is accepted (not a usage error) on one of its examples", { timeout: SLOW }, async () => {
    const value: Record<string, string> = {
      "api-key": "rdc_live_examples_fixture", profile: "default", account: "acc_1", "base-url": ex.sink.url, timeout: "5000", fields: "id",
      limit: "5", cursor: "c1", "max-pages": "1 --all", "page-delay": "0 --all", preview: "--account acc_1",
    };
    const refused: string[] = [];
    for (const c of runnable) {
      for (const flag of c.globals) {
        let last = "";
        let ok = false;
        for (const line of c.examples.filter((l) => !INTERACTIVE_ONLY.has(l))) {
          const r = await ex.run(withArgs(line, `--${flag}${value[flag] !== undefined ? ` ${value[flag]}` : ""}`), { fresh: true });
          if (r.status !== 2) {
            ok = true;
            break;
          }
          last = r.stderr.trim().split("\n")[0]!;
        }
        if (!ok) refused.push(`${c.path.join(" ")} --${flag}: ${last}`);
      }
    }
    expect(refused).toEqual([]);
  });

  it("dropping a flag from an example is refused as required exactly when the flag is declared required", { timeout: SLOW }, async () => {
    const drop = (line: string, name: string, boolean: boolean) =>
      line.replace(new RegExp(`\\s--${name}(=\\S+|${boolean ? "" : `(\\s+("[^"]*"|'[^']*'|\\S+))`})${boolean ? "?" : ""}(?=\\s|$)`), "");
    const mismatches: string[] = [];
    let probed = 0;
    for (const c of runnable) {
      const line = c.examples[0]!;
      for (const a of c.args.filter((x) => x.type !== "positional")) {
        if (!new RegExp(`\\s--${a.name}(\\s|=|$)`).test(line)) continue;
        const without = drop(line, a.name, a.type === "boolean");
        expect(without, `could not drop --${a.name} from: ${line}`).not.toBe(line);
        probed++;
        const r = await ex.run(without, { fresh: true });
        const first = r.stderr.trim().split("\n")[0] ?? "";
        const enforced = r.status === 2 && first.includes(`--${a.name}`) && /required/i.test(first) && !/\bor\b|required when|required with|required for a/i.test(first);
        if (enforced !== (a.required === true)) mismatches.push(`${c.path.join(" ")} --${a.name}: declared required=${a.required === true}, runtime ${enforced ? "refuses" : "accepts"} its absence`);
      }
    }
    expect(probed).toBeGreaterThan(40);
    expect(mismatches).toEqual([]);
  });
});

describe("--help prints a command's examples and requirements", () => {
  const helpOf = (path: string) => runCli([...path.split(" "), "--help"]);
  const examplesOf = (path: string) => manifest.find((c) => c.path.join(" ") === path)!.examples;

  it.each(["core post get", "core recruiter job create", "core connect", "doctor"])("%s", async (path) => {
    const expected = examplesOf(path);
    expect(expected.length).toBeGreaterThan(0);
    const r = await helpOf(path);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`EXAMPLES\n\n${expected.map((e) => `  ${e}`).join("\n")}\n`);
  });

  it("a subcommand-only group prints no EXAMPLES block; REQUIRES comes before EXAMPLES", async () => {
    expect(examplesOf("account")).toEqual([]);
    expect((await helpOf("account list")).stdout).toContain("EXAMPLES");
    expect((await helpOf("account")).stdout).not.toContain("EXAMPLES");
    const requires = manifest.find((c) => c.path.join(" ") === "core job create")!.requires;
    expect(requires.length).toBeGreaterThan(0);
    expect((await helpOf("core job create")).stdout).toContain(`REQUIRES\n\n${requires.map((l) => `  ${l}`).join("\n")}\n\nEXAMPLES`);
  });
});

describe("--preview on a command that does not declare it", () => {
  it("is refused with exit 2 on every such command (write-only message on API reads)", async () => {
    const without = runnable.filter((c) => !c.globals.includes("preview"));
    expect(runnable.some((c) => c.path.join(" ") === "core post create" && c.globals.includes("preview"))).toBe(true);
    expect(without.map((c) => c.path.join(" "))).toEqual(expect.arrayContaining(["core post get", "account list", "core feed home"]));
    const wrong: string[] = [];
    for (const c of without) {
      const r = await ex.run(withArgs(c.examples[0]!, "--preview"), { fresh: true });
      const message = c.globals.includes("beta") ? "--preview is only valid on write commands" : "unknown flag `--preview`";
      if (r.status !== 2 || !r.stderr.includes(message)) wrong.push(`${c.path.join(" ")}: exit ${r.status}, ${r.stderr.trim().split("\n")[0]}`);
    }
    expect(wrong).toEqual([]);
  }, SLOW);

  it.each([["--preview", 2], ["--preview=false", 0], ["--no-preview", 0]])("a read with %s exits %i: an explicit false is a no-op", async (flag, code) => {
    const r = await ex.run(`curviate account list ${flag}`, { fresh: true });
    expect(r.status, r.stderr).toBe(code);
  });

  it.each(["false", "FALSE", "0", "no", "true", "TRUE", "1", "yes"])("--preview=%s: the read and the write agree", async (v) => {
    const write = await ex.run(`curviate core post delete 7290000000000000000 --account acc_1 --json --preview=${v}`, { fresh: true });
    const read = await ex.run(`curviate account list --preview=${v}`, { fresh: true });
    const previewed = write.stdout.includes('"method":"posts.delete"');
    expect(write.status, write.stderr).toBe(0);
    expect(read.status === 2 && read.stderr.includes("--preview is only valid on write commands")).toBe(previewed);
  });

  it("a write still takes --no-preview and sends", async () => {
    const r = await ex.run("curviate core post delete 7290000000000000000 --no-preview", { fresh: true });
    expect(r.status, r.stderr).toBe(0);
  });
});

describe("README.md", () => {
  // Pipes, jq and xargs are shell; the `curviate ...` segment of each line is the CLI's.
  const readme = readFileSync(join(pkgRoot, "README.md"), "utf8");
  for (const m of readme.matchAll(/^(\w+)="([^"]*)"$/gm)) ex.setVar(m[1]!, m[2]!);
  const commands = [...readme.matchAll(/```bash\n([\s\S]*?)```/g)]
    .flatMap((m) => m[1]!.replace(/\\\n/g, " ").split("\n"))
    .flatMap((l) => l.replace(/\s+#\s.*$/, "").split("|"))
    .map((s) => s.trim().replace(/^xargs -I\{\} /, "").replace(/^(\|\| )?\{$/, "").replace(/\{\}/g, "1"))
    .filter((s) => /^curviate\s/.test(s) && s !== "curviate login");

  it("every documented curviate command is accepted (not a usage error or crash)", { timeout: SLOW }, async () => {
    expect(commands.length).toBeGreaterThanOrEqual(30);
    const bad: string[] = [];
    for (const line of commands) {
      const r = await ex.run(line, { fresh: true, stdin: readFileSync(join(ex.workDir, "webhook-payload.json"), "utf8") });
      if (!(r.status === 1 && r.stderr.includes(BAD_STUB)) && (r.status === 1 || r.status === 2)) bad.push(`${line}\n  exit ${r.status}: ${r.stderr.trim().split("\n")[0]}`);
    }
    expect(bad).toEqual([]);
  });
});

describe("a write the API accepted exits 0 whatever its body", () => {
  it("every write example (declares --preview) answered 2xx empty, unexpected or non-JSON: exit 0, the JSON body or {} on stdout, a warning on stderr; a read given the non-JSON body still exits 7", { timeout: SLOW }, async () => {
    const OK = ex.sink.reply;
    const bodies: Array<[{ status: number; type: string; body: string }, string]> = [
      [{ status: 200, type: "application/json", body: "" }, "{}"],
      [{ status: 201, type: "application/json", body: '{"unexpected": true}' }, '{"unexpected":true}'],
      [{ status: 200, type: "text/html", body: "<html>ok</html>" }, "{}"],
      [{ status: 200, type: "application/json", body: "null" }, "null"],
      [{ status: 200, type: "application/json", body: "42" }, "42"],
    ];
    const bad: string[] = [];
    let swept = 0;
    try {
      for (const c of runnable.filter((x) => x.globals.includes("preview") && !CHECKPOINT_FLOW.has(x.path.join(" ")))) {
        for (const lineOf of c.examples.filter((l) => !/--preview\b/.test(l))) {
          ex.sink.reply = OK;
          if (!(await ex.run(lineOf, { fresh: true })).requests.some((q) => q.method !== "GET")) continue;
          swept++;
          for (const [reply, printed] of bodies) {
            ex.sink.reply = (h) => (h.method === "GET" ? (typeof OK === "function" ? OK(h) : OK) : reply);
            const r = await ex.run(lineOf, { fresh: true });
            const out = r.stdout.trim().split("\n").pop() ?? "";
            const expected = VOID_RESULT.has(c.path.join(" ")) ? "{}" : printed;
            if (r.status !== 0 || out !== expected || !r.stderr.includes("The write happened: do not retry it.")) bad.push(`${lineOf.split("\n")[0]} ${reply.body}: exit ${r.status} ${out.slice(0, 50)} ${r.stderr.trim().split("\n")[0]}`);
          }
          break;
        }
      }
      expect(swept, "the sweep reaches the writes").toBeGreaterThan(50);
      expect(bad).toEqual([]);
      ex.sink.reply = { status: 200, type: "text/html", body: "<html>ok</html>" };
      expect((await ex.run("curviate core company 1035 --account acc_1", { fresh: true })).status).toBe(7);
    } finally {
      ex.sink.reply = OK;
    }
  });
});
