import { vi } from "vitest";

/**
 * Run `fn` with `process.exit` stubbed to throw; resolve the exit code it
 * asked for, or `undefined` when it returned without exiting. Any other throw
 * propagates.
 */
export async function exitCode(fn: () => unknown): Promise<number | undefined> {
  const spy = vi.spyOn(process, "exit").mockImplementation(((c?: number | string | null) => {
    throw new Error(`__exit__${c ?? 0}`);
  }) as never);
  try {
    await fn();
    return undefined;
  } catch (e) {
    const m = /^__exit__(\d+)$/.exec((e as Error).message);
    if (!m) throw e;
    return Number(m[1]);
  } finally {
    spy.mockRestore();
  }
}
