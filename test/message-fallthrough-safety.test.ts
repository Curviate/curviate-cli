/**
 * `message <unknown-subcommand> "<text>"` must never become a send.
 *
 * ## The defect
 *
 * `message` declares subcommands AND a bare positional form
 * (`message <chat_id> "<text>"`). The dispatcher descends into a subcommand
 * when the first token names one, and otherwise runs the bare form. So a first
 * token that is NOT a registered subcommand, `search` being the one found in
 * the wild, silently bound `chatId="search"`, `text="sophie"` and called
 * `runMessageSend`. **Every unknown or mistyped subcommand under `message` was
 * reinterpreted as "send this text to this chat id."** With `search` that 404s;
 * with a real chat id in that position, or a paste that lands one there, it
 * messages a real person.
 *
 * ## Why these tests spawn the bin and record requests
 *
 * Exit code is not the assertion. The whole defect is that a send HAPPENED
 * while the surface looked benign, and a 404 from the far end still leaves an
 * exit code that could be read as "it refused." So every case below points the
 * CLI at a local HTTP server via `--base-url` and asserts on **what arrived**:
 * zero requests for a rejected form, exactly one for a legitimate send. A test
 * that only checked the exit code would have passed against the broken build.
 *
 * Build prerequisite: `pnpm build` must have produced a current dist/cli.js.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile, execSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");
const cliPath = resolve(pkgRoot, "dist", "cli.js");

interface Recorded {
  method: string;
  url: string;
  body: string;
}

let server: Server;
let baseUrl: string;
let recorded: Recorded[] = [];

beforeAll(async () => {
  if (!existsSync(cliPath)) {
    execSync("pnpm build", { cwd: pkgRoot, stdio: "ignore" });
  }

  server = createServer((req, res) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      data += c;
    });
    req.on("end", () => {
      recorded.push({ method: req.method ?? "", url: req.url ?? "", body: data });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_stub", chat_id: "2-stub" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  requests: Recorded[];
}

/**
 * Spawn the built bin ASYNCHRONOUSLY. `spawnSync` would deadlock here: the
 * recording server runs in this same process, and a synchronous spawn blocks
 * the event loop, so the child's request could never be answered.
 *
 * The child's stdin is closed immediately; several of these forms reach the
 * text-or-stdin resolver, which otherwise blocks on an open pipe forever.
 */
function run(args: string[]): Promise<RunResult> {
  recorded = [];
  return new Promise((resolvePromise) => {
    const child = execFile(
      process.execPath,
      [cliPath, ...args, "--base-url", baseUrl],
      {
        encoding: "utf8",
        timeout: 15_000,
        env: {
          ...process.env,
          NODE_ENV: "production",
          CURVIATE_API_KEY: "rdc_live_fallthrough_test_stub",
        },
      },
      (_err, stdout, stderr) => {
        resolvePromise({
          status: child.exitCode,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          requests: [...recorded],
        });
      },
    );
    child.stdin?.end();
  });
}

// A real chat id, of the shape `inbox list` / `inboxes chats` return.
const REAL_CHAT_ID = "2-NmMyYzhlZWEtYjA5OS00OWQ0LWFhZjItYjBiYzUwZjcxYzM3XzEwMA==";

describe("message: an unknown subcommand must not send", () => {
  // The token found in the wild, plus the general shape it represents: typos,
  // plausible-but-absent verbs, and near-misses of real subcommands.
  const unknownTokens = [
    "search", // documented as a read in four places; the real command is `inbox search`
    "list",
    "find",
    "history",
    "read",
    "sned", // typo of `send`
    "inmail-balence", // typo of `inmail-balance`
    "reply",
  ];

  for (const token of unknownTokens) {
    it(`\`message ${token} "<text>"\` issues NO request and exits non-zero`, async () => {
      const r = await run(["message", token, "hello there", "--account", "acc_x"]);

      // The assertion that matters: nothing left the machine.
      expect(r.requests).toEqual([]);
      expect(r.status).not.toBe(0);
      // Usage, not a stack trace or a silent success.
      expect(r.stderr).toMatch(/message/i);
    });
  }

  it("names the real subcommands so the user can recover", async () => {
    const r = await run(["message", "search", "sophie", "--account", "acc_x"]);
    expect(r.requests).toEqual([]);
    expect(r.stderr).toContain("send");
    expect(r.stderr).toContain("inmail");
  });

  it("a single unknown token with no text still issues NO request", async () => {
    const r = await run(["message", "search", "--account", "acc_x"]);
    expect(r.requests).toEqual([]);
    expect(r.status).not.toBe(0);
  });

  it("does not send even when --preview is absent and the text looks like a real message", async () => {
    const r = await run([
      "message",
      "list",
      "Hi Sophie, following up on our conversation.",
      "--account",
      "acc_x",
    ]);
    expect(r.requests).toEqual([]);
    expect(r.status).not.toBe(0);
  });
});

