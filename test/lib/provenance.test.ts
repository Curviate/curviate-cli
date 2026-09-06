/**
 * The retrieval envelope survives projection, and human mode says it out loud.
 *
 * Every store-servable read carries `source` (store|live) and `observed_at`,
 * plus `withdrawn` (always present) and `withdrawn_at` when set. A caller has
 * to be able to tell a served copy from
 * a fetch — that is the whole point of the field, and it is also the field
 * most easily lost, because it is exactly the kind of envelope key the two
 * projection layers drop:
 *
 *   - the slim projectors rebuild their output from a fixed allowlist, and
 *   - `--fields` is a strict allowlist by definition.
 *
 * So the guarantee is asserted THROUGH `renderSuccess` with a slim projector
 * and with `--fields` in play, never against the helper in isolation: a test
 * that called the preserver directly would pass while the shipped path
 * silently dropped the envelope, which is the failure this file exists to
 * catch. Same argument, and the same seam, as `notices-survive-projection`.
 */
import { describe, it, expect, vi } from "vitest";
import { renderSuccess, renderProvenanceNote } from "../../src/lib/output.js";

const OBSERVED = "2026-09-05T10:00:00.000Z";

/** A served profile response as the server actually shapes it. */
function storeServed(extra: Record<string, unknown> = {}) {
  return {
    id: "ACoAAA_x",
    first_name: "Ada",
    description: "Engineer",
    source: "store",
    observed_at: OBSERVED,
    withdrawn: false,
    ...extra,
  };
}

/** A slim projector of the shape the real ones have: a fixed allowlist. */
const slimAllowlist = (data: unknown) => {
  const d = data as Record<string, unknown>;
  return { provider_id: d["id"] ?? null, first_name: d["first_name"] ?? null };
};

