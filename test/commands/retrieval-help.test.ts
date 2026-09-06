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
import { describe, it, expect } from "vitest";
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
});

describe("the flags are NOT advertised where the endpoint would refuse them", () => {
  // The pinned SDK's getChat takes no query argument, so the flags cannot be
  // plumbed here yet even though the endpoint itself accepts them. Advertising
  // them would promise something the binary cannot send.
  it("inbox get does not declare them", async () => {
    const a = args((await tree()).inbox.subCommands?.["get"]);
    expect(a["mode"]).toBeUndefined();
    expect(a["max-age"]).toBeUndefined();
  });

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
      t.inbox.subCommands?.["get"],
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
