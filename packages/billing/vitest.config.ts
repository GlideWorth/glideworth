import { defineProject } from "vitest/config";

export default defineProject({
  // `ssr.resolve.conditions` makes workspace packages resolve to their TS sources, not a stale dist.
  resolve: { conditions: ["@glideworth/source"] },
  ssr: { resolve: { conditions: ["@glideworth/source"] } },
  test: { name: "billing", include: ["test/**/*.test.ts"] },
});
