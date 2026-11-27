/**
 * Not in spec 8.3 by name: builds every cloud service from the environment, once, for the server (`./server`)
 * and the CLI. Nothing here listens or starts timers; `start()` in server.ts does that.
 */
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  BillingService,
  createStripeClient,
  FakeStripeGateway,
  loadPricingConfig,
  type PricingConfig,
  type StripeGateway,
  stripeGateway,
  syncPricing,
} from "@glideworth/billing";
import {
  type Address,
  createMailer,
  type EmailTransport,
  fileTransport,
  hmacUnsubscribeSigner,
  type Mailer,
  mailgunTransport,
  resendTransport,
  smtpTransport,
} from "@glideworth/email";
import { type CaptchaVerifier, staticCaptcha, turnstileVerifier } from "./abuse/captcha.js";
import { memoryRateLimiter, type RateLimiter } from "./abuse/rate-limiter.js";
import { AccountsService } from "./accounts/service.js";
import { type ControlAudit, controlAudit } from "./audit.js";
import { fsObjectStore, s3ObjectStore } from "./backups/object-store.js";
import { BackupService } from "./backups/service.js";
import {
  billingAnalytics,
  billingLogBridge,
  billingNotifier,
  trackCheckoutSessions,
} from "./billing/glue.js";
import { type CloudConfig, loadCloudConfig } from "./config.js";
import { googleIssuers } from "./federation/google.js";
import { OidcClient } from "./federation/oidc.js";
import { FederationService } from "./federation/service.js";
import { controlBillingStore } from "./control/billing-store.js";
import { type ControlDb, openControlDb } from "./control/db.js";
import { controlEmailStores } from "./control/email-stores.js";
import { MailOutbox } from "./control/outbox.js";
import { deriveKey, type Keyring, keyring } from "./crypto/keyring.js";
import { createEntitlements } from "./entitlements.js";
import { CloudError } from "./errors.js";
import type { CloudHttpDeps, SupportView } from "./http/kit.js";
import { fairThreadGate } from "./jobs/fair-gate.js";
import { createPostHogErrorReporter, reportingLogger } from "./log/error-reporter.js";
import { createLogger, type ErrorReporter, type Logger, type LogLevel } from "./log/index.js";
import { createPostHogMcpAnalytics, type McpAnalytics } from "./log/mcp-analytics.js";
import { createPostHogProductEvents, type ProductEvents } from "./log/product-events.js";
import { CalculatorEmailService } from "./marketing/service.js";
import { createTenantPolicy, type TenantPolicy } from "./policy.js";
import { QuotaService } from "./quotas.js";
import { CloudScheduler } from "./scheduler.js";
import { controlDbPath } from "./tenancy/paths.js";
import { TenantRegistry } from "./tenancy/registry.js";
import type {
  AccountId,
  EntitlementsService,
  ObjectStore,
  TenantOpener,
  TenantRuntimeBase,
  ThreadGate,
} from "./types.js";
import { WorkspacesService } from "./workspaces/service.js";

/** What a tenant opener is built with (the host wires these into its `Services`, spec 9 steps 9-12). */
export interface OpenerContext {
  config: CloudConfig;
  policy: (accountId: AccountId) => TenantPolicy;
  threadGate: ThreadGate;
  /** `CheckinsService` `onConfigChanged`: the workspace's next check-in time. */
  scheduleChanged: (accountId: AccountId, nextRunAt: string | null) => void;
  log: Logger;
}

export interface CloudRuntimeOptions<R extends TenantRuntimeBase> {
  env: NodeJS.ProcessEnv;
  /** The host's tenant opener. The CLI may run without one (commands that open tenants then refuse). */
  createOpener?: (ctx: OpenerContext) => TenantOpener<R>;
  runDue?: (r: R) => Promise<{ nextRunAt: string | null }>;
  supportView?: (r: R) => Promise<SupportView> | SupportView;
  log?: Logger;
  /** Tests: replace pieces that would talk to the network. */
  overrides?: {
    gateway?: StripeGateway;
    transport?: EmailTransport;
    store?: ObjectStore;
    captcha?: CaptchaVerifier;
    /** The HTTP client "Sign in with Google" uses (tests: an in-process fake OpenID provider). */
    oidcFetch?: typeof fetch;
    /** The HTTP client server error reports use (tests: a capturing fake PostHog). */
    errorReportFetch?: typeof fetch;
    /** The HTTP client server-side product events use (tests: a capturing fake PostHog). */
    productEventFetch?: typeof fetch;
    /** The HTTP client MCP analytics uses (tests: a capturing fake PostHog). */
    mcpAnalyticsFetch?: typeof fetch;
  };
}

