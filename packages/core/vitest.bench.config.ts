import { defineProject } from "vitest/config";

/**
 * Opt-in wall-clock benchmarks (`pnpm bench`). They are kept out of the default run because their
 * assertions depend on machine speed; correctness and determinism are covered in `test/`.
 */
export default defineProject({
  resolve: { conditions: ["@glideworth/source"] },
  test: {
    name: "core-bench",
    include: ["bench/**/*.bench.test.ts"],
    testTimeout: 120_000,
  },
});
