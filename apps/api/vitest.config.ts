import { defineProject } from "vitest/config";

export default defineProject({
  resolve: { conditions: ["@glideworth/source"] },
  ssr: { resolve: { conditions: ["@glideworth/source"] } },
  test: {
    name: "api",
    include: ["test/**/*.test.ts"],
    environment: "node",
    // T-LOG: every test file logs into a capturing sink that is checked after the file.
    setupFiles: ["test/log-capture.setup.ts"],
  },
});
