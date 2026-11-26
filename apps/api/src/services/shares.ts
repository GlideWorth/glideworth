/**
 * Shareable read-only links to a plan's RESULTS.
 *
 * A link carries a precomputed snapshot of the plan's computed results (taken when the link is created or
 * refreshed). The public route serves that snapshot and nothing else: it never reads the household, other
 * plans, accounts, people or settings, and it never computes (so an anonymous caller cannot cost CPU).
 * The token is 256 random bits, stored as sha256, shown once. Links expire and can be revoked.
 *
 * Privacy modes (what the snapshot contains):
 *   full     amounts in the household currency
 *   percent  every amount as a percentage of the plan's starting net worth (no currency, no absolute figure)
 *   hidden   no amounts at all: success rate, years, milestones and whether each year is funded
 */
import { createHash, randomBytes } from "node:crypto";
import type { Actor, MonteCarloResult, ProjectionResult, ValueBasis } from "@glideworth/core";
import { desc, eq } from "drizzle-orm";
import { shareLinks } from "../db/schema.js";
import { ApiError, notFound } from "../errors.js";
import { totalInBasis } from "../money.js";
import { newId, nowIso } from "../util.js";
import type { ServiceCtx } from "./context.js";
import type { HouseholdsService } from "./households.js";
import type { PlansService } from "./plans.js";
import type { SimulationService } from "./simulation.js";

export type SharePrivacy = "full" | "percent" | "hidden";
export const MAX_SHARE_DAYS = 365;

/** How the chance of success was attached to a new link. `pending` means the run continues after the response. */
export type ShareMonteCarlo =
  | { status: "skipped" }
  | { status: "included" }
  | { status: "pending"; jobId: string }
  | { status: "unavailable" };

export interface ShareLinkInfo {
  id: string;
  planId: string;
  label: string | null;
  privacy: SharePrivacy;
  basis: ValueBasis;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  status: "active" | "expired" | "revoked";
  snapshotAt: string;
  viewCount: number;
  lastViewedAt: string | null;
  createdBy: unknown;
}

// The `cairn-share:` domain separator predates the rename and is part of every stored token hash: it stays, so
// links shared before the upgrade keep working.
/**
 * Stored beside the snapshot, never served: the owner asked for the chance of success on this link. Refresh
 * reads it, so a link whose first run failed or was still running gets the figure on the next refresh.
 */
const WANTS_SUCCESS_RATE = "_successRateRequested";
/** How long a link waits for a Monte Carlo run it was returned ahead of. Queued runs can take minutes. */
const DEFERRED_RUN_WAIT_MS = 15 * 60_000;

type StoredSnapshot = {
  generatedAt?: string;
  summary?: { monteCarloTrials?: number | null } & Record<string, unknown>;
  [WANTS_SUCCESS_RATE]?: boolean;
} & Record<string, unknown>;

const wantsSuccessRate = (snap: StoredSnapshot): boolean =>
  snap[WANTS_SUCCESS_RATE] === true || snap.summary?.monteCarloTrials != null;

const hashToken = (t: string) => createHash("sha256").update(`cairn-share:${t}`).digest("hex");
const pct1 = (n: number) => Math.round(n * 1000) / 10;

export interface SharesOptions {
  /** Cloud: routed `gws_<account>_<secret>` tokens (the public route finds the workspace from them). */
  mintToken?: () => string;
  /** Cloud: most active (unexpired, unrevoked) links a workspace may have. */
  maxActive?: () => number;
}

export class SharesService {
  constructor(
    private readonly ctx: ServiceCtx,
    private readonly plans: PlansService,
    private readonly households: HouseholdsService,
    private readonly sim: SimulationService,
    private readonly opts: SharesOptions = {},
  ) {}
  private get db() {
    return this.ctx.db;
  }

  private info(r: typeof shareLinks.$inferSelect): ShareLinkInfo {
    const now = nowIso();
    return {
      id: r.id,
      planId: r.planId,
      label: r.label,
      privacy: r.privacy,
      basis: r.basis,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      revokedAt: r.revokedAt,
      status: r.revokedAt ? "revoked" : r.expiresAt <= now ? "expired" : "active",
      snapshotAt: r.snapshotAt,
      viewCount: r.viewCount,
      lastViewedAt: r.lastViewedAt,
      createdBy: r.createdBy,
    };
  }

