/**
 * A caller-supplied value is judged by what the SDK does with it, not by its
 * argument position: a body-carried string goes in the body, a path-carried
 * value is exactly one path segment, a real identifier shape (base64 padding,
 * URN, slug, URL) reaches the wire, and the API, not a local guess, decides the
 * exit code. --preview and the real run agree on what is acceptable.
 */
import { describe, it, expect } from "vitest";
import { useSink, type Hit } from "./helpers/sink.js";

const sink = useSink((h: Hit) =>
  /https?:\/\//.test(safeDecode(h.url))
    ? { status: 404, body: { code: "RESOURCE_NOT_FOUND", message: "The requested resource does not exist.", user_fixable: true } }
    : { body: { object: "probe", items: [], cursor: null, id: "probe_1" } },
);
const env = { CURVIATE_API_KEY: "cvt_test_path_argument_stub", CURVIATE_ACCOUNT: "acc_01PROBE" };
const run = (args: string[]) => sink.run(args, { env });

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
const segments = (url: string) => (url.split(/[?#]/)[0] ?? "").split("/").filter(Boolean).map(safeDecode);

const SHARE_URL = "https://www.linkedin.com/feed/update/urn:li:activity:7391234567890/";
const CARD = "urn:li:fsd_notificationCard:(SHARED_BY_YOUR_NETWORK,urn:li:uniqueSuffix:(urn:li:none,rwp/FSX4QQ+XFV6bDYxCsw))";
const CHECKPOINT_ID = "acc_01PROVISIONAL/x";

describe("a body-carried leading string reaches the wire in the body, and the path is unaffected", () => {
  it.each([
    ["auth.solveCheckpoint", ["account", "checkpoint", "solve", CHECKPOINT_ID, "--code", "123456"], "/v1/auth/checkpoint/solve", CHECKPOINT_ID, "account_id"],
    ["auth.requestCheckpoint", ["account", "checkpoint", "request", CHECKPOINT_ID], "/v1/auth/checkpoint/request", CHECKPOINT_ID, "account_id"],
    ["auth.pollCheckpoint", ["account", "checkpoint", "poll", CHECKPOINT_ID], "/v1/auth/checkpoint/poll", CHECKPOINT_ID, "account_id"],
    ["posts.save", ["post", "save", SHARE_URL], "/v1/acc_01PROBE/saved-posts", SHARE_URL, "post_id"],
  ])("%s sends the value as %s", async (_l, argv, path, value, field) => {
    const r = await run(argv);
    expect(r.requests, r.stderr).toHaveLength(1);
    expect([r.status, r.requests[0]!.method, r.requests[0]!.url]).toEqual([0, "POST", path]);
    expect((JSON.parse(r.requests[0]!.body) as Record<string, unknown>)[field]).toBe(value);
  });
});

describe("a path-carried value is exactly one segment", () => {
  it.each([
    ["notification delete", "DELETE", ["v1", "acc_01PROBE", "notifications", CARD]],
    ["notification show-less", "POST", ["v1", "acc_01PROBE", "notifications", CARD, "show-less"]],
  ])("%s keeps a card urn containing a slash intact", async (cmd, method, expected) => {
    const r = await run(cmd.split(" ").concat(CARD));
    expect(r.requests, r.stderr).toHaveLength(1);
    expect([r.status, r.requests[0]!.method, segments(r.requests[0]!.url)]).toEqual([0, method, expected]);
  });

  it.each([
    ["a base64 chat id with = padding", ["inbox", "get", "2-NmMyYzhlZWEtYjA5OS00OWQ0XzEwMA=="], ["chats", "2-NmMyYzhlZWEtYjA5OS00OWQ0XzEwMA=="]],
    ["a URN with colons", ["post", "get", "urn:li:activity:7100000000000000000"], ["posts", "urn:li:activity:7100000000000000000"]],
    ["a public slug", ["profile", "raphael-redmer"], ["users", "raphael-redmer"]],
    ["a bare numeric id", ["company", "1035"], ["companies", "1035"]],
    ["a COMPANY_ chat id", ["inbox", "get", "COMPANY_83734124_PRIMARY"], ["chats", "COMPANY_83734124_PRIMARY"]],
    ["a member URL, normalised to its slug", ["profile", "https://www.linkedin.com/in/raphael-redmer"], ["users", "raphael-redmer"]],
    ["a group URL, normalised to its numeric id", ["group", "get", "https://www.linkedin.com/groups/9123014/"], ["groups", "9123014"]],
  ])("%s still reaches the wire", async (_l, argv, tail) => {
    const r = await run(argv);
    expect(r.status, r.stderr).toBe(0);
    expect(r.requests.map((q) => segments(q.url))).toContainEqual(["v1", "acc_01PROBE", ...tail]);
  });
});

describe("the API decides the exit code, not a local guess about the value", () => {
  it.each([
    ["post get <share URL>", ["post", "get", SHARE_URL]],
    ["profile <a URL that is not a member URL>", ["profile", "https://example.com/some/path"]],
  ])("%s exits 4 with the error envelope on stdout", async (_l, argv) => {
    const r = await run([...argv, "--json"]);
    expect(r.requests.length, r.stderr).toBeGreaterThan(0);
    expect(r.status).toBe(4);
    expect((JSON.parse(r.stdout.trim()) as { error?: { code?: string } }).error?.code).toBe("RESOURCE_NOT_FOUND");
    expect(r.stderr).not.toContain("INVALID_PATH_SEGMENT");
  });
});

describe("--preview and the real run agree on whether an input is acceptable", () => {
  it.each([
    ["a share URL positional", ["post", "save", SHARE_URL], 0],
    ["a card urn carrying a slash", ["notification", "delete", CARD], 0],
    ["an id-shaped --account", ["post", "save", "urn:li:activity:7100000000000000000", "--account", "acc_01SOPH"], 0],
    ["a redirecting --account", ["post", "save", "urn:li:activity:7100000000000000000", "--account", "x/../../../v1/accounts"], 2],
  ])("%s: the preview and the real run exit alike; the preview calls nothing", async (_l, argv, status) => {
    const real = await run(argv);
    const preview = await run([...argv, "--preview"]);
    expect([real.status, preview.status]).toEqual([status, status]);
    expect(preview.requests, "--preview must not call the API").toEqual([]);
    expect(real.requests.length > 0).toBe(status === 0);
    if (status === 2) expect(preview.stderr).toContain("INVALID_PATH_SEGMENT");
  });
});
