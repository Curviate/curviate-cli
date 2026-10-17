/** Small shared bits for the search / recruiter / sales-nav unit suites (run* functions against a mocked client). */
import { vi } from "vitest";
import type { Mock } from "vitest";
import { CurviateError } from "@curviate/sdk";

export const mkOut = () => ({ stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });
export type Out = ReturnType<typeof mkOut>;
export const text = (w: { write: Mock }) => w.write.mock.calls.map((c) => String(c[0])).join("");
/** The single JSON document a run wrote to stdout. */
export const json = (o: Out) => JSON.parse(text(o.stdout)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
/** NDJSON object lines written to stdout. */
export const ndjson = (o: Out) => text(o.stdout).split("\n").filter((l) => l.trim().startsWith("{"));
/** First argument of call `i` of a mock. */
export const arg0 = (m: Mock, i = 0) => m.mock.calls[i]![0] as Record<string, unknown>;
export const clientOf = (ns: unknown) => ({ account: vi.fn().mockReturnValue(ns) });
export const sdkError = (code: string, httpStatus: number, message = code) =>
  new CurviateError({ code: code as never, message, httpStatus, userFixable: true, retryLikelyToSucceed: false });
