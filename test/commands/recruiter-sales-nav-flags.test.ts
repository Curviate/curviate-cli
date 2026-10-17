/**
 * Flag hygiene on the `args` of each command definition (`defineCommand` is an identity function, so the keys
 * ARE the registered flags): writes and single-object reads declare no pagination flags, list reads keep them.
 */
import { describe, it, expect } from "vitest";
import { recruiterCommand } from "../../src/commands/recruiter.js";
import { salesNavCommand } from "../../src/commands/sales-nav.js";

type Cmd = { args?: Record<string, unknown>; subCommands?: Record<string, Cmd> };
const PAGING = ["limit", "cursor", "all", "max-pages"];
const argsAt = (root: unknown, path: string) => path.split(" ").reduce((c, seg) => c.subCommands![seg]!, root as Cmd).args ?? {};

const rows = (product: string, root: unknown, writes: string[], singles: string[], lists: string[]) =>
  describe(product, () => {
    it.each(writes)("write %s declares no pagination flags", (path) => {
      for (const f of PAGING) expect(argsAt(root, path), `--${f}`).not.toHaveProperty(f);
    });
    it.each(singles)("single-object read %s declares no pagination flags and keeps --fields", (path) => {
      for (const f of PAGING) expect(argsAt(root, path), `--${f}`).not.toHaveProperty(f);
      expect(argsAt(root, path)).toHaveProperty("fields");
    });
    it.each(lists)("list read %s keeps --limit, --cursor, --all", (path) => {
      for (const f of ["limit", "cursor", "all"]) expect(argsAt(root, path), `--${f}`).toHaveProperty(f);
    });
  });

rows("recruiter", recruiterCommand,
  ["message new", "save-candidate", "job create", "job publish", "job close", "project update", "project-job create", "project-job update"],
  ["profile", "project", "applicant", "applicant resume", "job get", "project-job get", "project-job budget"],
  ["search", "search people", "projects", "jobs", "pipeline", "talent-search"]);
rows("sales-nav", salesNavCommand,
  ["message new", "save-lead", "save-account"],
  ["profile"],
  ["search", "search people", "search companies", "account-lists", "lead-lists", "browse-account-list", "browse-lead-list"]);

describe("sales-nav browse commands keep their own flags", () => {
  it("browse-account-list: --filter, --sort-by, --sort-order, --max-pages; browse-lead-list: --spotlight", () => {
    for (const f of ["filter", "sort-by", "sort-order", "max-pages"]) expect(argsAt(salesNavCommand, "browse-account-list")).toHaveProperty(f);
    expect(argsAt(salesNavCommand, "browse-lead-list")).toHaveProperty("spotlight");
  });
});