  /**
   * Start (or reuse) the plan's Monte Carlo run. `defer` returns as soon as the job is queued so creating
   * a link does not wait for a full run; the caller fills the snapshot in when the job finishes. A result
   * already in the cache is included immediately either way.
   */
  private async monteCarloFigure(
    planId: string,
    actor: Actor,
    defer: boolean,
  ): Promise<
    | { status: "included"; successRate: number; trials: number }
    | { status: "pending"; jobId: string }
    | { status: "unavailable" }
  > {
    try {
      const job = this.sim.startMonteCarlo(planId, { keepTrials: false, randomSeed: false }, actor);
      if (job.status === "succeeded") {
        const mc = this.sim.jobs.result(job.id) as MonteCarloResult;
        return { status: "included", successRate: mc.successRate, trials: mc.trials };
      }
      if (defer) return { status: "pending", jobId: job.id };
      const done = await this.sim.jobs.waitFor(job.id, 120_000);
      if (done.status !== "succeeded") return { status: "unavailable" };
      const mc = this.sim.jobs.result(job.id) as MonteCarloResult;
      return { status: "included", successRate: mc.successRate, trials: mc.trials };
    } catch {
      // The link still works without a Monte Carlo figure.
      return { status: "unavailable" };
    }
  }

  /**
   * Write the finished run onto a link that was created before the run completed. `generatedAt` names the
   * snapshot the run belongs to: a link refreshed since then has a newer snapshot (perhaps of an edited
   * plan) with its own figure, and this run must not overwrite it.
   */
  private writeSuccessRate(
    linkId: string,
    generatedAt: string,
    successRate: number,
    trials: number,
  ): void {
    const r = this.db.select().from(shareLinks).where(eq(shareLinks.id, linkId)).get();
    if (!r || r.revokedAt) return;
    const snap = r.snapshot as StoredSnapshot;
    if (snap.generatedAt !== generatedAt) return;
    this.db
      .update(shareLinks)
      .set({
        snapshot: {
          ...snap,
          summary: { ...(snap.summary ?? {}), successRate, monteCarloTrials: trials },
        },
        snapshotAt: nowIso(),
      })
      .where(eq(shareLinks.id, linkId))
      .run();
  }

  private attachMonteCarlo(linkId: string, generatedAt: string, jobId: string): void {
    void this.sim.jobs
      .waitFor(jobId, DEFERRED_RUN_WAIT_MS)
      .then((done) => {
        if (done.status !== "succeeded") return;
        const mc = this.sim.jobs.result(jobId) as MonteCarloResult;
        this.writeSuccessRate(linkId, generatedAt, mc.successRate, mc.trials);
      })
      .catch(() => {
        // The link stays without a figure; Refresh can try again.
      });
  }

  /** The public payload. Built only from the plan's computed results. */
  private async snapshot(
    planId: string,
    o: {
      privacy: SharePrivacy;
      basis: ValueBasis;
      label: string | null;
      successRate: boolean;
      expiresAt: string;
    },
    actor: Actor,
    defer = false,
  ): Promise<{ view: ReturnType<typeof buildPublicView>; monteCarlo: ShareMonteCarlo }> {
    const plan = this.plans.get(planId);
    const { result } = this.sim.projection(planId, { trace: "off" });
    let successRate: number | null = null;
    let trials: number | null = null;
    let monteCarlo: ShareMonteCarlo = { status: "skipped" };
    if (o.successRate) {
      const figure = await this.monteCarloFigure(planId, actor, defer);
      if (figure.status === "included") {
        successRate = figure.successRate;
        trials = figure.trials;
        monteCarlo = { status: "included" };
      } else {
        monteCarlo = figure;
      }
    }
    return {
      view: buildPublicView(result, {
        planName: plan.name,
        currency: this.households.get(plan.householdId).household.currency,
        ...o,
        successRate,
        trials,
      }),
      monteCarlo,
    };
  }

