/**
 * A caller-supplied value is judged by what the SDK does with it, not by its
 * argument position.
 *
 * ## What this suite replaces
 *
 * It replaces `path-segment-injection.test.ts`, which asserted that every
 * leading string argument of every SDK call was refused unless it could be a
 * path segment. That contract is deliberately abandoned: the premise it rested
 * on ("path parameters are the leading strings") is false in both directions,
 * so the guard both missed real path parameters that arrive inside an object
 * (`salesNavigator.saveLead({ list_id, ... })`) and refused values that are
 * body fields and never enter a path at all. Keeping those assertions green
 * would encode a rule we know to be wrong. See `src/lib/client.ts` for the full
 * reasoning, and the SDK for where path encoding actually lives.
 *
 * ## What it asserts instead
 *
 * The property the CLI owns: a value the caller typed arrives at the API as the
 * thing they meant, and the CLI does not invent a reason to refuse it.
 *
 *   - a body-carried value reaches the wire IN THE BODY, with the path untouched
 *   - a path-carried value reaches the wire as EXACTLY ONE path segment
 *   - `--preview` and the real run agree on whether an input is acceptable
 *
 * ## Two deliberate choices about the assertions
 *
 * Assertions are on the recorded request (method, url, body), never on stdout.
 * stdout cannot tell "refused before the request was built" from "sent, and the
 * far end refused it", and that difference is the whole point.
 *
 * Path assertions compare DECODED segments rather than raw URL text. Whether a
 * given SDK release sends an id verbatim or percent-encoded is its business;
 * what must hold across both is that the caller's value survives as one
 * segment. Asserting on raw text would pin this suite to one SDK release and
 * turn a routine dependency bump into a red suite.
 *
 * Every value used below contains a character the removed guard rejected, so
 * re-introducing that guard turns this file red rather than leaving it
 * vacuously green.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureFreshBuild } from "./helpers/built-cli.js";

interface Recorded {
  method: string;
  url: string;
  body: string;
}

let cliPath: string;
let server: Server;
let baseUrl: string;
let recorded: Recorded[] = [];

beforeAll(async () => {
  cliPath = ensureFreshBuild();
  server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (body += c));
    req.on("end", () => {
      const url = req.url ?? "";
      recorded.push({ method: req.method ?? "", url, body });

      // A URL where an id belongs is a resource the API does not have, so it
      // answers 404 rather than a usage error. Keyed on the decoded path so it
      // fires whether the value arrived raw or percent-encoded.
      if (/https?:\/\//.test(safeDecode(url))) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            code: "RESOURCE_NOT_FOUND",
            message: "The requested resource does not exist.",
            user_fixable: true,
          }),
        );
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "probe", items: [], cursor: null, id: "probe_1" }));
    });
  });
  // Almost every case here actually opens a socket (that is the point), and the
  // SDK's agent keeps them alive. `server.close()` only stops new connections
  // and then WAITS for the live ones, so without this the file's teardown sits
  // on an idle keep-alive socket whose owning child process has already exited,
  // and vitest's task-update RPC times out while it waits.
  server.keepAliveTimeout = 1;
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  requests: Recorded[];
}

/**
 * The account is a well-formed id supplied through the environment, so the
 * account resolver can never be the thing that accepts or refuses a run here.
 * XDG_CONFIG_HOME points at an empty temp dir so the developer's real config
 * cannot supply a base URL or an account behind the test's back.
 */
function run(args: string[]): Promise<RunResult> {
  recorded = [];
  const xdg = mkdtempSync(join(tmpdir(), "curviate-path-arg-"));
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        XDG_CONFIG_HOME: xdg,
        NODE_ENV: "production",
        CURVIATE_API_KEY: "cvt_test_path_argument_stub",
        CURVIATE_BASE_URL: baseUrl,
        CURVIATE_ACCOUNT: "acc_01PROBE",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("close", (status) => resolvePromise({ status, stdout, stderr, requests: [...recorded] }));
    child.stdin.end();
  });
}

