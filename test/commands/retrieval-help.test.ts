/**
 * Which commands ADVERTISE `--mode`/`--max-age`, and which must not.
 *
 * Help text is the last thing someone checks before concluding the tool is
 * broken, and here it is also a safety surface: the API refuses these two
 * parameters with a 400 on any endpoint that does not declare them, so a
 * command that advertised them where they do not apply would be documenting a
 * guaranteed failure. The positive and negative arms are therefore equally
 * load-bearing, and both are asserted against the live command tree rather
 * than a transcription of it.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { RETRIEVAL_MODES, MAX_AGE_CEILING_SECONDS } from "../../src/lib/retrieval.js";

type ArgDef = { description?: string };
type Cmd = { args?: Record<string, ArgDef>; subCommands?: Record<string, Cmd> };

async function tree(): Promise<{ profile: Cmd; inbox: Cmd; post: Cmd }> {
  const [{ profileCommand }, { inboxCommand }, { postCommand }] = await Promise.all([
    import("../../src/commands/profile.js"),
    import("../../src/commands/inbox.js"),
    import("../../src/commands/post.js"),
  ]);
  return {
    profile: profileCommand as unknown as Cmd,
    inbox: inboxCommand as unknown as Cmd,
    post: postCommand as unknown as Cmd,
  };
}

function args(cmd: Cmd | undefined): Record<string, ArgDef> {
  return cmd?.args ?? {};
}

describe("the retrieval flags are advertised on exactly the store-served reads", () => {
  it("profile <id> declares both", async () => {
    const a = args((await tree()).profile);
    expect(a["mode"]).toBeDefined();
    expect(a["max-age"]).toBeDefined();
  });

  it("profile me declares both", async () => {
    const a = args((await tree()).profile.subCommands?.["me"]);
    expect(a["mode"]).toBeDefined();
    expect(a["max-age"]).toBeDefined();
  });

  it("inbox messages declares both", async () => {
    const a = args((await tree()).inbox.subCommands?.["messages"]);
    expect(a["mode"]).toBeDefined();
    expect(a["max-age"]).toBeDefined();
  });

  // The fourth, from `@curviate/sdk` 0.26.0: `getChat` gained the query
  // argument, so the binary can finally send what this help text advertises.
  it("inbox get declares both", async () => {
    const a = args((await tree()).inbox.subCommands?.["get"]);
    expect(a["mode"]).toBeDefined();
    expect(a["max-age"]).toBeDefined();
  });
});

describe("the flags are NOT advertised where the endpoint would refuse them", () => {
  it("inbox list does not declare them", async () => {
    const a = args((await tree()).inbox.subCommands?.["list"]);
    expect(a["mode"]).toBeUndefined();
    expect(a["max-age"]).toBeUndefined();
  });

  // `post get` carries the response envelope but does NOT accept the query
  // parameters; the API answers a 400 rather than ignoring them.
  it("post get does not declare them", async () => {
    const a = args((await tree()).post.subCommands?.["get"]);
    expect(a["mode"]).toBeUndefined();
    expect(a["max-age"]).toBeUndefined();
  });

  // CONTROL on the traversal: these nodes really were resolved, so the
  // "undefined" arms above are statements about the args and not about a
  // lookup that silently returned nothing.
  it("control: the negative-arm commands exist and declare other flags", async () => {
    const t = await tree();
    for (const cmd of [
      t.inbox.subCommands?.["list"],
      t.post.subCommands?.["get"],
    ]) {
      expect(cmd).toBeDefined();
      expect(Object.keys(args(cmd)).length).toBeGreaterThan(0);
      expect(args(cmd)["json"]).toBeDefined();
    }
  });
});

describe("the help text states the vocabulary a caller has to type", () => {
  it("--mode names all four values", async () => {
    const desc = args((await tree()).profile)["mode"]?.description ?? "";
    for (const mode of RETRIEVAL_MODES) expect(desc).toContain(mode);
  });

  it("--max-age states the ceiling, so the bound is discoverable without a 400", async () => {
    const desc = args((await tree()).profile)["max-age"]?.description ?? "";
    expect(desc).toContain(String(MAX_AGE_CEILING_SECONDS));
  });

  it("--mode warns that cache_only and --max-age do not combine", async () => {
    const desc = args((await tree()).profile)["mode"]?.description ?? "";
    expect(desc).toMatch(/max-age/);
  });
});

/**
 * Not advertising the flags is not the same property as REFUSING them.
 *
 * The API refuses undeclared `mode`/`max_age` with a 400 rather than ignoring
 * them, precisely because ignoring turns the `cache_only` guarantee into a 200
 * with nothing to notice. A CLI that parsed the flag and dropped it would
 * reproduce that failure one layer earlier, so the refusal is asserted through
 * the real dispatcher rather than inferred from the args table. (The check
 * lives in `dispatch`, not `resolveLeaf` — routing resolves such a call
 * happily; it is the dispatcher that rejects the undeclared flag.)
 */
describe("the flags are REFUSED, not ignored, on commands that do not declare them", () => {
  afterEach(() => vi.restoreAllMocks());

  /** Dispatch a route and report what the user is told on stderr. */
  async function dispatchStderr(root: unknown, argv: string[]): Promise<string> {
    const chunks: string[] = [];
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit__${code ?? 0}`);
    }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(((c: string) => {
      chunks.push(String(c));
      return true;
    }) as never);
    vi.spyOn(process.stdout, "write").mockImplementation((() => true) as never);
    try {
      const { dispatch } = await import("../../src/dispatch.js");
      await dispatch(root as never, argv);
    } catch {
      // A usage error or a downstream network failure both land here; the
      // assertion is on what was written, not on how the process ended.
    }
    return chunks.join("");
  }

  it.each([
    ["inbox list", "inbox", ["list", "--account", "acc_1", "--mode", "cache_only"], "--mode"],
    ["profile followers", "profile", ["followers", "ada", "--account", "acc_1", "--max-age", "300"], "--max-age"],
  ])("%s refuses %s as an unknown flag", async (_label, group, argv, flag) => {
    const mod =
      group === "inbox"
        ? (await import("../../src/commands/inbox.js")).inboxCommand
        : (await import("../../src/commands/profile.js")).profileCommand;
    const err = await dispatchStderr(mod, argv as string[]);
    expect(err).toContain("unknown flag");
    expect(err).toContain(flag as string);
  });

  // CONTROL: the same dispatcher does NOT call the pair unknown where it IS
  // declared, so the refusals above are about the undeclared flag and not
  // about a dispatcher that rejects these two names everywhere.
  it.each([["messages"], ["get"]])(
    "control: inbox %s is not told --mode is unknown",
    async (sub) => {
      const { inboxCommand } = await import("../../src/commands/inbox.js");
      // `--base-url` is pinned at a dead local port on purpose: without it the
      // dispatcher reaches production, so the arm would be exercising the live
      // API instead of the flag table.
      const err = await dispatchStderr(inboxCommand, [
        sub, "c1", "--account", "acc_1", "--mode", "cache_only",
        "--base-url", "http://127.0.0.1:9",
      ]);
      expect(err).not.toContain("unknown flag");
    },
  );
});
