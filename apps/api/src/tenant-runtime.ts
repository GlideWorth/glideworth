/**
 * Cloud mode: one workspace ("tenant") = one SQLite file = one `TenantRuntime` (design 2.1-2.6, INTEGRATION.md
 * step 16). The runtime is the existing `Services` over that file, with the workspace's policy wired into the
 * hooks the services expose (job admission and limits, the fair thread gate, webhook suppression and quotas,
 * routed credential formats, the global scheduler), the member mirror the control plane keeps in step, and the
 * `busy()`/`close()` the registry needs to evict it safely.
 *
 * Loaded only in cloud mode (by `cloud-host.ts`), so it may import `@glideworth/cloud`.
 */
import {
  API_KEY_RE,
  mintApiKey,
  mintRouted,
  parseRouted,
  type Role,
  type TenantMemberPort,
  type TenantOpener,
  type TenantRuntimeBase,
  tenantPragmas,
} from "@glideworth/cloud";
import type { OpenerContext } from "@glideworth/cloud/server";
import type { KeyFormat } from "./auth.js";
import { type Db, migrationCount, openDb } from "./db/client.js";
import type { CoreDeps } from "./deps.js";
import type { JobExecutor } from "./jobs/executor.js";
import type { ClientStore, TokenFormat } from "./services/oauth.js";
import { Services } from "./services.js";

/** Heap limit of one job thread in cloud mode (MiB). */
const CLOUD_WORKER_MAX_MB = 1024;
/** How long `close()` waits for running jobs before stopping them (design 2.3). */
const CLOSE_DRAIN_MS = 30_000;

/** `gwk_<account>_<8>_<secret>`, recognised only for this workspace (defence in depth: the hash covers it too). */
export function cloudKeyFormat(accountId: string): KeyFormat {
  return {
    generate: () => mintApiKey(accountId),
    prefixOf(key) {
      if (!API_KEY_RE.test(key)) return null;
      const r = parseRouted(key);
      if (!r || r.kind !== "key" || r.accountId !== accountId) return null;
      return key.split("_")[2] ?? null;
    },
    example: "gwk_<workspace>_<8 base32>_<secret>",
  };
}

/** Routed OAuth tokens (`gwa_`, `gwr_`, `gwc_`) naming this workspace. */
function cloudTokenFormat(accountId: string): TokenFormat {
  return {
    access: () => mintRouted("oauth_access", accountId),
    refresh: () => mintRouted("oauth_refresh", accountId),
    code: () => mintRouted("oauth_code", accountId),
    isAccess(token) {
      const r = parseRouted(token);
      return !!r && r.kind === "oauth_access" && r.accountId === accountId;
    },
  };
}

/** The Monte Carlo trial count a job would run, for the plan's trial limit (spec 6.1). */
function trialsOf(
  params: unknown,
  input: { plan?: { monteCarlo?: { trials?: unknown } } } | undefined,
): number | undefined {
  const p = (params ?? {}) as {
    settings?: { trials?: unknown };
    monteCarlo?: { trials?: unknown };
    request?: { monteCarlo?: { trials?: unknown } };
  };
  const found = [
    p.settings?.trials,
    p.monteCarlo?.trials,
    p.request?.monteCarlo?.trials,
    input?.plan?.monteCarlo?.trials,
  ].filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  return found.length ? Math.max(...found) : undefined;
}

export interface CheckinRunSummary {
  at: string;
  plansChecked: number;
  changeKinds: Array<"success-rate-change" | "milestone-slipped" | "audit-finding" | "behind-plan">;
}

export class TenantRuntime implements TenantRuntimeBase {
  readonly members: TenantMemberPort;
  private streams = 0;
  private closing: Promise<void> | null = null;
  /** The last scheduled check-in (counts and change kinds only), for the check-in email. */
  lastCheckin: CheckinRunSummary | null = null;

  constructor(
    readonly accountId: string,
    readonly db: Db,
    readonly services: Services,
    private readonly closeDb: () => void,
  ) {
    const users = services.users;
    this.members = {
      upsert: (m) => users.upsertMember(m),
      remove: (id) => users.removeMember(id),
      list: () => users.listMembers() as Array<{ tenantUserId: string; role: Role; name: string }>,
      revokeCredentials: (id) => users.revokeCredentials(id),
      revokeOAuthGrants: (id) => services.oauth.revokeAllOf(id),
    };
  }

