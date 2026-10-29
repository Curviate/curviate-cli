/** Zero Accounts: `doctor` and `account list` name the next step; with any Account, in any status, they do not. */
import { describe, it, expect } from "vitest";
import { useSink } from "../helpers/sink.js";

const sink = useSink();
const list = (...status: string[]) => ({ object: "list", items: status.map((s, i) => ({ object: "account", account_id: `acc_${i}`, status: s })), cursor: null });
const NEXT = "curviate account connect-request create";
const SENTENCE = "No Account connected: ask your user to connect one in the dashboard, or create a Connect request.";

/** Human mode: the CLI renders for a person only when stdout is a terminal. */
async function asHuman<T>(run: () => Promise<T>): Promise<T> {
  const was = process.stdout.isTTY;
  process.stdout.isTTY = true;
  try {
    return await run();
  } finally {
    process.stdout.isTTY = was;
  }
}

describe("doctor next_step", () => {
  it.each([
    ["no Account", [], NEXT, true],
    ["one Account", ["active"], undefined, false],
    ["one Account that needs a reconnect", ["reconnect_needed"], undefined, false],
  ])("%s: JSON next_step and the human sentence", async (_l, status, next, sentence) => {
    sink.reply = { body: list(...status) };
    expect(JSON.parse((await sink.run(["doctor", "--json"])).stdout).next_step).toBe(next);
    expect((await asHuman(() => sink.run(["doctor"]))).stdout.includes(SENTENCE)).toBe(sentence);
  });
});

describe("account list", () => {
  it("with zero Accounts prints the sentence on stderr in human mode and leaves --json untouched; an external-id filter or an Account does not", async () => {
    sink.reply = { body: list() };
    expect((await asHuman(() => sink.run(["account", "list"]))).stderr).toContain(SENTENCE);
    const json = await sink.run(["account", "list", "--json"]);
    expect(json.stderr).not.toContain("No Account connected");
    expect(JSON.parse(json.stdout)).toEqual(list());
    expect((await asHuman(() => sink.run(["account", "list", "--external-id", "u1"]))).stderr).not.toContain(SENTENCE);
    sink.reply = { body: list("active") };
    expect((await asHuman(() => sink.run(["account", "list"]))).stderr).not.toContain(SENTENCE);
  });
});