export interface CloudRuntime<R extends TenantRuntimeBase> {
  config: CloudConfig;
  pricing: PricingConfig;
  /** Every `error` line with an `err` is also sent to `errorReporter`, when one is configured. */
  log: Logger;
  /** Server error reports (PostHog), or null when `config.errorReports` is not set. */
  errorReporter: ErrorReporter | null;
  /** Server-side product events (billing changes, PostHog), or null when `config.errorReports` is not set. */
  productEvents: ProductEvents | null;
  /** MCP tool-call analytics (PostHog, metadata only), or null when `config.errorReports` is not set. */
  mcpAnalytics: McpAnalytics | null;
  db: ControlDb;
  closeDb(): void;
  keys: Keyring;
  limiter: RateLimiter;
  audit: ControlAudit & { scrub(): number };
  mailer: Mailer;
  outbox: MailOutbox;
  captcha: CaptchaVerifier;
  gateway: StripeGateway;
  billing: BillingService;
  entitlements: EntitlementsService;
  quotas: QuotaService;
  policy: (accountId: AccountId) => TenantPolicy;
  threadGate: ReturnType<typeof fairThreadGate>;
  registry: TenantRegistry<R>;
  store: ObjectStore;
  backups: BackupService;
  workspaces: WorkspacesService;
  accounts: AccountsService;
  scheduler: CloudScheduler<R>;
  http: CloudHttpDeps;
  region: string;
}

const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** `"Glideworth <hello@example.com>"` or a bare address. */
export function parseFrom(v: string | undefined): Address {
  const s = (v ?? "").trim();
  const m = /^(.*)<([^<>\s]+@[^<>\s]+)>$/.exec(s);
  if (m)
    return {
      email: (m[2] as string).trim(),
      name: (m[1] as string).trim().replace(/^"|"$/g, "") || "Glideworth",
    };
  return { email: s || "no-reply@localhost.invalid", name: "Glideworth" };
}

/** The region segment of backup object keys (`<region>/tenants/<id>/…`). */
export function backupRegion(env: NodeJS.ProcessEnv): string {
  return (
    (env.GLIDEWORTH_S3_REGION ?? "local")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .slice(0, 32) || "local"
  );
}

/** S3 when `GLIDEWORTH_S3_BUCKET` is set; outside production a directory under the data dir. */
export function createObjectStore(env: NodeJS.ProcessEnv, config: CloudConfig): ObjectStore {
  if (env.GLIDEWORTH_S3_BUCKET)
    return s3ObjectStore({
      endpoint: env.GLIDEWORTH_S3_ENDPOINT ?? "",
      region: env.GLIDEWORTH_S3_REGION ?? "",
      bucket: env.GLIDEWORTH_S3_BUCKET,
      accessKeyId: env.GLIDEWORTH_S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: env.GLIDEWORTH_S3_SECRET_ACCESS_KEY ?? "",
    });
  if (config.production)
    throw new Error("GLIDEWORTH_S3_BUCKET is required in production (backups)");
  return fsObjectStore(resolve(config.dataDir, "backup-store"));
}

function noOpener<R extends TenantRuntimeBase>(): TenantOpener<R> {
  return {
    open() {
      throw new CloudError(503, "TENANT_UNAVAILABLE", "no tenant runtime in this process");
    },
  };
}