/** Percent-decode, tolerating a value that is not valid percent-encoding. */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The recorded request's path segments, each percent-decoded. */
function decodedSegments(url: string): string[] {
  const path = url.split(/[?#]/)[0] ?? "";
  return path
    .split("/")
    .filter((s) => s !== "")
    .map(safeDecode);
}

function parseBody(raw: string): Record<string, unknown> {
  return JSON.parse(raw) as Record<string, unknown>;
}

/**
 * A real share URL as the API renders it in `post saved` / `post get`, so this
 * is a value an agent plausibly pipes straight back in. It carries slashes and
 * a colon.
 */
const SHARE_URL = "https://www.linkedin.com/feed/update/urn:li:activity:7391234567890/";

/**
 * A notification card urn carrying a slash. LinkedIn's uniqueSuffix is base64
 * of arbitrary bytes, so `/` and `+` occur in real values; the API returns
 * these raw and `notification delete` takes them straight back.
 */
const CARD_URN_WITH_SLASH =
  "urn:li:fsd_notificationCard:(SHARED_BY_YOUR_NETWORK,urn:li:uniqueSuffix:(urn:li:none,rwp/FSX4QQ+XFV6bDYxCsw))";

/**
 * A provisional account id as pasted back from a 202 checkpoint response, with
 * a stray trailing path fragment. Nothing about its shape matters except that
 * the removed guard refused it: these three calls POST to a fixed URL, so no
 * value of this argument can move the request anywhere.
 */
const CHECKPOINT_ID = "acc_01PROVISIONAL/x";

describe("a body-carried leading string reaches the wire, in the body", () => {
  /**
   * All four take a leading string that the SDK puts in the request BODY. The
   * removed guard read the leading position as proof of path-hood and refused
   * them, with a diagnostic that claimed the value "would redirect the request
   * to a different endpoint" for a value that never enters a path.
   *
   * `path` is the fixed URL each one posts to. Asserting it stays fixed is what
   * makes the case airtight: the argument demonstrably cannot redirect
   * anything, so refusing it could never have been about safety.
   */
  const cases: Array<{
    label: string;
    argv: string[];
    path: string;
    value: string;
    field: string;
  }> = [
    {
      label: "auth.solveCheckpoint",
      argv: ["account", "checkpoint", "solve", CHECKPOINT_ID, "--code", "123456"],
      path: "/v1/auth/checkpoint/solve",
      value: CHECKPOINT_ID,
      field: "account_id",
    },
    {
      label: "auth.requestCheckpoint",
      argv: ["account", "checkpoint", "request", CHECKPOINT_ID],
      path: "/v1/auth/checkpoint/request",
      value: CHECKPOINT_ID,
      field: "account_id",
    },
    {
      label: "auth.pollCheckpoint",
      argv: ["account", "checkpoint", "poll", CHECKPOINT_ID],
      path: "/v1/auth/checkpoint/poll",
      value: CHECKPOINT_ID,
      field: "account_id",
    },
    {
      label: "posts.save",
      argv: ["post", "save", SHARE_URL],
      path: "/v1/acc_01PROBE/saved-posts",
      value: SHARE_URL,
      field: "post_id",
    },
  ];

  for (const { label, argv, path, value, field } of cases) {
    it(`${label} sends the value as ${field}, and the path is unaffected by it`, async () => {
      const r = await run(argv);

      expect(r.requests, `stderr: ${r.stderr.slice(0, 300)}`).toHaveLength(1);
      const sent = r.requests[0]!;
      expect(sent.method).toBe("POST");
      // The URL is fixed. Not "does not contain the value" — literally the
      // path this call always uses, whatever the caller typed.
      expect(sent.url).toBe(path);
      expect(parseBody(sent.body)[field]).toBe(value);
      expect(r.status).toBe(0);
    });
  }
});

describe("a path-carried value reaches the wire as exactly one segment", () => {
  it("notification delete keeps a card urn containing a slash intact", async () => {
    const r = await run(["notification", "delete", CARD_URN_WITH_SLASH]);

    expect(r.requests, `stderr: ${r.stderr.slice(0, 300)}`).toHaveLength(1);
    const sent = r.requests[0]!;
    expect(sent.method).toBe("DELETE");
    // Three segments, not five: the two slashes inside the urn did not become
    // separators. The last one decodes back to exactly what was typed.
    expect(decodedSegments(sent.url)).toEqual([
      "v1",
      "acc_01PROBE",
      "notifications",
      CARD_URN_WITH_SLASH,
    ]);
    expect(r.status).toBe(0);
  });

  it("notification show-less keeps it intact too, with its own suffix", async () => {
    const r = await run(["notification", "show-less", CARD_URN_WITH_SLASH]);

    expect(r.requests, `stderr: ${r.stderr.slice(0, 300)}`).toHaveLength(1);
    const sent = r.requests[0]!;
    expect(sent.method).toBe("POST");
    expect(decodedSegments(sent.url)).toEqual([
      "v1",
      "acc_01PROBE",
      "notifications",
      CARD_URN_WITH_SLASH,
      "show-less",
    ]);
    expect(r.status).toBe(0);
  });
});

describe("the shapes a real identifier takes still reach the wire", () => {
  /**
   * Carried over from the suite this file replaces: the acceptance half was
   * always the right thing to assert, and these are the id shapes this API
   * actually mints. Asserted on decoded segments so an SDK that percent-encodes
   * and one that does not both satisfy them.
   */
  const accepted: Array<[string, string[], string[]]> = [
    [
      "a base64 chat id with = padding",
      ["inbox", "get", "2-NmMyYzhlZWEtYjA5OS00OWQ0XzEwMA=="],
      ["v1", "acc_01PROBE", "chats", "2-NmMyYzhlZWEtYjA5OS00OWQ0XzEwMA=="],
    ],
    [
      "a URN with colons",
      ["post", "get", "urn:li:activity:7100000000000000000"],
      ["v1", "acc_01PROBE", "posts", "urn:li:activity:7100000000000000000"],
    ],
    ["a public slug", ["profile", "raphael-redmer"], ["v1", "acc_01PROBE", "users", "raphael-redmer"]],
    ["a bare numeric id", ["company", "1035"], ["v1", "acc_01PROBE", "companies", "1035"]],
    [
      "a COMPANY_ chat id",
      ["inbox", "get", "COMPANY_83734124_PRIMARY"],
      ["v1", "acc_01PROBE", "chats", "COMPANY_83734124_PRIMARY"],
    ],
  ];

  for (const [label, argv, expectedSegments] of accepted) {
    it(`${label} still reaches the wire`, async () => {
      const r = await run(argv);
      expect(r.status, `stderr: ${r.stderr.slice(0, 200)}`).toBe(0);
      expect(r.requests.map((q) => decodedSegments(q.url))).toContainEqual(expectedSegments);
    });
  }

  it("a member URL still normalises to its slug", async () => {
    const r = await run(["profile", "https://www.linkedin.com/in/raphael-redmer"]);
    expect(r.status).toBe(0);
    expect(r.requests.map((q) => decodedSegments(q.url))).toContainEqual([
      "v1",
      "acc_01PROBE",
      "users",
      "raphael-redmer",
    ]);
  });

  it("a group URL still normalises to its numeric id", async () => {
    const r = await run(["group", "get", "https://www.linkedin.com/groups/9123014/"]);
    expect(r.status).toBe(0);
    expect(r.requests.map((q) => decodedSegments(q.url))).toContainEqual([
      "v1",
      "acc_01PROBE",
      "groups",
      "9123014",
    ]);
  });
});

/**
 * The exit-code contract is a wire contract, so it has to be the API that
 * decides it.
 *
 * A caller passing a URL where an id belongs gets 404 -> exit 4 and the error
 * envelope on stdout, which is what a consumer script branches on. The previous
 * revision pre-empted that with a local usage error: exit 2, nothing on stdout,
 * plain text on stderr. A script matching on 4 fell through, and one parsing
 * stdout got an empty string.
 *
 * Asserted on the code and the channel rather than the message, because the
 * message is the API's to word.
 */
describe("the API decides the exit code, not a local guess about the value", () => {
  const notFoundCases: Array<[string, string[]]> = [
    ["post get <share URL>", ["post", "get", SHARE_URL]],
    ["profile <a URL that is not a member URL>", ["profile", "https://example.com/some/path"]],
  ];

  for (const [label, argv] of notFoundCases) {
    it(`${label} exits 4 with the error envelope on stdout`, async () => {
      const r = await run([...argv, "--json"]);

      // It reached the API at all: a local refusal would have sent nothing.
      expect(r.requests.length, `stderr: ${r.stderr.slice(0, 300)}`).toBeGreaterThan(0);
      expect(r.status).toBe(4);

      const envelope = JSON.parse(r.stdout.trim()) as { error?: { code?: string } };
      expect(envelope.error?.code).toBe("RESOURCE_NOT_FOUND");
      // Not a usage error dressed up as one.
      expect(r.stderr).not.toContain("INVALID_PATH_SEGMENT");
    });
  }
});

/**
 * `--preview` is published as "Render the request that would be sent without
 * calling the API". A preview that accepts an input the real run refuses is
 * worse than no preview: an agent uses it to decide whether to commit, so a
 * disagreement is a wrong answer at exactly the moment it is being trusted.
 * The previous revision had that disagreement, because the guard sat at the SDK
 * call and a preview never reaches one.
 *
 * Acceptance is compared, not output: the two are meant to differ in what they
 * print and in whether anything is sent.
 */
describe("--preview and the real run agree on whether an input is acceptable", () => {
  const acceptedBy = async (argv: string[]): Promise<boolean> => (await run(argv)).status === 0;

  it("agree on a positional the previous revision disagreed about", async () => {
    // The exact input that split them: preview rendered it, the real run exited
    // 2 with INVALID_PATH_SEGMENT.
    const real = await run(["post", "save", SHARE_URL]);
    const preview = await run(["post", "save", SHARE_URL, "--preview"]);

    expect(real.status).toBe(0);
    expect(preview.status).toBe(0);
    // ... and for the right reasons on each side.
    expect(real.requests).toHaveLength(1);
    expect(preview.requests, "--preview must not call the API").toEqual([]);
  });

  it("agree on a card urn carrying a slash", async () => {
    expect(await acceptedBy(["notification", "delete", CARD_URN_WITH_SLASH])).toBe(true);
    expect(await acceptedBy(["notification", "delete", CARD_URN_WITH_SLASH, "--preview"])).toBe(true);
  });

  it("agree in the refusing direction on a redirecting --account", async () => {
    // The account guard is deliberately in front of the preview branch, so both
    // sides refuse. A preview that rendered this would be telling the caller a
    // run will happen that cannot.
    const argv = ["post", "save", "urn:li:activity:7100000000000000000", "--account", "x/../../../v1/accounts"];
    const real = await run(argv);
    const preview = await run([...argv, "--preview"]);

    expect(real.status).toBe(2);
    expect(preview.status).toBe(2);
    expect(real.requests).toEqual([]);
    expect(preview.requests).toEqual([]);
    expect(preview.stderr).toContain("INVALID_PATH_SEGMENT");
  });

  it("agree in the accepting direction on an id-shaped --account", async () => {
    const argv = ["post", "save", "urn:li:activity:7100000000000000000", "--account", "acc_01SOPH"];
    const real = await run(argv);
    const preview = await run([...argv, "--preview"]);

    expect(real.status).toBe(0);
    expect(preview.status).toBe(0);
    expect(real.requests).toHaveLength(1);
    expect(preview.requests).toEqual([]);
  });
});
