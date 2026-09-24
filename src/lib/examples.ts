/**
 * Two optional command-meta fields the docs site also renders from
 * `commands.json` (see test/commands-manifest.test.ts):
 *   - `examples`: up to three one-line invocations.
 *   - `requires`: one short line per conditional requirement a flag
 *     declaration cannot express (one-of, a --body-file alternative,
 *     at-least-one, "only with"). Unconditional ones are `required: true`.
 * `--help` prints both under the usage block.
 */
import { showUsage, type ArgsDef, type CommandDef } from "citty";

declare module "citty" {
  interface CommandMeta {
    examples?: string[];
    requires?: string[];
  }
}

export async function showUsageWithExamples<T extends ArgsDef = ArgsDef>(
  cmd: CommandDef<T>,
  parent?: CommandDef<T>,
): Promise<void> {
  await showUsage(cmd, parent);
  const meta = typeof cmd.meta === "function" ? await cmd.meta() : await cmd.meta;
  const block = (title: string, lines: string[] = []) =>
    lines.length ? process.stdout.write(`${title}\n\n${lines.map((l) => `  ${l}`).join("\n")}\n\n`) : undefined;
  block("REQUIRES", meta?.requires);
  block("EXAMPLES", meta?.examples);
}