export async function createCloudRuntime<R extends TenantRuntimeBase>(
  o: CloudRuntimeOptions<R>,
): Promise<CloudRuntime<R>> {
  const env = o.env;
  const config = loadCloudConfig(env);
  const level = (env.GLIDEWORTH_LOG_LEVEL ?? "info") as LogLevel;
  const baseLog = o.log ?? createLogger({ level: LEVELS.includes(level) ? level : "info" });
  const errorReporter = config.errorReports
    ? createPostHogErrorReporter({
        ...config.errorReports,
        log: baseLog,
        ...(o.overrides?.errorReportFetch ? { fetch: o.overrides.errorReportFetch } : {}),
      })
    : null;
  const log = errorReporter ? reportingLogger(baseLog, errorReporter) : baseLog;
  // Same project and gate as the error reports: no token (a self-host copy), no product events.
  const productEvents = config.errorReports
    ? createPostHogProductEvents({
        token: config.errorReports.token,
        host: config.errorReports.host,
        log: baseLog,
        ...(o.overrides?.productEventFetch ? { fetch: o.overrides.productEventFetch } : {}),
      })
    : null;
  const mcpAnalytics = config.errorReports
    ? createPostHogMcpAnalytics({
        ...config.errorReports,
        log: baseLog,
        ...(o.overrides?.mcpAnalyticsFetch ? { fetch: o.overrides.mcpAnalyticsFetch } : {}),
      })
    : null;
  const pricing = loadPricingConfig(config.pricingFile);
  for (const sub of ["control", "tenants", "exports", "staging"])
    mkdirSync(resolve(config.dataDir, sub), { recursive: true, mode: 0o700 });
  const control = openControlDb(controlDbPath(config.dataDir));
  const db = control.db;
  const keys = keyring(config.secretsKey);
  const limiter = memoryRateLimiter();
  const audit = controlAudit(db, { log });

  // ---- email
  const mode = env.GLIDEWORTH_EMAIL_TRANSPORT ?? "file";
  const transport: EmailTransport =
    o.overrides?.transport ??
    (mode === "resend"
      ? resendTransport({ apiKey: env.GLIDEWORTH_RESEND_API_KEY ?? "" })
      : mode === "smtp"
        ? smtpTransport({ url: env.GLIDEWORTH_SMTP_URL ?? "" })
        : mode === "mailgun"
          ? mailgunTransport({
              apiKey: env.GLIDEWORTH_MAILGUN_API_KEY ?? "",
              domain: env.GLIDEWORTH_MAILGUN_DOMAIN ?? "",
              region: env.GLIDEWORTH_MAILGUN_REGION === "us" ? "us" : "eu",
            })
          : fileTransport({ dir: resolve(config.dataDir, "mail-outbox") }));
  const emailStores = controlEmailStores(db);
  const unsubscribe = hmacUnsubscribeSigner({
    key: deriveKey(config.secretsKey, "email:unsubscribe"),
    baseUrl: config.publicUrl,
  });
  const mailer = createMailer({
    transport,
    from: parseFrom(env.GLIDEWORTH_EMAIL_FROM),
    context: {
      productName: "Glideworth",
      appUrl: config.publicUrl,
      supportEmail: env.GLIDEWORTH_SUPPORT_EMAIL ?? "support@localhost.invalid",
    },
    suppressions: emailStores.suppressions,
    log: emailStores.log,
    unsubscribe,
  });
  const outbox = new MailOutbox({ db, mailer, log });
  const captcha =
    o.overrides?.captcha ??
    (env.GLIDEWORTH_TURNSTILE_SECRET
      ? turnstileVerifier({ secret: env.GLIDEWORTH_TURNSTILE_SECRET })
      : staticCaptcha(env.GLIDEWORTH_DEV_CAPTCHA_TOKEN || "dev-captcha"));

  // ---- billing
  const rawGateway: StripeGateway =
    o.overrides?.gateway ??
    ((env.GLIDEWORTH_BILLING ?? "fake") === "stripe"
      ? stripeGateway(await createStripeClient(env.GLIDEWORTH_STRIPE_SECRET_KEY ?? ""))
      : new FakeStripeGateway());
  // The in-memory fake gateway (development, never production) starts empty, so the
  // pricing file's products, prices and portal configuration are created in it here, as `sync-prices --apply`
  // does against Stripe. Without this, checkout in a development server answers CONFIG_INVALID.
  let portalConfigurationId = env.GLIDEWORTH_STRIPE_PORTAL_CONFIGURATION ?? "";
  if (!o.overrides?.gateway && rawGateway instanceof FakeStripeGateway) {
    const synced = await syncPricing(rawGateway, pricing, {
      apply: true,
      archiveRemoved: false,
      returnUrl: `${config.publicUrl}/settings/billing`,
    });
    portalConfigurationId ||= synced.portalConfigurationId ?? "";
  }
  const gateway = trackCheckoutSessions(rawGateway, db);
  const track = productEvents ? billingAnalytics(db, productEvents) : undefined;
  const billing = new BillingService({
    gateway,
    store: controlBillingStore(db),
    pricing,
    publicUrl: config.publicUrl,
    webhookSecret:
      env.GLIDEWORTH_STRIPE_WEBHOOK_SECRET || (config.production ? "" : "whsec_development"),
    portalConfigurationId,
    notify: billingNotifier({
      db,
      outbox,
      audit,
      log,
      publicUrl: config.publicUrl,
      kick: () => void outbox.drain().catch(() => {}),
      ...(track ? { track } : {}),
    }),
    limiter: (key, l, w) => limiter.hit(key, l, w).allowed,
    log: billingLogBridge({ log, audit, ...(track ? { track } : {}) }),
  });
  const entitlements = createEntitlements({ db, pricing });
  const quotas = new QuotaService({ db, limiter, entitlements });
  const policy = createTenantPolicy({ entitlements, quotas, publicUrl: config.publicUrl, log });
  const threadGate = fairThreadGate({ maxThreads: config.maxJobs });

  // ---- tenancy
  let scheduler: CloudScheduler<R> | null = null;
  const scheduleChanged = (accountId: AccountId, nextRunAt: string | null) =>
    scheduler?.scheduleChanged(accountId, nextRunAt);
  const opener = o.createOpener
    ? o.createOpener({ config, policy, threadGate, scheduleChanged, log })
    : noOpener<R>();
  const registry = new TenantRegistry<R>({
    dataDir: config.dataDir,
    control: db,
    opener,
    limitsOf: (a) => entitlements.get(a).limits,
    maxOpen: config.tenantCacheSize,
    log,
    audit,
  });
  scheduler = new CloudScheduler<R>({
    db,
    registry,
    entitlements,
    runDue: o.runDue ?? (async () => ({ nextRunAt: null })),
    log,
  });

  // ---- backups
  const region = backupRegion(env);
  const store = o.overrides?.store ?? createObjectStore(env, config);
  const backups = new BackupService({
    db,
    registry: registry as unknown as TenantRegistry<TenantRuntimeBase>,
    store,
    kek: config.backupKek,
    dataDir: config.dataDir,
    region,
    log,
  });

  // ---- accounts
  const workspaces: WorkspacesService = new WorkspacesService({
    db,
    registry: registry as unknown as TenantRegistry<TenantRuntimeBase>,
    billing,
    mailer,
    audit,
    keys,
    publicUrl: config.publicUrl,
    log,
    limiter,
    pricing,
    kek: config.backupKek,
    dataDir: config.dataDir,
    outbox,
    backups,
  });
  const accounts = new AccountsService({
    db,
    keys,
    mailer,
    captcha,
    limiter,
    audit,
    workspaces: () => workspaces,
    publicUrl: config.publicUrl,
    log,
  });

  // "Sign in with Google": only when configured (no route, no button otherwise).
  const federation = config.google
    ? new FederationService({
        db,
        keys,
        accounts,
        audit,
        limiter,
        log,
        invitation: (token) => workspaces.liveInvitation(token),
        oidc: new OidcClient({
          issuer: config.google.issuer,
          acceptedIssuers: googleIssuers(config.google.issuer),
          clientId: config.google.clientId,
          clientSecret: config.google.clientSecret,
          redirectUri: config.google.redirectUri,
          log,
          ...(o.overrides?.oidcFetch ? { fetch: o.overrides.oidcFetch } : {}),
        }),
      })
    : undefined;

  // "Email me this result" on the marketing site's calculators: only when the operator names the site's origin.
  const calculatorEmail = config.calculatorEmail
    ? {
        siteOrigin: config.calculatorEmail.siteOrigin,
        service: new CalculatorEmailService({
          db,
          outbox,
          limiter,
          keys,
          log,
          unsubscribe,
          siteOrigin: config.calculatorEmail.siteOrigin,
          publicUrl: config.publicUrl,
          dailyLimit: config.calculatorEmail.dailyLimit,
          events: productEvents,
          kick: () => void outbox.drain().catch(() => {}),
        }),
      }
    : undefined;

  const http: CloudHttpDeps = {
    config,
    accounts,
    workspaces,
    billing,
    entitlements,
    quotas,
    backups,
    captcha,
    limiter,
    audit,
    log,
    unsubscribe,
    db,
    keys,
    pricing,
    outbox,
    trustProxy: /^(1|true|yes)$/i.test(env.GLIDEWORTH_TRUST_PROXY ?? ""),
    ...(env.GLIDEWORTH_TURNSTILE_SITE_KEY?.trim()
      ? { captchaSiteKey: env.GLIDEWORTH_TURNSTILE_SITE_KEY.trim() }
      : {}),
    ...(federation ? { federation } : {}),
    ...(calculatorEmail ? { calculatorEmail } : {}),
    ...(productEvents ? { productEvents } : {}),
    registry: registry as unknown as TenantRegistry<TenantRuntimeBase>,
    ...(env.GLIDEWORTH_MAILGUN_WEBHOOK_SIGNING_KEY
      ? { mailgunWebhookSigningKey: env.GLIDEWORTH_MAILGUN_WEBHOOK_SIGNING_KEY }
      : {}),
    ...(o.supportView
      ? { supportView: o.supportView as (r: TenantRuntimeBase) => SupportView }
      : {}),
    health: () => {
      const g = threadGate.stats();
      return {
        "job threads running": g.running,
        "workspaces waiting for a thread": Object.keys(g.waiting).length,
      };
    },
  };
  if (!existsSync(config.pricingFile)) log.warn("cloud.pricing_missing", {});

  return {
    config,
    pricing,
    log,
    errorReporter,
    productEvents,
    mcpAnalytics,
    db,
    closeDb: control.close,
    keys,
    limiter,
    audit,
    mailer,
    outbox,
    captcha,
    gateway: rawGateway,
    billing,
    entitlements,
    quotas,
    policy,
    threadGate,
    registry,
    store,
    backups,
    workspaces,
    accounts,
    scheduler,
    http,
    region,
  };
}