function makeOut() {
  return { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
}

function stdoutJson(out: ReturnType<typeof makeOut>): Record<string, unknown> {
  const written = out.stdout.write.mock.calls.map((c) => c[0] as string).join("");
  return JSON.parse(written) as Record<string, unknown>;
}

describe("provenance survives the slim projection", () => {
  it("keeps source/observed_at/withdrawn through a fixed-allowlist slim projector", () => {
    const out = makeOut();
    renderSuccess(storeServed(), { json: true, isTTY: false, slim: slimAllowlist }, out);
    const json = stdoutJson(out);

    expect(json["source"]).toBe("store");
    expect(json["observed_at"]).toBe(OBSERVED);
    expect(json["withdrawn"]).toBe(false);
    // CONTROL on the projector: it really did strip, so "survived" is a
    // statement about the preservation and not about a projector that no-ops.
    expect(json["description"]).toBeUndefined();
    expect(json["provider_id"]).toBe("ACoAAA_x");
  });

  it("keeps them through --fields, which is a strict allowlist", () => {
    const out = makeOut();
    renderSuccess(
      storeServed(),
      { json: true, isTTY: false, fields: "first_name" },
      out,
    );
    const json = stdoutJson(out);

    expect(json["source"]).toBe("store");
    expect(json["observed_at"]).toBe(OBSERVED);
    // CONTROL: --fields really did project down to the one key.
    expect(json["first_name"]).toBe("Ada");
    expect(json["id"]).toBeUndefined();
  });

  it("carries withdrawn_at when the platform says the resource is gone", () => {
    const out = makeOut();
    renderSuccess(
      storeServed({ withdrawn: true, withdrawn_at: OBSERVED }),
      { json: true, isTTY: false, slim: slimAllowlist },
      out,
    );
    const json = stdoutJson(out);
    expect(json["withdrawn"]).toBe(true);
    expect(json["withdrawn_at"]).toBe(OBSERVED);
  });

  // ABSENCE ARM + its positive control: a response with no envelope must render
  // byte-identically to how it always has, so nothing is invented.
  it("adds nothing to a response that carries no envelope", () => {
    const out = makeOut();
    renderSuccess({ id: "x", first_name: "Ada" }, { json: true, isTTY: false, slim: slimAllowlist }, out);
    const json = stdoutJson(out);
    expect(Object.keys(json).sort()).toEqual(["first_name", "provider_id"]);
  });

  it("positive control: the same call WITH an envelope does add the keys", () => {
    const out = makeOut();
    renderSuccess(storeServed(), { json: true, isTTY: false, slim: slimAllowlist }, out);
    expect(Object.keys(stdoutJson(out))).toContain("source");
  });

  // A listing envelope: the fields sit beside `items`, not inside them.
  it("keeps the envelope on a paginated listing", () => {
    const out = makeOut();
    renderSuccess(
      { items: [{ id: "m1", text: "hi" }], cursor: null, source: "store", observed_at: OBSERVED, withdrawn: false },
      { json: true, isTTY: false, fields: "id" },
      out,
    );
    const json = stdoutJson(out);
    expect(json["source"]).toBe("store");
    expect(json["observed_at"]).toBe(OBSERVED);
  });
});

describe("--fields does not warn about the envelope keys it does receive", () => {
  // `detectUnknownFields` runs over the SLIM output, which by construction
  // never carries the envelope — it is reattached afterwards. Checking there
  // makes the README's own documented invocation scold the caller for asking
  // for two fields it then delivers, and an agent branching on stderr sees a
  // warning contradicted by the payload.
  it("stays silent for --fields first_name,source,observed_at", () => {
    const out = makeOut();
    renderSuccess(
      storeServed(),
      { json: true, isTTY: false, fields: "first_name,source,observed_at", slim: slimAllowlist },
      out,
    );
    const err = out.stderr.write.mock.calls.map((c) => c[0] as string).join("");
    expect(err).not.toContain("--fields not present");
    // CONTROL on the delivery: the keys really are on the payload, so
    // "no warning" is correct rather than merely quiet.
    const json = stdoutJson(out);
    expect(json["source"]).toBe("store");
    expect(json["observed_at"]).toBe(OBSERVED);
  });

  // CONTROL on the warning itself: a genuinely absent field still warns, so
  // the silence above is about the envelope and not a disabled warning.
  it("control: a genuinely unknown field still warns", () => {
    const out = makeOut();
    renderSuccess(storeServed(), { json: true, isTTY: false, fields: "not_a_field", slim: slimAllowlist }, out);
    const err = out.stderr.write.mock.calls.map((c) => c[0] as string).join("");
    expect(err).toContain("--fields not present");
  });
});

describe("renderProvenanceNote — the one-line human-mode note", () => {
  it("names the source and the observation time", () => {
    const note = renderProvenanceNote(storeServed());
    expect(note).toContain("source=store");
    expect(note).toContain(`observed_at=${OBSERVED}`);
    // One line, so a scripted caller can grep it without a multiline mode.
    expect(note?.split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("reports a live fetch distinguishably from a served copy", () => {
    const live = renderProvenanceNote({ source: "live", observed_at: OBSERVED, withdrawn: false });
    expect(live).toContain("source=live");
    expect(live).not.toContain("source=store");
  });

  it("flags a withdrawn resource, because the copy outlived the original", () => {
    const note = renderProvenanceNote(storeServed({ withdrawn: true, withdrawn_at: OBSERVED }));
    expect(note).toContain("withdrawn");
  });

  it("stays silent on withdrawn=false rather than printing a non-event", () => {
    expect(renderProvenanceNote(storeServed())).not.toContain("withdrawn");
  });

  it.each([
    ["no envelope", { id: "x" }],
    ["a null body", null],
    ["a primitive", 42],
    ["an array", [1, 2]],
    ["source present but not a known value", { source: "guessed", observed_at: OBSERVED }],
  ])("returns null for %s", (_label, data) => {
    expect(renderProvenanceNote(data)).toBeNull();
  });
});

describe("renderSuccess — where the note goes", () => {
  it("writes the note to stderr in human mode", () => {
    const out = makeOut();
    renderSuccess(storeServed(), { json: false, isTTY: true, slim: slimAllowlist }, out);

    const err = out.stderr.write.mock.calls.map((c) => c[0] as string).join("");
    expect(err).toContain("source=store");
  });

  // The note is the DIAGNOSTICS copy, not a move: the keys stay on the body in
  // human mode too, so `--fields source` works there and the two modes agree
  // on the payload. Asserted explicitly because the obvious negative
  // ("stdout has no source=store") is an instrument that cannot fail —
  // renderHuman writes `source: store`, with a colon, so the `=` form never
  // appears on stdout no matter what the code does.
  it("keeps the keys on the human-mode body as well, in renderHuman's spelling", () => {
    const out = makeOut();
    renderSuccess(storeServed(), { json: false, isTTY: true, slim: slimAllowlist }, out);
    const stdout = out.stdout.write.mock.calls.map((c) => c[0] as string).join("");
    expect(stdout).toMatch(/source[:=]\s*store/);
    expect(stdout).toMatch(/observed_at[:=]/);
  });

  it("does NOT write the note in --json mode (the fields are in the payload)", () => {
    const out = makeOut();
    renderSuccess(storeServed(), { json: true, isTTY: false, slim: slimAllowlist }, out);
    const err = out.stderr.write.mock.calls.map((c) => c[0] as string).join("");
    expect(err).not.toContain("source=");
  });

  it("writes no note in human mode when the response has no envelope", () => {
    const out = makeOut();
    renderSuccess({ id: "x" }, { json: false, isTTY: true, slim: slimAllowlist }, out);
    const err = out.stderr.write.mock.calls.map((c) => c[0] as string).join("");
    expect(err).not.toContain("source=");
  });
});

/**
 * `--all` never reaches `renderSuccess`: it writes raw items as NDJSON. So the
 * envelope, which sits on the PAGE beside `items`, has no route to the caller
 * on the highest-volume read path unless the streamer surfaces it — exactly
 * the argument that already puts per-page `notices` on stderr there.
 *
 * Without this, `inbox messages --all --mode refill` tells a caller nothing
 * about whether the pages it just consumed were served or fetched, which is
 * the single fact the flag exists to expose.
 */
describe("--all surfaces each page's provenance on stderr", () => {
  it("writes a provenance note per page, keeping stdout pure NDJSON", async () => {
    const { streamAll } = await import("../../src/lib/paginate.js");
    const out = makeOut();
    const pages = [
      { items: [{ id: "m1" }], cursor: "c2", source: "store", observed_at: OBSERVED, withdrawn: false },
      { items: [{ id: "m2" }], cursor: null, source: "live", observed_at: OBSERVED, withdrawn: false },
    ];
    let i = 0;
    const fn = async () => pages[i++]!;

    const seen: unknown[] = [];
    for await (const item of streamAll(fn, {}, { out, maxPages: 5, pageDelayMs: 0 })) {
      seen.push(item);
    }

    const err = out.stderr.write.mock.calls.map((c) => c[0] as string).join("");
    expect(err).toContain("source=store");
    expect(err).toContain("source=live");
    // CONTROL: the items really did stream, so the stderr assertions are not
    // about a loop that never ran.
    expect(seen).toHaveLength(2);
    const stdout = out.stdout.write.mock.calls.map((c) => c[0] as string).join("");
    expect(stdout).not.toContain("source=");
  });

  it("writes nothing extra for pages that carry no envelope", async () => {
    const { streamAll } = await import("../../src/lib/paginate.js");
    const out = makeOut();
    const pages = [{ items: [{ id: "m1" }], cursor: null }];
    let i = 0;
    const fn = async () => pages[i++]!;
    for await (const _item of streamAll(fn, {}, { out, maxPages: 5, pageDelayMs: 0 })) {
      void _item;
    }
    const err = out.stderr.write.mock.calls.map((c) => c[0] as string).join("");
    expect(err).not.toContain("provenance:");
  });
});
