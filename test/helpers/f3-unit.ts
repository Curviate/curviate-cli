/**
 * Table harness for the `run*(client, args, out)` command functions: one shared
 * mock-SDK shape per file, one row per behaviour. Each row builds fresh mocks.
 * `shape` maps `namespace -> method -> default resolved value`; a row's `path`
 * is `namespace.method` (or `account` for the client factory).
 */
import { expect, it, vi, type Mock } from "vitest";
import { exitCode } from "./exit-code.js";
import { noConnectedAccounts } from "./no-connected-accounts.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Run = (client: never, args: any, out: never) => Promise<unknown>;
export type Shape = Record<string, Record<string, unknown>>;
export type Args = Record<string, unknown>;

export function mkOut() {
  return { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
}
export type Out = ReturnType<typeof mkOut>;
export const text = (out: Out) => out.stdout.write.mock.calls.map((c) => String(c[0])).join("");
export const ndjson = (out: Out) => out.stdout.write.mock.calls.map((c) => String(c[0])).filter((l) => l.trim().startsWith("{"));

export function mkEnv(shape: Shape) {
  const ns: Record<string, Record<string, Mock>> = {};
  for (const [g, ms] of Object.entries(shape)) {
    ns[g] = {};
    for (const [m, v] of Object.entries(ms)) ns[g]![m] = vi.fn().mockResolvedValue(v);
  }
  const client = { account: vi.fn().mockReturnValue(ns) };
  const fn = (path: string) => ns[path.split(".")[0]!]![path.split(".")[1]!]!;
  return { ns, client, out: mkOut(), fn };
}
export type Env = ReturnType<typeof mkEnv>;

/** Run once with `account: acc_1, json: true` merged under `args`. */
export async function go(shape: Shape, run: Run, args: Args = {}, prep?: (e: Env) => void) {
  const e = mkEnv(shape);
  prep?.(e);
  await run(e.client as never, { account: "acc_1", json: true, ...args }, e.out as never);
  return e;
}
export const anySdkCall = (e: Env) => Object.values(e.ns).some((g) => Object.values(g).some((m) => m.mock.calls.length > 0));

/** Request building: `[label, run, args, path, expected call args]`. Exact arg list is asserted. */
export function calls(shape: Shape, rows: Array<[string, Run, Args, string, unknown[]]>) {
  it.each(rows)("%s", async (_l, run, args, path, expected) => {
    const e = await go(shape, run, args);
    expect(e.fn(path)).toHaveBeenCalledTimes(1);
    expect(e.fn(path)).toHaveBeenCalledWith(...expected);
  });
}

/** --json prints the SDK response verbatim: `[label, run, args, path]`. */
export function prints(shape: Shape, rows: Array<[string, Run, Args, string]>) {
  it.each(rows)("%s", async (_l, run, args, path) => {
    const e = await go(shape, run, args);
    expect(JSON.parse(text(e.out))).toEqual(shape[path.split(".")[0]!]![path.split(".")[1]!]);
  });
}

/** --all walks two pages and streams one NDJSON line per item: `[label, run, args, path]`. */
export function streams(shape: Shape, rows: Array<[string, Run, Args, string]>) {
  it.each(rows)("%s --all: NDJSON across pages", async (_l, run, args, path) => {
    const e = await go(shape, run, { json: undefined, all: true, ...args }, (x) =>
      x.fn(path).mockResolvedValueOnce({ items: [{ id: "1" }], cursor: "cur_1" }).mockResolvedValueOnce({ items: [{ id: "2" }], cursor: null }),
    );
    expect(ndjson(e.out)).toHaveLength(2);
    expect(e.fn(path)).toHaveBeenCalledTimes(2);
  });
}

/** --preview renders `{method, args?, body?}` and makes no SDK call: `[label, run, args, path, extra]`. */
export function previews(shape: Shape, rows: Array<[string, Run, Args, string, Args]>) {
  it.each(rows)("%s --preview", async (_l, run, args, path, extra) => {
    const e = await go(shape, run, { preview: true, ...args });
    expect(anySdkCall(e)).toBe(false);
    expect(JSON.parse(text(e.out))).toMatchObject({ method: path, ...extra });
  });
}

/** A usage refusal: exit `code`, nothing sent. `[label, run, args, code]`; `args.account === null` = none connected. */
export function refuses(shape: Shape, rows: Array<[string, Run, Args, number]>) {
  it.each(rows)("%s", async (_l, run, args, code) => {
    const e = mkEnv(shape);
    const noAcct = args["account"] === null;
    const client = noAcct ? noConnectedAccounts(e.client) : e.client;
    const a = noAcct ? { json: true, ...args, account: undefined } : { account: "acc_1", ...args };
    expect(await exitCode(() => run(client as never, a, e.out as never))).toBe(code);
    expect(anySdkCall(e)).toBe(false);
  });
}
