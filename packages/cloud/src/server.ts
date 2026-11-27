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
 * Jobs whose interval is long compared with how often the server restarts keep their schedule in the
 * control database (durable-jobs.ts), so a deploy does not postpone them.
 */
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { beat, CommandWorker, clearBeat, HEARTBEAT_MS } from "./commands.js";
import { pruneControlData } from "./control/retention.js";
import { cellHeartbeat } from "./control/schema.js";
import { type DurableJob, DurableJobs } from "./durable-jobs.js";
import { createPinger, LIVENESS_MS, type Ping } from "./heartbeat.js";
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

/** Jobs at least this far apart keep their schedule in the control database. */
const DURABLE_FROM_MS = 15 * 60_000;

/**
 * The cell's long-interval jobs (durable schedule) with their heartbeat pings. `controlOk` reports whether the
 * last control-database backup succeeded, so the backup heartbeat covers both kinds of backup.
 */
export function durableCellJobs<R extends TenantRuntimeBase>(
  r: CloudRuntime<R>,
  o: {
    ping: Ping;
    controlOk: () => boolean;
    hostTimers?: Array<{ name: string; ms: number; run(): Promise<unknown> | unknown }>;
  },
): DurableJob[] {
  return [
    {
      name: "backup_tenants",
      intervalMs: 15 * 60_000,
      run: async () => {
        const res = await r.backups.sweep();
        return {
          ok: res.failed.length === 0 && o.controlOk(),
          count: res.backedUp,
          failed: res.failed.length,
        };
      },
      onDone: (ok) => o.ping("backup", ok),
    },
    {
      name: "backup_prune",
      intervalMs: 60 * 60_000,
      run: async () => ({ ok: true, count: await r.backups.prune() }),
    },
    {
      name: "restore_test",
      intervalMs: 24 * 60 * 60_000,
      run: async () => {
        const res = await r.backups.verifySample(5);
        return { ok: res.failed.length === 0, count: res.verified, failed: res.failed.length };
      },
      onDone: (ok) => o.ping("restoreTest", ok),
    },
    {
      name: "maintenance",
      intervalMs: 60 * 60_000,
      run: async () => {
        r.accounts.maintenance();
        r.audit.scrub();
        r.quotas.prune();
        // The privacy policy's retention limits (control/retention.ts), in bounded batches.
        const res = await pruneControlData(r.db, { trialDays: r.pricing.trialDays });
        return { ok: true, count: res.total };
      },
    },
    ...(o.hostTimers ?? [])
      .filter((t) => t.ms >= DURABLE_FROM_MS)
      .map((t) => ({ name: t.name, intervalMs: t.ms, run: () => t.run() })),
  ];
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
  /** Tests: the HTTP client for heartbeat pings. */
  heartbeatFetch?: typeof fetch;
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
  let jobs: DurableJobs | null = null;
  if (o.timers !== false) {
    runtime.scheduler.start();
    beat(runtime.db);
    const r = runtime;
    const ping = createPinger(runtime.config.heartbeats, log, o.heartbeatFetch);
    let controlOk = true;
    const hostTimers = o.host.timers?.(runtime) ?? [];
    jobs = new DurableJobs({
      db: r.db,
      log,
      jobs: durableCellJobs(r, { ping, controlOk: () => controlOk, hostTimers }),
    });
    jobs.start();
    const live = () => {
      try {
        r.db.select({ id: cellHeartbeat.id }).from(cellHeartbeat).limit(1).all();
        ping("liveness", true);
      } catch (err) {
        ping("liveness", false);
        throw err;
      }
    };
    live();
    stops.push(
      every(log, "heartbeat", HEARTBEAT_MS, () => beat(r.db)),
      every(log, "liveness", LIVENESS_MS, live),
      every(log, "commands", 2_000, () => worker.poll()),
      every(log, "outbox", 30_000, () => r.outbox.drain()),
      every(log, "evict", 60_000, () => r.registry.evictIdle()),
      every(log, "billing_sweep", 5 * 60_000, () => r.billing.sweep()),
      every(log, "lifecycle", 5 * 60_000, () => r.workspaces.resumeLifecycle()),
      every(log, "exports", 10 * 60_000, () => r.workspaces.sweepExports()),
      every(log, "backup_control", 5 * 60_000, async () => {
        try {
          await r.backups.backupControl();
          controlOk = true;
        } catch (err) {
          controlOk = false;
          throw err;
        }
      }),
      () => jobs?.stop(),
    );
    for (const t of hostTimers)
      if (t.ms < DURABLE_FROM_MS) stops.push(every(log, t.name, t.ms, t.run));
  }

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const s of stops) s();
    runtime.scheduler.stop();
    await Promise.all([closeServer(pub.server), closeServer(ops.server)]);
    await runtime.scheduler.idle();
    // Let a running backup or restore test finish its database writes, for a bounded time.
    if (jobs) {
      let t: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([jobs.idle(), new Promise<void>((r) => (t = setTimeout(r, 15_000)))]);
      clearTimeout(t);
    }
    await runtime.registry.shutdown();
    clearBeat(runtime.db);
    runtime.closeDb();
    await Promise.all([
      runtime.errorReporter?.flush(),
      runtime.productEvents?.flush(),
      runtime.mcpAnalytics?.shutdown(),
    ]);
  };
  if (o.handleSignals !== false) {
    for (const sig of ["SIGINT", "SIGTERM"] as const)
      process.once(sig, () => {
        void close().finally(() => process.exit(0));
      });
    // Without these Node prints the error (message included) and exits 1. Same exit, but the error is logged
    // and reported through describeErrorForLog, and the report is given two seconds to leave.
    let crashing = false;
    const crash = (kind: string) => (err: unknown) => {
      if (crashing) return;
      crashing = true;
      log.error("process.crashed", { kind, err });
      void Promise.resolve(runtime.errorReporter?.flush(2_000)).finally(() => process.exit(1));
    };
    process.on("uncaughtException", crash("uncaught_exception"));
    process.on("unhandledRejection", crash("unhandled_rejection"));
  }
  return { runtime, publicAddress: pub.address, opsAddress: ops.address, close };
}
