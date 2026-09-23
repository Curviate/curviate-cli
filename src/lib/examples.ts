/**
 * `meta.examples`: up to three one-line invocations per command. `--help`
 * prints them under the usage block, and the docs site renders the same lines
 * from `commands.json` (see test/commands-manifest.test.ts).
 */
import { showUsage, type ArgsDef, type CommandDef } from "citty";

declare module "citty" {
  interface CommandMeta {
    examples?: string[];
  }
}

export async function showUsageWithExamples<T extends ArgsDef = ArgsDef>(
  cmd: CommandDef<T>,
  parent?: CommandDef<T>,
): Promise<void> {
  await showUsage(cmd, parent);
  const meta = typeof cmd.meta === "function" ? await cmd.meta() : await cmd.meta;
  const examples = meta?.examples ?? [];
  if (examples.length === 0) return;
  process.stdout.write(`EXAMPLES\n\n${examples.map((e) => `  ${e}`).join("\n")}\n\n`);
}
