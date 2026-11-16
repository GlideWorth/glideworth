/**
 * `@glideworth/cloud/server` (spec 8.3, 9 step 21): the cloud-mode boot `apps/api` loads with a dynamic import.
 *
 *   const { start } = await import('@glideworth/cloud/server');
 *   await start({ env: process.env, host });   // host = apps/api's CloudHost
 *
 * It builds every service from the environment (runtime.ts), finishes interrupted deletions, serves the public
 * app the host builds around `tenantAuth` and `registerCloudRoutes`, serves the operator console on the private
 * listener only (`GLIDEWORTH_OPS_LISTEN`), and runs the cell's periodic work: scheduler, outbox, backups,
 * restore test, retention, billing sweep, idle eviction, maintenance, operator commands from the CLI.
 */
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { beat, CommandWorker, clearBeat, HEARTBEAT_MS } from "./commands.js";
import { isCloudRoute, type SupportView } from "./http/kit.js";
import { registerCloudRoutes } from "./http/routes/index.js";
import { type CredentialVerifiers, type TenantVars, tenantAuth } from "./http/tenant-auth.js";
import type { Logger } from "./log/index.js";
import { createOpsApp } from "./ops/app.js";
import { type CloudRuntime, createCloudRuntime, type OpenerContext } from "./runtime.js";
import type { TenantOpener, TenantRuntimeBase } from "./types.js";

export { type CliHost, type CliIo, runCli } from "./cli/main.js";
export { CommandWorker, runCommand } from "./commands.js";
export { type CloudRuntime, createCloudRuntime, type OpenerContext } from "./runtime.js";

/** What `apps/api` provides in cloud mode. */
export interface CloudHost<R extends TenantRuntimeBase, P> {
  createOpener(ctx: OpenerContext): TenantOpener<R>;
  verifiers: CredentialVerifiers<R, P>;
  /** `services.checkins.tick()` for one workspace; returns its next due time. */
  runDue(r: R): Promise<{ nextRunAt: string | null }>;
  /**
   * The public app (`createCloudApp`): put `cloud.tenantAuth('api')` on `/api/*` except `cloud.isCloudRoute`
   * paths and public share/OAuth routes, `cloud.tenantAuth('mcp')` on `/mcp`, and call `cloud.registerRoutes(app)`.
   */
  createApp(cloud: CloudAppContext<R, P>): {
    fetch: (req: Request, ...rest: never[]) => Response | Promise<Response>;
  };
  supportView?: (r: R) => Promise<SupportView> | SupportView;
  /**
   * The host's own periodic work (apps/api: the retention sweep), run by `start()` with
   * the cell's other timers, each guarded the same way, and stopped on close.
   */
  timers?: (
    runtime: CloudRuntime<R>,
  ) => Array<{ name: string; ms: number; run(): Promise<unknown> | unknown }>;
}

export interface CloudAppContext<R extends TenantRuntimeBase, P> {
  runtime: CloudRuntime<R>;
  tenantAuth(mode: "api" | "mcp"): MiddlewareHandler<{ Variables: TenantVars<R, P> }>;
  // oxlint-disable-next-line typescript/no-explicit-any -- the host's app carries its own Env.
  registerRoutes(app: OpenAPIHono<any>): void;
  isCloudRoute(path: string): boolean;
}

export interface Started<R extends TenantRuntimeBase> {
  runtime: CloudRuntime<R>;
  publicAddress: AddressInfo;
  opsAddress: AddressInfo;
  close(): Promise<void>;
}

type Server = ReturnType<typeof serve>;

function listen(
  fetch: (req: Request, ...rest: never[]) => Response | Promise<Response>,
  hostname: string,
  port: number,
): Promise<{ server: Server; address: AddressInfo }> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: fetch as never, hostname, port }, (info) =>
      resolve({ server, address: info }),
    );
    server.once("error", reject);
  });
}

