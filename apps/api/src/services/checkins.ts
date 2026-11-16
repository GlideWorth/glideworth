/**
 * Scheduled re-runs and check-ins.
 *
 * An in-process scheduler (a plain timer, no external dependency) re-runs every household's main active plan
 * on a configurable cadence: deterministic projection, Monte Carlo chance of success, an assumption audit.
 * Each run is stored as one row of the "plan health history" (success rate, FI year, net worth versus plan).
 * Material changes against the previous run become notifications and a webhook:
 *
 *   success-rate-change  the chance of success moved by more than `thresholds.successRateDelta`
 *   milestone-slipped    a milestone moved later by `milestoneSlipMonths` or more (or is no longer reached)
 *   audit-finding        a warning/critical assumption finding that was not there last time
 *   behind-plan          net worth is more than `netWorthBehindPlan` below what the last check-in projected for today
 *
 * "What changed since my last check-in" compares the plan and the household as they are NOW (deterministic
 * recompute, no Monte Carlo) with the last stored check-in, and lists the edits made in between and by whom.
 */
import { log } from "../log.js";
import type { Actor, MonteCarloResult, Plan, ProjectionResult } from "@glideworth/core";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { notifications, planHealth, planVersions, scheduleConfig } from "../db/schema.js";
import { ApiError, notFound } from "../errors.js";
import { baseConverter } from "../fx.js";
import { toTodaysMoney } from "../money.js";
import { newId, nowIso } from "../util.js";
import type { ServiceCtx } from "./context.js";
import type { HouseholdsService } from "./households.js";
import type { PlansService } from "./plans.js";
import type { SimulationService } from "./simulation.js";

export const ScheduleConfig = z
  .object({
    enabled: z.boolean().default(true).describe("Run check-ins automatically."),
    cadence: z
      .enum(["daily", "weekly", "monthly", "quarterly"])
      .default("weekly")
      .describe("How often the main plan of every household is re-run."),
    intervalHours: z
      .number()
      .min(1)
      .max(24 * 366)
      .optional()
      .describe("Overrides `cadence` with a custom interval in hours."),
    thresholds: z
      .object({
        successRateDelta: z
          .number()
          .min(0.001)
          .max(1)
          .default(0.05)
          .describe("Chance of success moved by more than this (0.05 = 5 percentage points)."),
        milestoneSlipMonths: z
          .number()
          .int()
          .min(1)
          .max(600)
          .default(6)
          .describe("A milestone moved later by at least this many months."),
        netWorthBehindPlan: z
          .number()
          .min(0.01)
          .max(1)
          .default(0.1)
          .describe("Net worth is more than this fraction below the plan (0.1 = 10%)."),
      })
      .default({ successRateDelta: 0.05, milestoneSlipMonths: 6, netWorthBehindPlan: 0.1 }),
    monteCarloTrials: z
      .number()
      .int()
      .min(100)
      .max(20_000)
      .optional()
      .describe("Trials per run (default: the plan's own setting)."),
  })
  .meta({ id: "ScheduleConfig" });
export type ScheduleConfig = z.infer<typeof ScheduleConfig>;

const CADENCE_HOURS = { daily: 24, weekly: 24 * 7, monthly: 24 * 30, quarterly: 24 * 91 } as const;
export const intervalMs = (c: ScheduleConfig): number =>
  (c.intervalHours ?? CADENCE_HOURS[c.cadence]) * 3_600_000;

export interface MilestoneState {
  id: string;
  name: string;
  status: "reached" | "never" | "disabled";
  month: string | null;
}
export interface FindingState {
  key: string;
  code: string;
  severity: "info" | "warning" | "critical";
  title: string;
}
export interface HealthBody {
  milestones: MilestoneState[];
  findings: FindingState[];
  endNetWorthReal: number | null;
  depletionYear: number | null;
  retirementYear: number | null;
  /** Projected net worth by year, today's money. Drives "net worth versus plan" at the next check-in. */
  netWorthPath: { year: number; netWorth: number }[];
  mc: { trials: number; seed: number | null } | null;
  error?: string;
}

