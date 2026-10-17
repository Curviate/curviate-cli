/**
 * `readlineSync`'s raw-mode (masked, no-echo) branch, below `resolveSecret`'s stubs: the terminator scan must work
 * on whole chunks (a paste with a trailing newline arrives as ONE chunk), against an injected fake stdin.
 */
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readlineSync, type ReadlineStdin } from "../../src/lib/readline.js";

const settle = <T>(p: Promise<T>) => Promise.race([p.then((value) => ({ value }), (e: Error) => ({ rejected: e.message })), new Promise<"hung">((r) => setTimeout(() => r("hung"), 500))]);

/** An EventEmitter-backed fake TTY stdin; chunks fire as separate async "data" events like real I/O. */
function fakeStdin() {
  const emitter = new EventEmitter();
  const stdin: ReadlineStdin = {
    isTTY: true,
    setRawMode: vi.fn(),
    resume: vi.fn(),
    pause: vi.fn(),
    setEncoding: vi.fn(),
    on: (event, listener) => void emitter.on(event, listener),
    removeListener: (event, listener) => void emitter.removeListener(event, listener),
  };
  return { stdin, emit: (...chunks: string[]) => queueMicrotask(() => chunks.forEach((c) => emitter.emit("data", c))) };
}

describe("readlineSync raw mode", () => {
  it.each([
    ["LF in one chunk", ["secret\n"]],
    ["CRLF in one chunk (one terminator)", ["secret\r\n"]],
    ["bare CR in one chunk", ["secret\r"]],
    ["split across chunks", ["sec", "ret\n"]],
    ["one character per chunk", [..."secret", "\n"]],
    ["DEL inside a multi-char chunk edits before the terminator", ["secrex\x7ft\n"]],
  ])("%s resolves to 'secret'", async (_l, chunks) => {
    const { stdin, emit } = fakeStdin();
    const p = readlineSync("prompt: ", { mask: true, stdin });
    emit(...chunks);
    expect(await settle(p)).toEqual({ value: "secret" });
  });

  it("Ctrl+C inside a multi-char chunk rejects with 'Interrupted.' and discards the rest of the chunk", async () => {
    const { stdin, emit } = fakeStdin();
    const p = readlineSync("prompt: ", { mask: true, stdin });
    emit("sec\x03ret\n");
    expect(await settle(p)).toEqual({ rejected: "Interrupted." });
  });

  it("never echoes the secret to stderr: only the prompt and the trailing newline", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { stdin, emit } = fakeStdin();
    const p = readlineSync("Enter secret: ", { mask: true, stdin });
    emit("secret\n");
    await settle(p);
    const written = spy.mock.calls.map((c) => c[0] as string).join("");
    spy.mockRestore();
    expect(written).toBe("Enter secret: \n");
  });

  it("the unmasked branch returns the line, not the empty string (close fired before settle)", async () => {
    const stream = new PassThrough();
    stream.write("PASTED-VALUE\n");
    stream.end();
    expect(await settle(readlineSync("prompt: ", { stdin: stream as unknown as ReadlineStdin }))).toEqual({ value: "PASTED-VALUE" });
  });
});
