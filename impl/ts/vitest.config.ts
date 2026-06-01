import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Registers the opt-in RE2 matcher for the `matches` operator before any
    // test runs, mirroring a fully-wired app (see test/setup.ts). `include`
    // excludes setup.ts from collection; the `pnpm conformance` path filter is
    // unaffected — setupFiles apply regardless of which paths are run.
    setupFiles: ["./test/setup.ts"],
    globals: false,
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/types/**"],
    },
  },
});