export interface HealthRecord {
  id: string;
  planId: string;
  planName: string;
  takenAt: string;
  trigger: "scheduled" | "manual" | "api";
  planVersion: number;
  householdVersion: number;
  successRate: number | null;
  fiYear: number | null;
  actualNetWorth: number | null;
  plannedNetWorth: number | null;
  /** actual - planned, and actual / planned - 1 (null without a plan figure). */
  netWorthVsPlan: { delta: number; ratio: number } | null;
  endNetWorthReal: number | null;
  depletionYear: number | null;
  milestones: MilestoneState[];
  findings: FindingState[];
  currency: string;
}

export interface Change {
  kind: "success-rate-change" | "milestone-slipped" | "audit-finding" | "behind-plan";
  severity: "info" | "warning" | "critical";
  title: string;
  detail: Record<string, unknown>;
}

export interface NotificationView {
  id: string;
  createdAt: string;
  kind: string;
  severity: "info" | "warning" | "critical";
  planId: string | null;
  healthId: string | null;
  title: string;
  body: unknown;
  read: boolean;
}

const SYSTEM: Actor = { kind: "system", label: "scheduler" };
const fiMilestone = (m: { milestoneId: string; name: string }) =>
  /(^|[-_])fi($|[-_])|financial independence|\bFIRE?\b/i.test(`${m.milestoneId} ${m.name}`);

const yearOf = (month: string | null | undefined) => (month ? Number(month.slice(0, 4)) : null);
const monthsOf = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7));
const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;

/**
 * Net worth the projection expected for `now`, interpolated across the year (today's money). The line starts
 * at the previous year's projected figure, or, in a plan's first year, at `anchor` (the last check-in's actual
 * net worth, or today's when there is none).
 */
export function plannedNow(
  path: { year: number; netWorth: number }[],
  anchor: { at: number; value: number },
  now: Date,
): number | null {
  const y = now.getUTCFullYear();
  const end = path.find((p) => p.year === y);
  if (!end) return null;
  const yearStart = Date.UTC(y, 0, 1);
  const yearEnd = Date.UTC(y + 1, 0, 1);
  const prev = path.find((p) => p.year === y - 1);
  const from = prev
    ? { at: yearStart, value: prev.netWorth }
    : anchor.at >= yearStart && anchor.at < yearEnd
      ? anchor
      : { at: yearStart, value: anchor.value };
  const frac = Math.min(1, Math.max(0, (now.getTime() - from.at) / (yearEnd - from.at)));
  return from.value + (end.netWorth - from.value) * frac;
}

export interface CheckinsOptions {
  now?: () => number;
  mcTimeoutMs?: number;
  /**
   * Cloud: the schedule or the last run changed; tell the global scheduler when this workspace is next due
   * (the in-process timer is not started in cloud mode).
   */
  onConfigChanged?: (nextRunAt: string | null) => void;
  /**
   * After every run: how many plans were checked and which kinds of change were found. Deliberately only
   * counts and kinds: notification titles quote figures and plan names, and must never reach an email or a
   * log (cloud mode builds the check-in email from this).
   */
  onRun?: (r: {
    trigger: "scheduled" | "manual" | "api";
    plansChecked: number;
    changeKinds: Change["kind"][];
  }) => void;
}

