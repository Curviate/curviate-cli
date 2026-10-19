/**
 * Help as a contract. Command meta carries structured
 * sections the docs site also renders from `commands.json`
 * (test/commands-manifest.test.ts); `--help` prints them under citty's usage
 * block in one fixed order, only those that apply:
 *
 *   DOCUMENT · RULES · REQUIRES · OUTPUT · ERRORS · SEE ALSO · EXAMPLES (last)
 *
 *   - `risk`: read (changes no state), write, or high (irreversible, fan-out,
 *     starts automation, connects or disconnects an Account).
 *   - `rules`: what a write changes, who sees it, the budget rows it counts
 *     against (names from `quotas[].budget_row`), what a retry does, how to
 *     undo it, and for high its blast radius. Rendered, never free text;
 *     `notes` is a group's fixed copy or an offline marker.
 *   - `requires`: one short line per conditional requirement a flag
 *     declaration cannot express. Unconditional ones are `required: true`.
 *   - `output`: what stdout carries.
 *   - `errors`: codes beyond the shared set, exit numbers from EXIT_CODE_MAP.
 *   - `seeAlso`: full command paths or URLs.
 *   - `document`: the document-inputs manifest key (lib/document.ts).
 *   - `examples`: 1-3 invocations; the last one is complete.
 */
import { renderUsage, type ArgsDef, type CommandDef } from "citty";
import { EXIT_CODE_MAP } from "./exit-codes.js";

type Risk = "read" | "write" | "high";
export type Rules = {
  changes?: string;
  visible_to?: string;
  budget_rows?: string[];
  retry?: string;
  undo?: string;
  blast_radius?: string;
  notes?: string[];
};

declare module "citty" {
  interface CommandMeta {
    examples?: string[];
    requires?: string[];
    risk?: Risk;
    rules?: Rules;
    output?: string[];
    errors?: Record<string, string>;
    seeAlso?: string[];
    document?: string;
  }
}

export const SECTION_ORDER = ["DOCUMENT", "RULES", "REQUIRES", "OUTPUT", "ERRORS", "SEE ALSO", "EXAMPLES"] as const;

/** Exit number for an error code, as EXIT_CODE_MAP has it (1 when unmapped). */
const exitOf = (code: string): number => (EXIT_CODE_MAP as Record<string, number | undefined>)[code] ?? 1;

function renderRules(rules: Rules | undefined): string[] {
  if (!rules) return [];
  const rows = rules.budget_rows;
  return [
    rules.changes && `Changes: ${rules.changes}`,
    rules.visible_to && `Visible to: ${rules.visible_to}`,
    rows && `Budget rows: ${rows.length ? `${rows.join(", ")} (see \`curviate account get <account_id>\`)` : "none"}`,
    rules.retry && `Retry: ${rules.retry}`,
    rules.undo && `Undo: ${rules.undo}`,
    rules.blast_radius && `Blast radius: ${rules.blast_radius}`,
    ...(rules.notes ?? []),
  ].filter((l): l is string => typeof l === "string" && l !== "");
}

/** The sections after citty's block, in the fixed order, as text. */
export async function renderSections<T extends ArgsDef = ArgsDef>(cmd: CommandDef<T>): Promise<string> {
  const meta = typeof cmd.meta === "function" ? await cmd.meta() : await cmd.meta;
  const { renderDocument } = meta?.document ? await import("./document.js") : { renderDocument: () => [] as string[] };
  const body: Record<(typeof SECTION_ORDER)[number], string[] | undefined> = {
    DOCUMENT: meta?.document ? renderDocument(meta.document) : undefined,
    RULES: renderRules(meta?.rules),
    REQUIRES: meta?.requires,
    OUTPUT: meta?.output,
    ERRORS: meta?.errors && Object.entries(meta.errors).map(([code, when]) => `${code} (exit ${exitOf(code)}): ${when}`),
    "SEE ALSO": meta?.seeAlso,
    EXAMPLES: meta?.examples,
  };
  return SECTION_ORDER.filter((t) => body[t]?.length)
    // Only an entry's first line is indented: a heredoc's body and its EOF must paste as-is.
    .map((t) => `${t}\n\n${body[t]!.map((l) => `  ${l}`).join("\n")}\n\n`)
    .join("");
}

/**
 * Print help for the node at `path` (`["curviate", "core", "profile", "me"]`).
 * citty names a command by its parent's name plus its own, so the full path
 * is passed as that parent: every usage line reads as a pasteable invocation.
 * Subcommands are listed from their loaders' descriptions, so help loads no
 * command module beyond the one it describes.
 */
export async function showHelp<T extends ArgsDef = ArgsDef>(cmd: CommandDef<T>, path: string[]): Promise<void> {
  const parent = path.length > 1 ? ({ meta: { name: path.slice(0, -1).join(" ") } } as CommandDef<T>) : undefined;
  // A lazy group is listed by the description its loader carries, never loaded.
  const subs = typeof cmd.subCommands === "function" ? await cmd.subCommands() : await cmd.subCommands;
  const listed = subs && Object.fromEntries(
    Object.entries(subs).map(([k, v]) => [k, typeof v === "function" && "description" in v ? { meta: { description: v.description as string } } : v]),
  );
  process.stdout.write((await renderUsage({ ...cmd, subCommands: listed } as CommandDef<T>, parent)) + "\n\n" + (await renderSections(cmd)));
}
