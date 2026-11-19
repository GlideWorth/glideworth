/**
 * Application services: the ONE place that implements operations. REST routes and MCP tools are
 * thin adapters over these classes, which keeps the two surfaces identical.
 *
 *   households   household, people, accounts/assets/debts, balances, snapshots, export/import
 *   plans        plan CRUD, versions/restore, branches, duplicate/archive/main
 *   parts        nested plan collections + singleton settings
 *   changeSets   propose / preview / apply / discard
 *   sim          deterministic projections, async jobs, insights, tax, compare, sensitivity
 *   jobs         background jobs (worker threads) with progress + cancellation
 *   scenarios    what-if templates, survivor scenarios
 *   exports      CSV / JSON tables and report data
 *   auth         browser passphrase + sessions
 *   users        owner / editor / viewer logins, invites, resets; audit = who changed what
 *   oauth        OAuth 2.1 authorization server for remote MCP clients
 *   shares       expiring, revocable read-only links to a plan's results
 *   checkins     scheduler, plan health history, notifications
 *   crossBorder  items held in another country, how they are taxed, tax by country, rule tables
 *   keys / webhooks / settings / imports
 */
import type { Actor } from "@glideworth/core";
import type { Db } from "./db/client.js";
import { type CoreDeps, coreDeps, type ImportDeps, importDeps } from "./deps.js";
import { type JobExecutor, type WorkerExecutorOptions, workerExecutor } from "./jobs/executor.js";
import { AuditService } from "./services/audit.js";
import { type AuthOptions, AuthService } from "./services/auth.js";
import { ResultCache } from "./services/cache.js";
import { ChangeSetsService } from "./services/changesets.js";
import { type CheckinsOptions, CheckinsService } from "./services/checkins.js";
import { EventBus, type ServiceCtx } from "./services/context.js";
import { CrossBorderService } from "./services/crossborder.js";
import { ExportsService } from "./services/exports.js";
import { HouseholdsService } from "./services/households.js";
import { type ImportRunnerOption, ImportsService } from "./services/imports.js";
import { type JobsOptions, JobsService } from "./services/jobs.js";
import { type KeysOptions, KeysService } from "./services/keys.js";
import { type OAuthOptions, OAuthService } from "./services/oauth.js";
import { PlanPartsService } from "./services/plan-parts.js";
import { PlansService } from "./services/plans.js";
import { ScenariosService } from "./services/scenarios.js";
import { SettingsService } from "./services/settings.js";
import { type SharesOptions, SharesService } from "./services/shares.js";
import { SimulationService } from "./services/simulation.js";
import { UsersService } from "./services/users.js";
import { type WebhookOptions, WebhooksService } from "./services/webhooks.js";

export interface ServicesOptions {
  deps?: CoreDeps;
  imports?: ImportDeps;
  /** Where imports are parsed. Default: the process's import worker pool (`jobs/import-pool.ts`). */
  importRunner?: ImportRunnerOption;
  /** Where background jobs run. Default: a worker thread per job. */
  executor?: JobExecutor;
  maxConcurrentJobs?: number;
  /**
   * Monte Carlo sharding across worker threads, the heap limit of a job thread and (cloud) the fair thread
   * gate and worker-time accounting. Ignored when `executor` is given.
   */
  sharding?: WorkerExecutorOptions;
  auth?: AuthOptions;
  webhooks?: WebhookOptions;
  /** Job time limit and (cloud) admission and per-workspace limits. */
  jobs?: JobsOptions;
  /** Key format and (cloud) the active-key limit. */
  keys?: KeysOptions;
  /** OAuth client registry and token format (cloud: control plane, routed tokens). */
  oauth?: OAuthOptions;
  /** Share-link token format and (cloud) the active-link limit. */
  shares?: SharesOptions;
  /** Scheduler clock and Monte Carlo wait (tests). */
  checkins?: CheckinsOptions;
}

export class Services {
  readonly ctx: ServiceCtx;
  readonly events: EventBus;
  readonly households: HouseholdsService;
  readonly plans: PlansService;
  readonly parts: PlanPartsService;
  readonly settings: SettingsService;
  readonly sim: SimulationService;
  readonly jobs: JobsService;
  readonly changeSets: ChangeSetsService;
  readonly keys: KeysService;
  readonly webhooks: WebhooksService;
  readonly imports: ImportsService;
  readonly scenarios: ScenariosService;
  readonly exports: ExportsService;
  readonly auth: AuthService;
  readonly users: UsersService;
  readonly audit: AuditService;
  readonly oauth: OAuthService;
  readonly shares: SharesService;
  readonly checkins: CheckinsService;
  readonly crossBorder: CrossBorderService;

  constructor(
    readonly db: Db,
    opts: ServicesOptions = {},
  ) {
    this.events = new EventBus();
    this.ctx = {
      db,
      deps: opts.deps ?? coreDeps,
      imports: opts.imports ?? importDeps,
      events: this.events,
    };
    this.households = new HouseholdsService(this.ctx);
    this.plans = new PlansService(this.ctx);
    this.settings = new SettingsService(this.ctx);
    this.households.plans = this.plans;
    this.households.settings = this.settings;
    this.plans.households = this.households;
    this.parts = new PlanPartsService(this.plans);
    const cache = new ResultCache(this.ctx);
    this.jobs = new JobsService(
      this.ctx,
      cache,
      opts.executor ?? workerExecutor(opts.sharding),
      opts.maxConcurrentJobs ?? 2,
      opts.jobs,
    );
    this.sim = new SimulationService(this.ctx, this.plans, this.households, cache, this.jobs);
    this.changeSets = new ChangeSetsService(this.ctx, this.plans, this.sim);
    this.keys = new KeysService(this.ctx, opts.keys);
    this.webhooks = new WebhooksService(this.ctx, opts.webhooks);
    this.imports = new ImportsService(this.ctx, this.households, this.plans, opts.importRunner);
    this.scenarios = new ScenariosService(this.ctx, this.plans, this.sim);
    this.exports = new ExportsService(this.ctx, this.households, this.plans, this.sim);
    this.auth = new AuthService(db, opts.auth);
    this.users = new UsersService(this.ctx, this.auth);
    this.audit = new AuditService(this.ctx);
    this.oauth = new OAuthService(this.ctx, opts.oauth);
    this.shares = new SharesService(this.ctx, this.plans, this.households, this.sim, opts.shares);
    this.checkins = new CheckinsService(
      this.ctx,
      this.plans,
      this.households,
      this.sim,
      opts.checkins,
    );
    this.crossBorder = new CrossBorderService(this.sim);
  }
}

export type { Actor };
