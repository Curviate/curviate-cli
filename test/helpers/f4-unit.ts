import { vi } from "vitest";

/** Captured stdout/stderr pair the run* functions write to. */
export const mkOut = () => ({ stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });
export type Out = ReturnType<typeof mkOut>;

/** Everything written to one stream, concatenated. */
export const written = (w: { write: { mock: { calls: unknown[][] } } }) => w.write.mock.calls.map((c) => String(c[0])).join("");

/** NDJSON object lines written to stdout, parsed. */
export const jsonLines = (out: Out) =>
  written(out.stdout)
    .split("\n")
    .filter((l) => l.trim().startsWith("{"))
    .map((l) => JSON.parse(l) as Record<string, unknown>);

/** A client whose `.account(id)` returns the given namespace stub. */
export const mkClient = (ns: unknown) => ({ account: vi.fn().mockReturnValue(ns) });
