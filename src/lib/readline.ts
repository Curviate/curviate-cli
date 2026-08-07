/**
 * Minimal TTY readline helper for masked input (API key prompts).
 *
 * When mask=true: writes the prompt to stderr and reads input from stdin
 * without echoing; the key never appears on screen. Falls back to a plain
 * readline if setRawMode is unavailable (e.g. in some CI environments).
 */

import { createInterface } from "node:readline";

/**
 * The subset of `NodeJS.ReadStream` this module actually touches, the
 * injectable seam's shape. Tests drive a fake EventEmitter-ish stub here
 * instead of the real terminal (real stdin can't be scripted to emit
 * arbitrary chunk boundaries in-process).
 */
export interface ReadlineStdin {
  isTTY?: boolean;
  setRawMode?(mode: boolean): void;
  resume(): void;
  pause(): void;
  setEncoding(encoding: string): void;
  // Narrowed to the single "data" listener shape this module actually
  // registers (a chunk string) rather than a fully generic EventEmitter
  // signature, deliberately not `(...args: unknown[]) => void`, which
  // would reject passing a `(chunk: string) => void` listener.
  on(event: "data", listener: (chunk: string) => void): void;
  removeListener(event: "data", listener: (chunk: string) => void): void;
}

export interface ReadlineOptions {
  /** If true, suppress character echo (masked input). Default false. */
  mask?: boolean;
  /**
   * Injectable stdin-like stream. Defaults to `process.stdin`. The
   * sanctioned test seam: mirrors the injection style used everywhere else
   * in this codebase (`readStdin`, `readSingleLine`, ...): since this
   * function is the one place that touches the real stream directly.
   */
  stdin?: ReadlineStdin;
}

/**
 * Prompt the user for a line of input.
 * Output prompt is written to stderr; input is read from stdin.
 * When mask=true, characters are not echoed.
 */
export async function readlineSync(
  prompt: string,
  opts: ReadlineOptions = {},
): Promise<string> {
  const stdin: ReadlineStdin = opts.stdin ?? (process.stdin as unknown as ReadlineStdin);

  return new Promise((resolve, reject) => {
    process.stderr.write(prompt);

    if (opts.mask && typeof stdin.setRawMode === "function") {
      // Raw mode: suppress echo and scan each incoming chunk for a
      // terminator, NOT one character per `data` event. A live terminal
      // (especially over SSH, or a paste from a .env/password manager) can
      // coalesce an entire line, or a paste plus the Enter that follows it
      //, into a single multi-byte `data` chunk. A whole-chunk `===`
      // equality check against "\r"/"\n" never matches such a chunk, so the
      // terminator silently lands inside `input` and the promise never
      // settles. Scanning char-by-char finds the terminator wherever it
      // falls in the chunk while still running backspace/Ctrl+C handling on
      // every character that precedes it.
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf8");

      let input = "";
      const onData = (chunk: string) => {
        for (let i = 0; i < chunk.length; i++) {
          const char = chunk[i];
          if (char === "\r" || char === "\n") {
            // Resolve on the FIRST terminator in the chunk; discard it and
            // everything after it in this chunk. A "\r\n" pair therefore
            // counts as a single terminator whether both bytes land in the
            // same chunk or the "\n" would have arrived in a follow-up
            // chunk (the listener is removed before that can happen).
            stdin.setRawMode?.(false);
            stdin.pause();
            stdin.removeListener("data", onData);
            process.stderr.write("\n");
            resolve(input);
            return;
          } else if (char === "") {
            // Ctrl+C
            stdin.setRawMode?.(false);
            stdin.pause();
            stdin.removeListener("data", onData);
            reject(new Error("Interrupted."));
            return;
          } else if (char === "" || char === "") {
            // Backspace (DEL or Ctrl+H)
            input = input.slice(0, -1);
          } else {
            input += char;
          }
        }
      };
      stdin.on("data", onData);
    } else {
      // Fallback: plain readline (visible input or non-TTY CI).
      const rl = createInterface({
        input: stdin as unknown as NodeJS.ReadableStream,
        output: undefined, // suppress default echo (prompt already on stderr)
        terminal: false,
      });
      rl.once("line", (line) => {
        rl.close();
        resolve(line.trim());
      });
      rl.once("error", reject);
      rl.once("close", () => resolve(""));
    }
  });
}
