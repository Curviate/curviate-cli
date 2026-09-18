// check:vendored-descriptions — the CLI's vendored OpenAPI fixture must
// still say what the deployed document says, field by field.
//
// Replaces a phrase-grep closing check.
// A grep tuned to "the last wrong sentence" cannot catch an older wrong
// sentence with different wording (missed 6/6 stale retention descriptions
// in the CLI fixture on that ticket). This compares by JSON path instead of
// by sentence, so it is correct regardless of how the wording has changed.
//
// Usage: node scripts/check-vendored-descriptions.mjs [<sdk fixture> <cli fixture>]
//
// With two path args: direct compare, exit 1 on any diff. Used standalone
// and against controls.
//
// With no args (the `pretest` wiring): standalone-clone problem — the SDK
// fixture this compares against is not shipped in the npm tarball, so it
// does not exist in a bare `git clone` of this repo. Resolved by locating
// the SDK fixture at the monorepo-sibling path `../sdk/fixtures/openapi.json`
// and skipping loudly, exit 0, when that sibling is absent or its declared
// package version doesn't match this package's pinned @curviate/sdk — never
// silently, and never a false red on a standalone clone.
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");

const load = (p) => JSON.parse(readFileSync(p, "utf8"));

// Joined with NUL, not "/" — OpenAPI path keys (e.g. paths["/v1/{id}"])
// contain literal "/", so a "/"-joined key is not guaranteed unique across
// ancestor-key chains. NUL cannot appear in a JSON object key from a parsed
// document.
const descs = (o, path = [], out = new Map()) => {
  if (!o || typeof o !== "object") return out;
  for (const k of Object.keys(o)) {
    if (k === "description" && typeof o[k] === "string") out.set(path.join("\0"), o[k]);
    else descs(o[k], [...path, k], out);
  }
  return out;
};

export function diffDescriptions(sdkFixturePath, cliFixturePath) {
  const A = descs(load(sdkFixturePath));
  const B = descs(load(cliFixturePath));
  const rows = [];
  for (const [p, v] of A) {
    const w = B.get(p);
    if (w === undefined) rows.push(["MISSING", p, v]);
    else if (w !== v) rows.push(["STALE", p, w]);
  }
  for (const p of B.keys()) if (!A.has(p)) rows.push(["EXTRA", p, B.get(p)]);
  return rows;
}

function resolveSiblingSdkFixture() {
  const sdkRoot = resolve(pkgRoot, "..", "sdk");
  const sdkPkgPath = join(sdkRoot, "package.json");
  const sdkFixturePath = join(sdkRoot, "fixtures", "openapi.json");

  if (!existsSync(sdkPkgPath) || !existsSync(sdkFixturePath)) {
    return { path: null, reason: "no monorepo sibling at ../sdk (standalone clone)" };
  }

  const cliPkg = load(join(pkgRoot, "package.json"));
  const declared = cliPkg.dependencies?.["@curviate/sdk"];
  const sdkPkg = load(sdkPkgPath);
  if (sdkPkg.version !== declared) {
    return {
      path: null,
      reason: `sibling ../sdk is version ${sdkPkg.version}, CLI declares ${declared} — not the pinned build`,
    };
  }

  return { path: sdkFixturePath, reason: null };
}

function printRows(rows) {
  for (const [kind, p, v] of rows) console.log(`${kind}  ${p.replaceAll("\0", "/")}\n        ${v.slice(0, 120)}`);
}

async function main() {
  const [a, b] = process.argv.slice(2);

  if (a && b) {
    const rows = diffDescriptions(a, b);
    printRows(rows);
    console.log(`\n${rows.length} description(s) differ`);
    process.exit(rows.length === 0 ? 0 : 1);
  }

  const { path: sdkFixturePath, reason } = resolveSiblingSdkFixture();
  if (!sdkFixturePath) {
    console.error(`check:vendored-descriptions SKIPPED — ${reason}`);
    process.exit(0);
  }

  const rows = diffDescriptions(sdkFixturePath, join(pkgRoot, "test", "fixtures", "openapi.json"));
  if (rows.length > 0) {
    printRows(rows);
    console.error(`check:vendored-descriptions FAIL — ${rows.length} description(s) differ from the sibling SDK fixture.`);
    process.exit(1);
  }
  console.error("check:vendored-descriptions OK — vendored fixture matches the sibling SDK fixture.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