  /** A streaming response (job SSE) holds the runtime open until it ends. */
  holdStream(): () => void {
    this.streams++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.streams--;
    };
  }

  busy(): boolean {
    return (
      this.streams > 0 ||
      this.services.jobs.busy() ||
      this.services.webhooks.busy() ||
      this.services.imports.busy()
    );
  }

  /** Stop accepting jobs, cancel queued ones, wait for running ones (30 s), flush webhooks, close the file. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.services.checkins.stop();
      await this.services.jobs.close(CLOSE_DRAIN_MS);
      await this.services.webhooks.flush();
      await this.services.checkins.idle();
      this.closeDb();
    })();
    return this.closing;
  }
}

export interface OpenerOptions {
  /** Tests: run jobs in-process (default: worker threads through the fair gate). */
  executor?: JobExecutor;
  deps?: CoreDeps;
  /** The control-plane OAuth client registry (bound once the cloud runtime exists). */
  oauthClients: () => ClientStore | null;
  /** Webhook HTTP client (tests). Private addresses are always refused in cloud mode. */
  fetch?: typeof fetch;
  webhookRetryDelaysMs?: number[];
}

/** INTEGRATION.md step 16. */
export function createTenantOpener(
  ctx: OpenerContext,
  o: OpenerOptions,
): TenantOpener<TenantRuntime> {
  return {
    schemaVersion: migrationCount(),
    open(accountId, dbPath, limits) {
      // Pragmas (storage limit among them) before migrating; throws, file unchanged, if a migration fails.
      const { db, close } = openDb(dbPath, { pragmas: tenantPragmas(limits) });
      try {
        const policy = ctx.policy(accountId);
        let runtime: TenantRuntime | null = null;
        const clients = o.oauthClients;
        const lazyClients: ClientStore = {
          register: (c, ip) => {
            const s = clients();
            if (!s) throw new Error("no OAuth client registry in this process");
            s.register(c, ip);
          },
          get: (id) => clients()?.get(id) ?? null,
          markConsented: (id) => clients()?.markConsented(id),
        };
        const services = new Services(db, {
          ...(o.deps ? { deps: o.deps } : {}),
          ...(o.executor ? { executor: o.executor } : {}),
          sharding: {
            maxOldGenerationSizeMb: CLOUD_WORKER_MAX_MB,
            acquireThread: () => ctx.threadGate.acquire(accountId),
            onThreadMs: (ms) => policy.recordWorkerMs(ms),
          },
          jobs: {
            admit: (kind, params, input) => {
              const trials = trialsOf(params, input);
              policy.admitJob(kind, trials === undefined ? {} : { trials });
            },
            limits: () => policy.jobLimits(),
            maxJobMs: () => policy.maxJobMs(),
          },
          webhooks: {
            allowPrivate: false,
            // Security review finding 14: encrypted deliveries only, no well-known service ports.
            httpsOnly: true,
            maxSubscriptions: () => policy.maxWebhooks(),
            suppressed: () => policy.webhooksSuppressed(),
            admitDelivery: () => policy.admitWebhookDelivery(),
            workspaceId: accountId,
            ...(o.fetch ? { fetch: o.fetch } : {}),
            ...(o.webhookRetryDelaysMs ? { retryDelaysMs: o.webhookRetryDelaysMs } : {}),
          },
          keys: {
            format: cloudKeyFormat(accountId),
            maxActive: () => policy.maxApiKeys(),
            guardLastWriteKey: false,
          },
          oauth: { clients: lazyClients, tokens: cloudTokenFormat(accountId) },
          shares: {
            mintToken: () => mintRouted("share", accountId),
            maxActive: () => policy.maxShareLinks(),
          },
          checkins: {
            onConfigChanged: (next) => ctx.scheduleChanged(accountId, next),
            onRun: (r) => {
              if (runtime && r.trigger === "scheduled")
                runtime.lastCheckin = {
                  at: new Date().toISOString(),
                  plansChecked: r.plansChecked,
                  changeKinds: r.changeKinds,
                };
            },
          },
        });
        services.jobs.recoverInterrupted();
        runtime = new TenantRuntime(accountId, db, services, close);
        return runtime;
      } catch (err) {
        close();
        throw err;
      }
    },
  };
}
