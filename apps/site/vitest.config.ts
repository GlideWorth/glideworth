import { defineProject } from "vitest/config";

export default defineProject({
  // Workspace packages (@glideworth/core) resolve to their TypeScript source, as in the site build.
  resolve: { conditions: ["@glideworth/source"] },
  ssr: { resolve: { conditions: ["@glideworth/source"] } },
  test: { name: "site", include: ["src/**/*.test.ts"], environment: "node" },
});