  async create(
    planId: string,
    input: {
      label?: string | undefined;
      privacy: SharePrivacy;
      basis: ValueBasis;
      expiresInDays?: number | undefined;
      includeSuccessRate: boolean;
      /** Return the link before the Monte Carlo run finishes, and fill the figure in afterwards. */
      deferMonteCarlo?: boolean;
    },
    actor: Actor,
  ): Promise<{ link: ShareLinkInfo; token: string; monteCarlo: ShareMonteCarlo }> {
    this.plans.get(planId);
    const max = this.opts.maxActive?.();
    if (max !== undefined) {
      const now = nowIso();
      const active = this.db
        .select()
        .from(shareLinks)
        .all()
        .filter((r) => !r.revokedAt && r.expiresAt > now).length;
      if (active >= max)
        throw new ApiError(
          409,
          "LIMIT_REACHED",
          `a workspace can have at most ${max} active share links`,
          {
            limit: max,
          },
        );
    }
    const days = Math.min(Math.max(input.expiresInDays ?? 30, 1), MAX_SHARE_DAYS);
    const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
    const label = input.label?.trim() || null;
    const snap = await this.snapshot(
      planId,
      {
        privacy: input.privacy,
        basis: input.basis,
        label,
        successRate: input.includeSuccessRate,
        expiresAt,
      },
      actor,
      input.deferMonteCarlo === true,
    );
    const token =
      this.opts.mintToken?.() ?? `glideworth_share_${randomBytes(32).toString("base64url")}`;
    const id = newId("shr");
    this.db
      .insert(shareLinks)
      .values({
        id,
        planId,
        tokenHash: hashToken(token),
        label,
        privacy: input.privacy,
        basis: input.basis,
        expiresAt,
        snapshot: { ...snap.view, [WANTS_SUCCESS_RATE]: input.includeSuccessRate },
        snapshotAt: nowIso(),
        createdBy: actor,
      })
      .run();
    if (snap.monteCarlo.status === "pending")
      this.attachMonteCarlo(id, snap.view.generatedAt, snap.monteCarlo.jobId);
    return { link: this.get(id), token, monteCarlo: snap.monteCarlo };
  }

  get(id: string): ShareLinkInfo {
    const r = this.db.select().from(shareLinks).where(eq(shareLinks.id, id)).get();
    if (!r) throw notFound("share link", id);
    return this.info(r);
  }

  list(planId?: string): ShareLinkInfo[] {
    return this.db
      .select()
      .from(shareLinks)
      .where(planId ? eq(shareLinks.planId, planId) : undefined)
      .orderBy(desc(shareLinks.createdAt))
      .all()
      .map((r) => this.info(r));
  }

  revoke(id: string): ShareLinkInfo {
    this.get(id);
    this.db.update(shareLinks).set({ revokedAt: nowIso() }).where(eq(shareLinks.id, id)).run();
    return this.get(id);
  }

  /** Recompute the snapshot (the plan changed) without changing the token or expiry. */
  async refresh(id: string, actor: Actor): Promise<ShareLinkInfo> {
    const r = this.db.select().from(shareLinks).where(eq(shareLinks.id, id)).get();
    if (!r) throw notFound("share link", id);
    if (r.revokedAt) throw new ApiError(409, "CONFLICT", "this link is revoked");
    const wanted = wantsSuccessRate(r.snapshot as StoredSnapshot);
    const snap = await this.snapshot(
      r.planId,
      {
        privacy: r.privacy,
        basis: r.basis,
        label: r.label,
        // Keep what the link was created with, including a figure that was asked for and never arrived
        // (the run failed, was cancelled, or is still going): this refresh runs it again.
        successRate: wanted,
        expiresAt: r.expiresAt,
      },
      actor,
    );
    this.db
      .update(shareLinks)
      .set({ snapshot: { ...snap.view, [WANTS_SUCCESS_RATE]: wanted }, snapshotAt: nowIso() })
      .where(eq(shareLinks.id, id))
      .run();
    return this.get(id);
  }

  /**
   * The public read. Unknown, expired and revoked tokens are indistinguishable (one 404), so a caller learns
   * nothing about which tokens ever existed.
   */
  /** Whether `token` names a live link (not revoked, not expired). Reads only: no view is counted. */
  isLive(token: string): boolean {
    const r = this.db
      .select({ revokedAt: shareLinks.revokedAt, expiresAt: shareLinks.expiresAt })
      .from(shareLinks)
      .where(eq(shareLinks.tokenHash, hashToken(token)))
      .get();
    return !!r && !r.revokedAt && r.expiresAt > nowIso();
  }

