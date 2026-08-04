import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Builds dist/cli.js once before any worker starts, so the suites that
    // spawn the real bin never race each other rebuilding it, and never assert
    // against an artifact older than the source they are meant to cover.
    globalSetup: ["test/global-setup.ts"],
  },
});