describe("message: the legitimate bare form still sends", () => {
  it("`message <chat_id> \"<text>\"` issues exactly one send", async () => {
    const r = await run(["message", REAL_CHAT_ID, "hello there", "--account", "acc_x"]);

    expect(r.status).toBe(0);
    expect(r.requests).toHaveLength(1);
    expect(r.requests[0]!.method).toBe("POST");
    expect(r.requests[0]!.url).toContain(REAL_CHAT_ID);
    expect(JSON.parse(r.requests[0]!.body)).toMatchObject({ text: "hello there" });
  });

  it("a COMPANY_ chat id still sends", async () => {
    const r = await run(["message", "COMPANY_83734124_PRIMARY", "hi", "--account", "acc_x"]);
    expect(r.status).toBe(0);
    expect(r.requests).toHaveLength(1);
    expect(r.requests[0]!.method).toBe("POST");
  });

  it("a messaging thread URL still sends", async () => {
    const r = await run([
      "message",
      `https://www.linkedin.com/messaging/thread/${REAL_CHAT_ID}/`,
      "hi",
      "--account",
      "acc_x",
    ]);
    expect(r.status).toBe(0);
    expect(r.requests).toHaveLength(1);
    expect(r.requests[0]!.url).toContain(REAL_CHAT_ID);
  });

  it("the explicit `message send <chat_id> \"<text>\"` form is unaffected", async () => {
    const r = await run(["message", "send", REAL_CHAT_ID, "hi", "--account", "acc_x"]);
    expect(r.status).toBe(0);
    expect(r.requests).toHaveLength(1);
    expect(r.requests[0]!.method).toBe("POST");
  });

  it("`message send` is the escape hatch for any chat id the guard does not recognise", async () => {
    // The guard only ever gates the BARE form, so an unfamiliar chat-id shape
    // can always be sent explicitly. This is what keeps the guard from being
    // able to permanently block a legitimate send.
    const r = await run(["message", "send", "an-unusual-chat-id", "hi", "--account", "acc_x"]);
    expect(r.status).toBe(0);
    expect(r.requests).toHaveLength(1);
  });
});

describe("connect: a mistyped subcommand must not send an invitation", () => {
  // `connect` is the other write-bearing bare form: `connect <slug>` SENDS a
  // connection invitation. A slug is a lowercase word, indistinguishable in
  // shape from a mistyped subcommand, so the guard here is a near-miss test
  // rather than a shape test.
  const typos = [
    ["snet", "sent"],
    ["sen", "sent"],
    ["recieved", "received"],
    ["acept", "accept"],
    ["accpet", "accept"],
    ["cancle", "cancel"],
    ["declien", "decline"],
  ];

  for (const [typo, intended] of typos) {
    it(`\`connect ${typo}\` issues NO request and points at \`${intended}\``, async () => {
      const r = await run(["connect", typo!, "--account", "acc_x"]);
      expect(r.requests).toEqual([]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(intended!);
    });
  }

  it("a real slug still sends an invitation", async () => {
    const r = await run(["connect", "raphael-redmer-123", "--account", "acc_x"]);
    expect(r.status).toBe(0);
    expect(r.requests).toHaveLength(1);
    expect(r.requests[0]!.method).toBe("POST");
  });

  it("a provider id still sends an invitation", async () => {
    const r = await run(["connect", "ACoAAABcDeFgHiJkLm", "--account", "acc_x"]);
    expect(r.status).toBe(0);
    expect(r.requests).toHaveLength(1);
  });

  it("a full profile URL is the escape hatch for a slug the guard flags", async () => {
    const r = await run([
      "connect",
      "https://www.linkedin.com/in/cancle/",
      "--account",
      "acc_x",
    ]);
    expect(r.status).toBe(0);
    expect(r.requests).toHaveLength(1);
  });
});
