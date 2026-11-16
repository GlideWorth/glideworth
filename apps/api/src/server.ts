import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { ensureBootstrapKey } from "./auth.js";
import { authOptions, loadConfig, resolveMode, resolveWebDist } from "./config.js";
import { openDb } from "./db/client.js";
import { seedSampleIfEmpty } from "./seed.js";
import { Services } from "./services.js";
import { listenOrigin, setupTokenWarning } from "./startup.js";

/**
 * One image, two modes (design section 1). Cloud mode loads `@glideworth/cloud` (and with it billing, email and
 * Stripe) by dynamic import only; the self-host path below never imports them.
 */
if (resolveMode(process.env) === "cloud") {
  const { start } = await import("@glideworth/cloud/server");
  const { cloudHost } = await import("./cloud-host.js");
  // Listens on GLIDEWORTH_HOST:GLIDEWORTH_API_PORT and the operator console on GLIDEWORTH_OPS_LISTEN; handles
  // SIGINT/SIGTERM itself. Refuses to start (names only) on a missing or forbidden variable.
  await start({ env: process.env, host: cloudHost });
} else startSelfHost();

function startSelfHost(): void {
  const config = loadConfig();
  const { db, close } = openDb(config.dbPath);
  if (
    ensureBootstrapKey(db, config.bootstrapKey, { production: config.production }) ===
    "refused-example-key"
  )
    console.warn(
      "[glideworth] ignoring GLIDEWORTH_BOOTSTRAP_KEY: it is the example key from .env.example, which is public. " +
        "Create a real key with `pnpm keys:create` (or set a secret of your own).",
    );
  if (config.seedSample && seedSampleIfEmpty(db))
    console.log("[glideworth] seeded synthetic sample household");

  const services = new Services(db, {
    maxConcurrentJobs: config.maxConcurrentJobs,
    sharding: {
      ...(config.mcShards ? { maxShards: config.mcShards } : {}),
      maxOldGenerationSizeMb: config.workerMaxMb,
    },
    jobs: { maxJobMs: () => config.maxJobSeconds * 1000 },
    auth: authOptions(config),
    webhooks: { allowPrivate: config.webhookAllowPrivate },
  });
  const interrupted = services.jobs.recoverInterrupted();
  if (interrupted) console.log(`[glideworth] marked ${interrupted} interrupted job(s) as failed`);

  const webDist = resolveWebDist(config, dirname(fileURLToPath(import.meta.url)));
  const serveWeb = webDist && existsSync(join(webDist, "index.html")) ? webDist : undefined;
  if (webDist && !serveWeb)
    console.warn(
      `[glideworth] web app not found in ${webDist}: run \`pnpm build\` (serving the API only)`,
    );

  const app = createApp({
    db,
    services,
    webOrigin: config.webOrigin ?? null,
    maxBodyBytes: Math.round(config.maxBodyMb * 1024 * 1024),
    mcpAllowWrites: config.mcpAllowWrites,
    rateLimitPerMinute: config.rateLimitPerMinute,
    browserAuth: config.browserAuth,
    cookieSecure: config.cookieSecure === "auto" ? "auto" : config.cookieSecure === "true",
    trustProxy: config.trustProxy,
    webDist: serveWeb,
    publicUrl: config.publicUrl,
    shareRateLimitPerMinute: config.shareRateLimitPerMinute,
  });
  if (config.scheduler) services.checkins.start();
  const server = serve(
    { fetch: app.fetch, port: config.port, ...(config.host ? { hostname: config.host } : {}) },
    (info) => {
      const origin = listenOrigin(info);
      console.log(
        `[glideworth] ${config.production ? "production" : "dev"} server on ${origin}` +
          `${serveWeb ? `  web app: ${origin}/` : ""}  docs: /docs  openapi: /openapi.json  mcp: /mcp`,
      );
      if (config.browserAuth && !services.auth.isConfigured()) {
        console.log(`[glideworth] first run: open ${origin}/ to set the passphrase`);
        const warning = setupTokenWarning({
          production: config.production,
          setupToken: config.setupToken,
          address: info.address,
        });
        if (warning) console.warn(warning);
      }
    },
  );

  for (const sig of ["SIGINT", "SIGTERM"] as const)
    process.on(sig, () => {
      server.close();
      services.checkins.stop();
      void Promise.all([services.webhooks.flush(), services.checkins.idle()]).finally(() => {
        close();
        process.exit(0);
      });
    });
}
