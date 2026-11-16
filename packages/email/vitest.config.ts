import { defineProject } from "vitest/config";

export default defineProject({
  resolve: { conditions: ["@glideworth/source"] },
  ssr: { resolve: { conditions: ["@glideworth/source"] } },
  test: { name: "email", include: ["test/**/*.test.ts"] },
});
