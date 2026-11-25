// @vitest-environment node
/**
 * The API serves the widget from apps/api/src/mcp/widget-html.generated.ts. This fails when that file is stale
 * (the widget source changed without `pnpm --filter @glideworth/widgets build`) or over the size budget.
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("the committed widget bundle matches a fresh build", { timeout: 120_000 }, async () => {
  const script = fileURLToPath(new URL("../scripts/build.mjs", import.meta.url));
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const run = promisify(execFile)(process.execPath, [script, "--check"], { cwd });
  await expect(run).resolves.toMatchObject({ stdout: expect.stringContaining("up to date") });
});
