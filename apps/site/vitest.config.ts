import { defineProject } from "vitest/config";

export default defineProject({
  // Workspace packages (@glideworth/core) resolve to their TypeScript source, as in the site build.
  resolve: { conditions: ["@glideworth/source"] },
  ssr: { resolve: { conditions: ["@glideworth/source"] } },
  test: {
    name: "site",
    include: ["src/**/*.test.ts"],
    environment: "node",
    // The calculator tests run the real engine (Monte Carlo, long horizons): a few seconds each on a busy
    // machine, which the 5 s default kept failing in full parallel runs.
    testTimeout: 30_000,
  },
});