  publicView(token: string): unknown {
    const r = this.db
      .select()
      .from(shareLinks)
      .where(eq(shareLinks.tokenHash, hashToken(token)))
      .get();
    if (!r || r.revokedAt || r.expiresAt <= nowIso())
      throw new ApiError(404, "NOT_FOUND", "this link does not exist, has expired or was revoked");
    this.db
      .update(shareLinks)
      .set({ viewCount: r.viewCount + 1, lastViewedAt: nowIso() })
      .where(eq(shareLinks.id, r.id))
      .run();
    const { [WANTS_SUCCESS_RATE]: _private, ...view } = r.snapshot as StoredSnapshot;
    return view;
  }
}

/** Pure: the public payload for a projection. Nothing about the household's people, accounts or other plans. */
export function buildPublicView(
  result: ProjectionResult,
  o: {
    planName: string;
    currency: string;
    privacy: SharePrivacy;
    basis: ValueBasis;
    label: string | null;
    successRate: number | null;
    trials: number | null;
    expiresAt: string;
  },
) {
  const first = result.periods[0];
  const start = first ? totalInBasis("netWorth", first.totals.netWorth, first, o.basis) : 0;
  if (o.privacy === "percent" && !(start > 0))
    throw new ApiError(
      422,
      "SCENARIO",
      "'percent' needs a positive starting net worth to scale against; use privacy 'hidden' instead",
    );
  const amount = (key: string, v: number, p: Parameters<typeof totalInBasis>[2]): number | null => {
    if (o.privacy === "hidden") return null;
    const x = totalInBasis(key, v, p, o.basis);
    return o.privacy === "percent" ? pct1(x / start) : Math.round(x);
  };
  const last = result.periods[result.periods.length - 1];
  const fi = result.milestones.find(
    (m) =>
      /financial independence|\bFIRE?\b|(^|[-_])fi($|[-_])/i.test(`${m.milestoneId} ${m.name}`) &&
      m.status === "reached",
  );
  return {
    kind: "glideworth-shared-plan",
    version: 1,
    generatedAt: nowIso(),
    expiresAt: o.expiresAt,
    label: o.label,
    plan: { name: o.planName },
    privacy: o.privacy,
    ...(o.privacy === "hidden" ? {} : { currency: o.privacy === "full" ? o.currency : null }),
    unit:
      o.privacy === "full"
        ? "currency"
        : o.privacy === "percent"
          ? "percent-of-starting-net-worth"
          : "none",
    basis: o.basis,
    summary: {
      successRate: o.successRate,
      monteCarloTrials: o.trials,
      fundedThroughout: result.summary.firstShortfallYear === null,
      firstShortfallYear: result.summary.firstShortfallYear,
      retirementYear: result.summary.retirementYear,
      financialIndependenceYear: fi?.month ? Number(fi.month.slice(0, 4)) : null,
      startYear: first?.year ?? null,
      endYear: last?.year ?? null,
      endNetWorth: last ? amount("netWorth", last.totals.netWorth, last) : null,
    },
    milestones: result.milestones
      // Life-expectancy milestones name a person; they are not part of what is shared.
      .filter(
        (m) =>
          m.status === "reached" &&
          !/life.?expectancy|(^|[-_])le($|[-_])/i.test(`${m.milestoneId} ${m.name}`),
      )
      .map((m) => ({ name: m.name, month: m.month })),
    years: result.periods.map((p) => ({
      year: p.year,
      funded: p.totals.shortfall <= 0,
      netWorth: amount("netWorth", p.totals.netWorth, p),
      portfolio: amount("portfolio", p.totals.portfolio, p),
      income: amount("income", p.totals.income, p),
      spending: amount("spending", p.totals.spending, p),
      taxes: amount("taxes", p.totals.taxes, p),
    })),
    note:
      o.privacy === "percent"
        ? "All amounts are percentages of the plan’s starting net worth."
        : o.privacy === "hidden"
          ? "Amounts are hidden by the owner."
          : "A snapshot of the plan’s results; it does not update by itself.",
  };
}