export class CheckinsService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<unknown> | null = null;

  constructor(
    private readonly ctx: ServiceCtx,
    private readonly plans: PlansService,
    private readonly households: HouseholdsService,
    private readonly sim: SimulationService,
    private readonly opts: CheckinsOptions = {},
  ) {}
  private get db() {
    return this.ctx.db;
  }
  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  // ----------------------------------------------------------------------------- schedule
  getConfig(): ScheduleConfig & {
    lastRunAt: string | null;
    nextRunAt: string | null;
    running: boolean;
  } {
    const row = this.db.select().from(scheduleConfig).where(eq(scheduleConfig.id, "default")).get();
    const config = ScheduleConfig.parse(row?.body ?? {});
    const last = row?.lastRunAt ?? null;
    const next = config.enabled
      ? new Date(last ? Date.parse(last) + intervalMs(config) : this.now()).toISOString()
      : null;
    return { ...config, lastRunAt: last, nextRunAt: next, running: this.running !== null };
  }

  setConfig(patch: unknown): ReturnType<CheckinsService["getConfig"]> {
    const cur = this.getConfig();
    const { lastRunAt: _l, nextRunAt: _n, running: _r, ...base } = cur;
    const merged = ScheduleConfig.parse({
      ...base,
      ...(patch as object),
      thresholds: { ...base.thresholds, ...((patch as { thresholds?: object }).thresholds ?? {}) },
    });
    this.db
      .insert(scheduleConfig)
      .values({ id: "default", body: merged, lastRunAt: cur.lastRunAt })
      .onConflictDoUpdate({ target: scheduleConfig.id, set: { body: merged, updatedAt: nowIso() } })
      .run();
    const next = this.getConfig();
    this.opts.onConfigChanged?.(next.nextRunAt);
    return next;
  }

  /** Start the timer (server only: tests drive `tick` themselves). Checks once a minute whether a run is due. */
  start(tickMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(() => {}), tickMs);
    this.timer.unref();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  /** Wait for a run that is in progress (shutdown, tests). */
  async idle(): Promise<void> {
    await this.running?.catch(() => {});
  }

  /** Run the scheduled check-ins when due. Returns the check-ins taken (empty when nothing was due). */
  async tick(): Promise<HealthRecord[]> {
    const cfg = this.getConfig();
    if (!cfg.enabled || this.running) return [];
    const last = cfg.lastRunAt ? Date.parse(cfg.lastRunAt) : null;
    if (last !== null && this.now() < last + intervalMs(cfg)) return [];
    return this.runAll("scheduled");
  }

  /** Check in on the main active plan of every household. */
  async runAll(
    trigger: "scheduled" | "manual" | "api",
    actor: Actor = SYSTEM,
  ): Promise<HealthRecord[]> {
    if (this.running) throw new ApiError(409, "CHECKIN_RUNNING", "a check-in is already running");
    const work = (async () => {
      const out: HealthRecord[] = [];
      const kinds = new Set<Change["kind"]>();
      const targets = this.plans.list({ status: "active" }).filter((p) => p.isMain);
      for (const p of targets) {
        try {
          const run = await this.runPlan(p.id, trigger, actor);
          for (const ch of run.changes) kinds.add(ch.kind);
          out.push(run.health);
        } catch (err) {
          // Never the plan id with its message: messages can quote plan content.
          log.warn("checkin.plan_failed", { err });
        }
      }
      const cur = this.db
        .select()
        .from(scheduleConfig)
        .where(eq(scheduleConfig.id, "default"))
        .get();
      this.db
        .insert(scheduleConfig)
        .values({
          id: "default",
          body: cur?.body ?? ScheduleConfig.parse({}),
          lastRunAt: new Date(this.now()).toISOString(),
        })
        .onConflictDoUpdate({
          target: scheduleConfig.id,
          set: { lastRunAt: new Date(this.now()).toISOString() },
        })
        .run();
      this.opts.onRun?.({ trigger, plansChecked: out.length, changeKinds: [...kinds] });
      return out;
    })();
    this.running = work;
    try {
      return await work;
    } finally {
      this.running = null;
      this.opts.onConfigChanged?.(this.getConfig().nextRunAt);
    }
  }

  // ----------------------------------------------------------------------------- one plan
  private async monteCarlo(plan: Plan, trials: number | undefined, actor: Actor) {
    try {
      const job = this.sim.startMonteCarlo(
        plan.id,
        { keepTrials: false, randomSeed: false, ...(trials ? { settings: { trials } } : {}) },
        actor,
      );
      const done = await this.sim.jobs.waitFor(job.id, this.opts.mcTimeoutMs ?? 180_000);
      if (done.status !== "succeeded")
        return { rate: null, error: `Monte Carlo ${done.status}`, trials: 0, seed: null };
      const r = this.sim.jobs.result(job.id) as MonteCarloResult;
      return { rate: r.successRate, error: undefined, trials: r.trials, seed: r.seed ?? null };
    } catch (err) {
      return {
        rate: null,
        error: err instanceof Error ? err.message : "Monte Carlo failed",
        trials: 0,
        seed: null,
      };
    }
  }

  private netWorthNow(householdId: string): number {
    const { finances, household } = this.households.get(householdId);
    const { convert } = baseConverter(finances, household.currency);
    let nw = 0;
    for (const a of finances.accounts) if (!a.archived) nw += convert(a.balance, a.currency);
    for (const r of finances.realAssets)
      if (!r.archived) nw += convert(r.currentValue - (r.loan?.balance ?? 0), r.currency);
    for (const d of finances.debts) if (!d.archived) nw -= convert(d.balance, d.currency);
    return nw;
  }

  private state(
    plan: Plan,
    result: ProjectionResult | null,
  ): Omit<HealthBody, "mc"> & { fiYear: number | null } {
    const milestones: MilestoneState[] = (result?.milestones ?? []).map((m) => ({
      id: m.milestoneId,
      name: m.name,
      status: m.status,
      month: m.month,
    }));
    const fi = result?.milestones.find((m) => fiMilestone(m) && m.status === "reached");
    const findings: FindingState[] = [];
    if (result) {
      const { findings: fs } = this.sim.audit(plan.id);
      for (const f of fs)
        findings.push({
          key: `${f.code}:${[...f.refs].sort().join(",")}`,
          code: f.code,
          severity: f.severity,
          title: f.title,
        });
    }
    return {
      milestones,
      findings,
      endNetWorthReal: result ? Math.round(result.summary.endNetWorthReal) : null,
      depletionYear: result?.summary.firstShortfallYear ?? null,
      retirementYear: result?.summary.retirementYear ?? null,
      netWorthPath: (result?.periods ?? []).map((p) => ({
        year: p.year,
        netWorth: Math.round(toTodaysMoney(p.totals.netWorth, p)),
      })),
      fiYear: yearOf(fi?.month) ?? result?.summary.retirementYear ?? null,
    };
  }

  /** Re-run one plan now and record the check-in. */
  async runPlan(
    planId: string,
    trigger: "scheduled" | "manual" | "api" = "manual",
    actor: Actor = SYSTEM,
  ): Promise<{
    health: HealthRecord;
    previous: HealthRecord | null;
    changes: Change[];
    notifications: NotificationView[];
  }> {
    const plan = this.plans.get(planId);
    const cfg = this.getConfig();
    const previous = this.latest(planId);
    let result: ProjectionResult | null = null;
    let error: string | undefined;
    try {
      result = this.sim.projection(planId, { trace: "off" }).result;
    } catch (err) {
      error = err instanceof Error ? err.message : "projection failed";
    }
    const mc = result
      ? await this.monteCarlo(plan, cfg.monteCarloTrials, actor)
      : { rate: null, trials: 0, seed: null, error: undefined };
    const st = this.state(plan, result);
    const actual = this.netWorthNow(plan.householdId);
    const prevBody = previous ? this.bodyOf(previous.id) : null;
    const planned = plannedNow(
      prevBody?.netWorthPath ?? st.netWorthPath,
      previous?.actualNetWorth != null
        ? { at: Date.parse(previous.takenAt), value: previous.actualNetWorth }
        : { at: this.now(), value: actual },
      new Date(this.now()),
    );
    const body: HealthBody = {
      milestones: st.milestones,
      findings: st.findings,
      endNetWorthReal: st.endNetWorthReal,
      depletionYear: st.depletionYear,
      retirementYear: st.retirementYear,
      netWorthPath: st.netWorthPath,
      mc: mc.rate === null ? null : { trials: mc.trials, seed: mc.seed },
      ...((error ?? mc.error) ? { error: (error ?? mc.error) as string } : {}),
    };
    const id = newId("chk");
    this.db
      .insert(planHealth)
      .values({
        id,
        planId,
        takenAt: new Date(this.now()).toISOString(),
        trigger,
        planVersion: plan.version,
        householdVersion: this.households.version(plan.householdId),
        successRate: mc.rate,
        fiYear: st.fiYear,
        actualNetWorth: Math.round(actual),
        plannedNetWorth: planned === null ? null : Math.round(planned),
        body,
      })
      .run();
    const health = this.view(
      this.db.select().from(planHealth).where(eq(planHealth.id, id)).get()!,
      plan,
    );
    const changes = previous ? this.detect(previous, health, cfg.thresholds) : [];
    const created = changes.map((c) => this.notify(c, health));
    this.ctx.events.publish("checkin.completed", {
      checkInId: id,
      planId,
      planName: plan.name,
      trigger,
      successRate: health.successRate,
      fiYear: health.fiYear,
      changes: changes.map((c) => ({ kind: c.kind, severity: c.severity, title: c.title })),
    });
    return { health, previous, changes, notifications: created };
  }

  // ----------------------------------------------------------------------------- change detection
  detect(prev: HealthRecord, now: HealthRecord, t: ScheduleConfig["thresholds"]): Change[] {
    const out: Change[] = [];
    if (prev.successRate !== null && now.successRate !== null) {
      const d = now.successRate - prev.successRate;
      if (Math.abs(d) > t.successRateDelta)
        out.push({
          kind: "success-rate-change",
          severity: d < 0 ? (now.successRate < 0.7 ? "critical" : "warning") : "info",
          title: `Chance of success ${d < 0 ? "fell" : "rose"} from ${pct(prev.successRate)} to ${pct(now.successRate)}`,
          detail: {
            from: prev.successRate,
            to: now.successRate,
            delta: d,
            threshold: t.successRateDelta,
          },
        });
    }
    for (const m of now.milestones) {
      const was = prev.milestones.find((x) => x.id === m.id);
      if (was?.status !== "reached") continue;
      if (m.status === "never")
        out.push({
          kind: "milestone-slipped",
          severity: "critical",
          title: `'${m.name}' is no longer reached (it was ${was.month})`,
          detail: { milestoneId: m.id, from: was.month, to: null },
        });
      else if (m.status === "reached" && m.month && was.month) {
        const slip = monthsOf(m.month) - monthsOf(was.month);
        if (slip >= t.milestoneSlipMonths)
          out.push({
            kind: "milestone-slipped",
            severity: slip >= 24 ? "critical" : "warning",
            title: `'${m.name}' slipped ${slip} months, from ${was.month} to ${m.month}`,
            detail: {
              milestoneId: m.id,
              from: was.month,
              to: m.month,
              months: slip,
              threshold: t.milestoneSlipMonths,
            },
          });
      }
    }
    const had = new Set(prev.findings.map((f) => f.key));
    for (const f of now.findings)
      if (f.severity !== "info" && !had.has(f.key))
        out.push({
          kind: "audit-finding",
          severity: f.severity,
          title: `New assumption finding: ${f.title}`,
          detail: { code: f.code, key: f.key },
        });
    if (now.netWorthVsPlan && now.netWorthVsPlan.ratio < -t.netWorthBehindPlan)
      out.push({
        kind: "behind-plan",
        severity: now.netWorthVsPlan.ratio < -2 * t.netWorthBehindPlan ? "critical" : "warning",
        title: `Net worth is ${pct(-now.netWorthVsPlan.ratio)} behind the plan`,
        detail: {
          ...now.netWorthVsPlan,
          actual: now.actualNetWorth,
          planned: now.plannedNetWorth,
          threshold: t.netWorthBehindPlan,
        },
      });
    return out;
  }

  // ----------------------------------------------------------------------------- reads
  private bodyOf(id: string): HealthBody {
    return this.db.select().from(planHealth).where(eq(planHealth.id, id)).get()!.body as HealthBody;
  }

  private view(r: typeof planHealth.$inferSelect, plan?: Plan): HealthRecord {
    const p = plan ?? this.plans.tryGet(r.planId);
    const body = r.body as HealthBody;
    const planned = r.plannedNetWorth;
    return {
      id: r.id,
      planId: r.planId,
      planName: p?.name ?? r.planId,
      takenAt: r.takenAt,
      trigger: r.trigger,
      planVersion: r.planVersion,
      householdVersion: r.householdVersion,
      successRate: r.successRate,
      fiYear: r.fiYear,
      actualNetWorth: r.actualNetWorth,
      plannedNetWorth: planned,
      netWorthVsPlan:
        planned !== null && r.actualNetWorth !== null && planned !== 0
          ? {
              delta: Math.round(r.actualNetWorth - planned),
              ratio: Math.round((r.actualNetWorth / planned - 1) * 10_000) / 10_000,
            }
          : null,
      endNetWorthReal: body.endNetWorthReal,
      depletionYear: body.depletionYear,
      milestones: body.milestones,
      findings: body.findings,
      currency: p ? this.households.get(p.householdId).household.currency : "",
    };
  }

  latest(planId: string): HealthRecord | null {
    const r = this.db
      .select()
      .from(planHealth)
      .where(eq(planHealth.planId, planId))
      .orderBy(desc(planHealth.takenAt), desc(sql`rowid`))
      .limit(1)
      .get();
    return r ? this.view(r) : null;
  }

  /** The plan health history: newest first. */
  history(
    planId: string,
    o: { limit?: number | undefined; since?: string | undefined } = {},
  ): HealthRecord[] {
    this.plans.get(planId);
    return this.db
      .select()
      .from(planHealth)
      .where(
        and(eq(planHealth.planId, planId), ...(o.since ? [gt(planHealth.takenAt, o.since)] : [])),
      )
      .orderBy(desc(planHealth.takenAt), desc(sql`rowid`))
      .limit(Math.min(o.limit ?? 50, 500))
      .all()
      .map((r) => this.view(r));
  }

  /**
   * What changed since the last check-in (or `since`): the plan as it is now (deterministic recompute) against
   * the stored check-in, the edits made in between and by whom, and the notifications raised.
   */
  async sinceLastCheckin(
    planId: string,
    o: { since?: string | undefined; refresh?: boolean | undefined } = {},
    actor: Actor = SYSTEM,
  ) {
    const plan0 = this.plans.get(planId);
    let refreshed: Awaited<ReturnType<CheckinsService["runPlan"]>> | null = null;
    if (o.refresh) refreshed = await this.runPlan(planId, "manual", actor);
    const history = this.history(planId, { limit: 2 });
    // After a refresh the baseline is the check-in before it.
    const baseline = refreshed ? (refreshed.previous ?? null) : (history[0] ?? null);
    const since = o.since ?? baseline?.takenAt ?? null;
    const plan = this.plans.get(planId);
    const edits = this.db
      .select({
        version: planVersions.version,
        createdAt: planVersions.createdAt,
        actor: planVersions.actor,
        message: planVersions.message,
      })
      .from(planVersions)
      .where(
        and(eq(planVersions.planId, planId), ...(since ? [gt(planVersions.createdAt, since)] : [])),
      )
      .orderBy(desc(planVersions.version))
      .all();
    // Current deterministic state vs the baseline.
    let current: HealthRecord | null = refreshed?.health ?? null;
    if (!current) {
      let result: ProjectionResult | null = null;
      try {
        result = this.sim.projection(planId, { trace: "off" }).result;
      } catch {
        result = null;
      }
      const st = this.state(plan, result);
      const actual = this.netWorthNow(plan.householdId);
      const planned = plannedNow(
        baseline ? this.bodyOf(baseline.id).netWorthPath : st.netWorthPath,
        baseline?.actualNetWorth != null
          ? { at: Date.parse(baseline.takenAt), value: baseline.actualNetWorth }
          : { at: this.now(), value: actual },
        new Date(this.now()),
      );
      current = {
        id: "now",
        planId,
        planName: plan.name,
        takenAt: new Date(this.now()).toISOString(),
        trigger: "api",
        planVersion: plan.version,
        householdVersion: this.households.version(plan.householdId),
        // Monte Carlo is not re-run here: the last stored chance of success is carried over.
        successRate: baseline?.successRate ?? null,
        fiYear: st.fiYear,
        actualNetWorth: Math.round(actual),
        plannedNetWorth: planned === null ? null : Math.round(planned),
        netWorthVsPlan:
          planned && planned !== 0
            ? {
                delta: Math.round(actual - planned),
                ratio: Math.round((actual / planned - 1) * 10_000) / 10_000,
              }
            : null,
        endNetWorthReal: st.endNetWorthReal,
        depletionYear: st.depletionYear,
        milestones: st.milestones,
        findings: st.findings,
        currency: this.households.get(plan.householdId).household.currency,
      };
    }
    const cfg = this.getConfig();
    const changes = baseline ? this.detect(baseline, current, cfg.thresholds) : [];
    const recent = this.notifications({ since: since ?? undefined, planId, limit: 100 });
    return {
      planId,
      planName: plan0.name,
      since,
      lastCheckIn: baseline,
      current,
      planVersionNow: plan.version,
      planVersionAtCheckIn: baseline?.planVersion ?? null,
      householdChanged: baseline ? baseline.householdVersion !== current.householdVersion : null,
      netWorth: baseline
        ? {
            atCheckIn: baseline.actualNetWorth,
            now: current.actualNetWorth,
            change:
              baseline.actualNetWorth !== null && current.actualNetWorth !== null
                ? current.actualNetWorth - baseline.actualNetWorth
                : null,
          }
        : null,
      edits: edits.map((e) => ({ ...e, actor: e.actor as unknown })),
      changes,
      notifications: recent,
      note: baseline
        ? "The chance of success shown is from your last check-in. Check in again to recalculate it with your latest balances."
        : "This plan has no check-in yet. Check in to record where you stand today and track changes from here.",
    };
  }

  // ----------------------------------------------------------------------------- notifications
  private notify(c: Change, h: HealthRecord): NotificationView {
    const id = newId("ntf");
    const body = { ...c.detail, planName: h.planName, checkInId: h.id };
    this.db
      .insert(notifications)
      .values({
        id,
        kind: c.kind,
        severity: c.severity,
        planId: h.planId,
        healthId: h.id,
        title: c.title,
        body,
      })
      .run();
    const n = this.notification(id);
    this.ctx.events.publish("notification.created", {
      notificationId: id,
      kind: n.kind,
      severity: n.severity,
      planId: n.planId,
      title: n.title,
    });
    return n;
  }

  private toNotification(r: typeof notifications.$inferSelect): NotificationView {
    return {
      id: r.id,
      createdAt: r.createdAt,
      kind: r.kind,
      severity: r.severity,
      planId: r.planId,
      healthId: r.healthId,
      title: r.title,
      body: r.body,
      read: r.readAt !== null,
    };
  }

  notification(id: string): NotificationView {
    const r = this.db.select().from(notifications).where(eq(notifications.id, id)).get();
    if (!r) throw notFound("notification", id);
    return this.toNotification(r);
  }

  notifications(
    o: {
      unread?: boolean | undefined;
      since?: string | undefined;
      planId?: string | undefined;
      limit?: number | undefined;
    } = {},
  ): NotificationView[] {
    const conds = [];
    if (o.unread) conds.push(isNull(notifications.readAt));
    if (o.since) conds.push(gt(notifications.createdAt, o.since));
    if (o.planId) conds.push(eq(notifications.planId, o.planId));
    return this.db
      .select()
      .from(notifications)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(notifications.createdAt), asc(notifications.id))
      .limit(Math.min(o.limit ?? 50, 500))
      .all()
      .map((r) => this.toNotification(r));
  }

  markRead(ids: string[] | "all"): number {
    const at = nowIso();
    if (ids === "all")
      return this.db
        .update(notifications)
        .set({ readAt: at })
        .where(isNull(notifications.readAt))
        .run().changes;
    let n = 0;
    for (const id of ids)
      n += this.db
        .update(notifications)
        .set({ readAt: at })
        .where(and(eq(notifications.id, id), isNull(notifications.readAt)))
        .run().changes;
    return n;
  }

  unreadCount(): number {
    return this.notifications({ unread: true, limit: 500 }).length;
  }
}
