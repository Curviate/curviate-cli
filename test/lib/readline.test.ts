/**
 * Unit tests for `readlineSync`'s raw-mode (masked, no-echo) branch —
 * the level BELOW `credential-resolve.ts`'s `resolveSecret`.
 *
 * Regression anchor for a hang reintroduced in a prior cycle: the raw-mode
 * `onData` handler used to equality-check the WHOLE incoming chunk against
 * "\r"/"\n", so a multi-byte chunk containing the terminator — a paste with
 * a trailing newline (copied from a .env/password manager/notes app), or an
 * Enter the terminal coalesces into the paste over SSH — never matched, and
 * the terminator silently landed inside `input` while the promise never
 * settled. A real-pty run reproduced this with a pasted value plus a
 * trailing LF, a trailing CRLF, and a bare trailing CR, each delivered as a
 * SINGLE `data` chunk.
 *
 * These tests exercise `readlineSync` directly (not through
 * `resolveSecret`'s stubs, which bypass this module entirely and is why the
 * pre-fix suite stayed green while the real terminal hung) against an
 * injected fake stdin — the sanctioned seam added alongside this fix
 * (`ReadlineOptions.stdin`, default `process.stdin`).
 */
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readlineSync, type ReadlineStdin } from "../../src/lib/readline.js";

/** Race a promise against a short timer; reports which one settled first. */
function raceAgainstTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ settled: true; value: T } | { settled: false }> {
  return Promise.race([
    promise.then((value) => ({ settled: true as const, value })),
    new Promise<{ settled: false }>((resolve) => setTimeout(() => resolve({ settled: false }), ms)),
  ]);
}

/**
 * A minimal EventEmitter-backed fake TTY stdin conforming to
 * `ReadlineStdin`. `emit(chunks)` fires each chunk as a separate "data"
 * event, asynchronously (after the current call stack unwinds) so it
 * behaves like real I/O rather than relying on synchronous listener
 * registration ordering.
 */
function makeFakeStdin(): { stdin: ReadlineStdin; emit: (...chunks: string[]) => void } {
  const emitter = new EventEmitter();
  const stdin: ReadlineStdin = {
    isTTY: true,
    setRawMode: vi.fn(),
    resume: vi.fn(),
    pause: vi.fn(),
    setEncoding: vi.fn(),
    on: (event, listener) => {
      emitter.on(event, listener);
    },
    removeListener: (event, listener) => {
      emitter.removeListener(event, listener);
    },
  };
  const emit = (...chunks: string[]) => {
    queueMicrotask(() => {
      for (const chunk of chunks) emitter.emit("data", chunk);
    });
  };
  return { stdin, emit };
}

describe("readlineSync — raw-mode chunk-safe terminator scan (regression anchor)", () => {
  it("(a) 'secret\\n' delivered as a SINGLE chunk resolves to 'secret'", async () => {
    const { stdin, emit } = makeFakeStdin();
    const promise = readlineSync("prompt: ", { mask: true, stdin });
    emit("secret\n");
    const outcome = await raceAgainstTimeout(promise, 500);
    expect(outcome).toEqual({ settled: true, value: "secret" });
  });

  it("(b) 'secret\\r\\n' delivered as a SINGLE chunk resolves to 'secret' (CRLF treated as one terminator)", async () => {
    const { stdin, emit } = makeFakeStdin();
    const promise = readlineSync("prompt: ", { mask: true, stdin });
    emit("secret\r\n");
    const outcome = await raceAgainstTimeout(promise, 500);
    expect(outcome).toEqual({ settled: true, value: "secret" });
  });

  it("(c) 'secret\\r' delivered as a SINGLE chunk (bare CR, no trailing LF) resolves to 'secret'", async () => {
    const { stdin, emit } = makeFakeStdin();
    const promise = readlineSync("prompt: ", { mask: true, stdin });
    emit("secret\r");
    const outcome = await raceAgainstTimeout(promise, 500);
    expect(outcome).toEqual({ settled: true, value: "secret" });
  });

  it("(d) split across two chunks ('sec' then 'ret\\n') resolves to 'secret'", async () => {
    const { stdin, emit } = makeFakeStdin();
    const promise = readlineSync("prompt: ", { mask: true, stdin });
    emit("sec", "ret\n");
    const outcome = await raceAgainstTimeout(promise, 500);
    expect(outcome).toEqual({ settled: true, value: "secret" });
  });

  it("(e) char-by-char delivery (existing behavior, one character per chunk) still resolves to 'secret'", async () => {
    const { stdin, emit } = makeFakeStdin();
    const promise = readlineSync("prompt: ", { mask: true, stdin });
    emit("s", "e", "c", "r", "e", "t", "\n");
    const outcome = await raceAgainstTimeout(promise, 500);
    expect(outcome).toEqual({ settled: true, value: "secret" });
  });

  it("backspace inside a multi-char chunk still edits `input` before the terminator is found in the same chunk", async () => {
    const { stdin, emit } = makeFakeStdin();
    const promise = readlineSync("prompt: ", { mask: true, stdin });
    // s e c r e x <DEL> t \n  ->  DEL removes the trailing "x", "t" follows -> "secret"
    emit("secrext\n");
    const outcome = await raceAgainstTimeout(promise, 500);
    expect(outcome).toEqual({ settled: true, value: "secret" });
  });

  it("Ctrl+C inside a multi-char chunk rejects immediately and discards anything after it in that chunk", async () => {
    const { stdin, emit } = makeFakeStdin();
    const promise = readlineSync("prompt: ", { mask: true, stdin });
    // "sec" + Ctrl+C (\x03) + "ret\n" -- the reject must fire on the Ctrl+C
    // and never process "ret\n" as further input.
    emit("secret\n");
    const wrapped = promise.then(
      (value) => ({ kind: "resolved" as const, value }),
      (err: Error) => ({ kind: "rejected" as const, message: err.message }),
    );
    const outcome = await raceAgainstTimeout(wrapped, 500);
    expect(outcome).toEqual({
      settled: true,
      value: { kind: "rejected", message: "Interrupted." },
    });
  });

  it("never echoes the secret to stderr — only the prompt and the trailing newline are written", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { stdin, emit } = makeFakeStdin();
      const promise = readlineSync("Enter secret: ", { mask: true, stdin });
      emit("secret\n");
      await raceAgainstTimeout(promise, 500);
      const written = stderrSpy.mock.calls.map((c) => c[0] as string).join("");
      expect(written).toBe("Enter secret: \n");
    } finally {
      stderrSpy.mockRestore();
    }
  });
  /**
   * The plain (unmasked) branch, which the raw-mode cases above never touch.
   *
   * It closed the interface BEFORE settling, and `close()` emits its event
   * synchronously, so the "close" listener resolved the empty string first
   * and every visible read returned "". Unreachable while the only caller
   * asked for masking; reached the moment a caller wanted a visible prompt,
   * which is what a pasted value needs. The suite above stayed green through
   * all of it, because none of it drives this branch.
   */
  it("the unmasked branch returns the line, not the empty string", async () => {
    const stream = new PassThrough();
    stream.write("PASTED-VALUE\n");
    stream.end();
    const got = await raceAgainstTimeout(
      readlineSync("prompt: ", { stdin: stream as unknown as ReadlineStdin }),
      500,
    );
    expect(got).toEqual({ settled: true, value: "PASTED-VALUE" });
  });
});
