/** `login`: --base-url persistence and the `--api-key -` stdin contract, through the CLI entry point. */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STDIN_SENTINEL } from "../../src/lib/stdin.js";
import { useSink } from "../helpers/sink.js";
import { configHome } from "../helpers/run-inproc.js";

const sink = useSink({ body: { object: "list", items: [], cursor: null } });
// no CURVIATE_API_KEY: the stored profile must be what authenticates
const env = { CURVIATE_API_KEY: undefined, CURVIATE_BASE_URL: undefined };
let xdg: string;
const config = () => JSON.parse(readFileSync(join(xdg, "curviate", "config.json"), "utf8")) as { profiles: Record<string, { apiKey?: string; baseUrl?: string }> };
beforeEach(() => {
  xdg = configHome();
});

describe("login --base-url", () => {
  it("is persisted with the key, and a re-login without it keeps the stored base URL", async () => {
    await sink.run(["login", "--api-key", "rdc_live_X", "--base-url", "https://custom.api.example.com"], { xdg, env });
    expect(config().profiles["default"]).toMatchObject({ apiKey: "rdc_live_X", baseUrl: "https://custom.api.example.com" });
    await sink.run(["login", "--api-key", "rdc_live_Y"], { xdg, env });
    expect(config().profiles["default"]).toMatchObject({ apiKey: "rdc_live_Y", baseUrl: "https://custom.api.example.com" });
  });

  it("--base-url '' exits 2 naming the flag and writes no config", async () => {
    const r = await sink.run(["login", "--api-key", "rdc_live_Z", "--base-url", ""], { xdg, env });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--base-url.*empty/i);
    expect(() => config()).toThrow();
  });
});

describe("login --api-key -", () => {
  const KEY = "cvt_live_REALVALUE";

  it("persists the piped key verbatim, never the stdin sentinel, and the next command sends it as the Bearer token", async () => {
    const login = await sink.run(["login", "--api-key", "-", "--profile", "t"], { xdg, env, stdin: KEY });
    expect(login.status, login.stderr).toBe(0);
    expect(config().profiles["t"]?.apiKey).toBe(KEY); // asserting "a key was written" alone passes on the sentinel defect
    expect(config().profiles["t"]?.apiKey).not.toBe(STDIN_SENTINEL);
    const next = await sink.run(["account", "list", "--profile", "t", "--base-url", sink.url, "--json"], { xdg, env });
    expect(next.status).toBe(0);
    expect(next.requests.map((q) => q.headers.authorization)).toEqual([`Bearer ${KEY}`]);
  });
});

describe("a config already holding the placeholder as a key", () => {
  it("does not block a write to another profile; the stale key is gone and the other profiles stay", async () => {
    mkdirSync(join(xdg, "curviate"), { recursive: true });
    writeFileSync(join(xdg, "curviate", "config.json"), JSON.stringify({ active: "work", profiles: { work: { apiKey: "rdc_live_W" }, default: { apiKey: STDIN_SENTINEL } } }));
    const r = await sink.run(["login", "--api-key", "rdc_live_N", "--profile", "other"], { xdg, env });
    expect(r.status, r.stderr).toBe(0);
    expect(config().profiles["other"]).toMatchObject({ apiKey: "rdc_live_N" });
    expect(config().profiles["work"]).toMatchObject({ apiKey: "rdc_live_W" });
    expect(config().profiles["default"]).not.toHaveProperty("apiKey");
  });
});