const closeServer = (s: Server) =>
  new Promise<void>((r) => {
    s.close(() => r());
    (s as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  });

/** Periodic work, each guarded so one failure never stops the others. */
function every(
  log: Logger,
  name: string,
  ms: number,
  fn: () => Promise<unknown> | unknown,
): () => void {
  let busy = false;
  const t = setInterval(() => {
    if (busy) return;
    busy = true;
    Promise.resolve()
      .then(fn)
      .catch((err: unknown) => log.error("cloud.task_failed", { kind: name, err }))
      .finally(() => {
        busy = false;
      });
  }, ms);
  t.unref?.();
  return () => clearInterval(t);
}

export async function start<R extends TenantRuntimeBase, P>(o: {
  env?: NodeJS.ProcessEnv;
  host: CloudHost<R, P>;
  /** Tests: listen addresses (default `GLIDEWORTH_HOST`/`GLIDEWORTH_API_PORT`, ops from the config). */
  listen?: { host?: string; port?: number; opsPort?: number };
  timers?: boolean;
  handleSignals?: boolean;
  overrides?: Parameters<typeof createCloudRuntime<R>>[0]["overrides"];
  /** The logger (tests use a capturing sink; default from `GLIDEWORTH_LOG_LEVEL`). */
  log?: Logger;
}): Promise<Started<R>> {
  const env = o.env ?? process.env;
  const runtime = await createCloudRuntime<R>({
    env,
    ...(o.log ? { log: o.log } : {}),
    createOpener: (ctx) => o.host.createOpener(ctx),
    runDue: (r) => o.host.runDue(r),
    ...(o.host.supportView ? { supportView: o.host.supportView } : {}),
    ...(o.overrides ? { overrides: o.overrides } : {}),
  });
  const { log } = runtime;
  const resumed = await runtime.workspaces.resumeLifecycle();
  if (resumed.completed || resumed.failed)
    log.warn("cloud.lifecycle_resumed", { count: resumed.completed, remaining: resumed.failed });

  const cloud: CloudAppContext<R, P> = {
    runtime,
    tenantAuth: (mode) =>
      tenantAuth<R, P>({
        accounts: runtime.accounts,
        workspaces: runtime.workspaces,
        registry: runtime.registry,
        entitlements: runtime.entitlements,
        quotas: runtime.quotas,
        verifiers: o.host.verifiers,
        publicUrl: runtime.config.publicUrl,
        mode,
      }),
    registerRoutes: (app) => registerCloudRoutes(app, runtime.http),
    isCloudRoute,
  };
  const app = o.host.createApp(cloud);
  const pub = await listen(
    app.fetch,
    o.listen?.host ?? env.GLIDEWORTH_HOST ?? "0.0.0.0",
    o.listen?.port ?? Number(env.GLIDEWORTH_API_PORT ?? 8787),
  );

  let opsBound: { port: number; address: string } | null = null;
  const opsApp = createOpsApp(runtime.http, { boundTo: () => opsBound });
  const ops = await listen(
    opsApp.fetch,
    runtime.config.opsListen.host,
    o.listen?.opsPort ?? runtime.config.opsListen.port,
  );
  opsBound = { port: ops.address.port, address: ops.address.address };
  log.info("cloud.listening", { port: pub.address.port });
  log.info("cloud.ops_listening", { port: ops.address.port });

  const stops: Array<() => void> = [];
  const worker = new CommandWorker(runtime, log);
  if (o.timers !== false) {
    runtime.scheduler.start();
    beat(runtime.db);
    const r = runtime;
    stops.push(
      every(log, "heartbeat", HEARTBEAT_MS, () => beat(r.db)),
      every(log, "commands", 2_000, () => worker.poll()),
      every(log, "outbox", 30_000, () => r.outbox.drain()),
      every(log, "evict", 60_000, () => r.registry.evictIdle()),
      every(log, "billing_sweep", 5 * 60_000, () => r.billing.sweep()),
      every(log, "lifecycle", 5 * 60_000, () => r.workspaces.resumeLifecycle()),
      every(log, "exports", 10 * 60_000, () => r.workspaces.sweepExports()),
      every(log, "backup_control", 5 * 60_000, () => r.backups.backupControl()),
      every(log, "backup_tenants", 15 * 60_000, () => r.backups.sweep()),
      every(log, "backup_prune", 60 * 60_000, () => r.backups.prune()),
      every(log, "restore_test", 24 * 60 * 60_000, () => r.backups.verifySample(5)),
      every(log, "maintenance", 60 * 60_000, () => {
        r.accounts.maintenance();
        r.audit.scrub();
        r.quotas.prune();
        r.outbox.prune();
      }),
    );
    for (const t of o.host.timers?.(runtime) ?? []) stops.push(every(log, t.name, t.ms, t.run));
  }

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const s of stops) s();
    runtime.scheduler.stop();
    await Promise.all([closeServer(pub.server), closeServer(ops.server)]);
    await runtime.scheduler.idle();
    await runtime.registry.shutdown();
    clearBeat(runtime.db);
    runtime.closeDb();
  };
  if (o.handleSignals !== false)
    for (const sig of ["SIGINT", "SIGTERM"] as const)
      process.once(sig, () => {
        void close().finally(() => process.exit(0));
      });
  return { runtime, publicAddress: pub.address, opsAddress: ops.address, close };
}
