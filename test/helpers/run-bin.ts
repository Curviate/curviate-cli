/**
 * Spawn the built bin synchronously against an isolated config home, with no
 * credential env leaking in from the developer's shell. For runs that need no
 * in-process stub server (spawnSync blocks the event loop).
 */

import { spawnSync } from "node:child_process";
import { cliPath } from "./built-cli.js";

export function runBin(args: string[], xdgHome: string): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: xdgHome, NODE_ENV: "production" };
  delete env["CURVIATE_API_KEY"];
  delete env["CURVIATE_ACCOUNT"];
  delete env["CURVIATE_BASE_URL"];
  const r = spawnSync(process.execPath, [cliPath, ...args], { env, encoding: "utf8", input: "" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
