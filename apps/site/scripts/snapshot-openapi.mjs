/**
 * Writes src/data/openapi.json: a snapshot of the OpenAPI 3.1 document that apps/api generates from its
 * route definitions (the same document every running server serves at /openapi.json). The site's API
 * reference page (/docs/api-and-mcp/api-reference/) is built from this file, so the build needs no
 * database, server or network.
 *
 *   pnpm --filter @glideworth/site snapshot:openapi      (or: node scripts/snapshot-openapi.mjs)
 *
 * Run it when the API changes and commit the result. The script starts the API app in memory with
 * `tsx --conditions=@glideworth/source` (tsx is a dependency of apps/api), asks it for /openapi.json and
 * writes the document. src/lib/facts.ts counts the self-host operations from this file, so there is no
 * number to copy by hand; apps/api/test/openapi.test.ts fails when the snapshot's count is out of date.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(here, "..");
const apiRoot = join(siteRoot, "..", "api");
const out = join(siteRoot, "src", "data", "openapi.json");
const METHODS = ["get", "post", "put", "patch", "delete"];

if (!process.env.GLIDEWORTH_SNAPSHOT_CHILD) {
  // Parent: re-run this file under the API's own tsx so its TypeScript source and workspace
  // dependencies resolve exactly as they do in the API's tests.
  const tsx = join(apiRoot, "node_modules", ".bin", "tsx");
  const result = spawnSync(
    tsx,
    ["--conditions=@glideworth/source", fileURLToPath(import.meta.url)],
    {
      cwd: apiRoot,
      stdio: "inherit",
      env: { ...process.env, GLIDEWORTH_SNAPSHOT_CHILD: "1" },
    },
  );
  if (result.error) {
    console.error(
      `Could not start tsx (${tsx}): ${result.error.message}. Run \`pnpm install\` first.`,
    );
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

const { createApp } = await import(pathToFileURL(join(apiRoot, "src", "app.ts")).href);
const { openDb } = await import(pathToFileURL(join(apiRoot, "src", "db", "client.ts")).href);

const ctx = openDb(":memory:");
let doc;
try {
  const app = createApp({ db: ctx.db, rateLimitPerMinute: 0 });
  const res = await app.request("/openapi.json");
  if (res.status !== 200) throw new Error(`/openapi.json answered ${res.status}`);
  doc = await res.json();
} finally {
  ctx.close();
}

const operations = Object.values(doc.paths).reduce(
  (n, item) => n + Object.keys(item).filter((m) => METHODS.includes(m)).length,
  0,
);
writeFileSync(out, `${JSON.stringify(doc, null, 1)}\n`);
console.log(
  `Wrote ${out}: OpenAPI ${doc.openapi}, ${operations} operations, ${Object.keys(doc.paths).length} paths.`,
);
