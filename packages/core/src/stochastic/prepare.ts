/**
 * Turns (input, settings, options) into everything a trial needs: the parsed engine input with
 * per-account fixed/custom overrides applied, the deterministic baseline, the base market rates,
 * the trial range and the seed. Uses only the engine's public contract (`simulate` + types).
 */
import { parseMonth, simulate } from "../engine/index.js";
import type { SimulateDeps } from "../engine/simulate.js";
import {
  type MarketPeriod,
  type ProjectionResult,
  SimulationInput,
  type SimulationInputInput,
} from "../engine/types.js";
import { ValidationError } from "../errors.js";
import { ACCOUNT_TYPE_INFO } from "../schema/account-types.js";
import type { AccountBehaviourPatch } from "../schema/accounts.js";
import {
  MonteCarloSettings,
  type MonteCarloSettingsInput,
  withReplacedDataset,
} from "../schema/montecarlo.js";
import { HISTORICAL_SERIES } from "./data/index.js";
import { hashString } from "./math.js";
import { type SamplerContext, trialCountFor } from "./samplers.js";
import {
  ALL_STOCHASTIC_METRICS,
  type StochasticMetric,
  type StochasticRunOptions,
} from "./types.js";

export interface PreparedRun {
  settings: MonteCarloSettings;
  input: SimulationInput;
  deps: SimulateDeps;
  baseline: ProjectionResult;
  base: MarketPeriod[];
  periods: number;
  years: number[];
  periodStarts: number[];
  ages: Record<string, number[]>;
  seed: number;
  totalTrials: number;
  from: number;
  to: number;
  sampler: SamplerContext;
  metrics: StochasticMetric[];
  milestones: { id: string; name: string }[];
  retirementId: string | null;
  bondShare: number;
  sequenceYears: number;
  fingerprint: string;
}

export interface PrepareOptions extends StochasticRunOptions {
  /** Inject a tax registry (or other engine deps) into every trial. */
  deps?: SimulateDeps;
}

export function parseSettings(
  settings: MonteCarloSettings | MonteCarloSettingsInput,
): MonteCarloSettings {
  const r = MonteCarloSettings.safeParse(withReplacedDataset(settings));
  if (!r.success)
    throw new ValidationError("invalid Monte Carlo settings", { issues: r.error.issues });
  return r.data;
}

export function prepareRun(
  rawInput: SimulationInput | SimulationInputInput,
  rawSettings: MonteCarloSettings | MonteCarloSettingsInput,
  options: PrepareOptions = {},
): PreparedRun {
  const settings = parseSettings(rawSettings);
  const parsed = SimulationInput.safeParse(rawInput);
  if (!parsed.success)
    throw new ValidationError("invalid simulation input", { issues: parsed.error.issues });
  const withHistorical = { historical: HISTORICAL_SERIES, ...options.deps };
  const deps: SimulateDeps = withHistorical;
  const original = parsed.data;
  const { market: _ignored, ...restOptions } = original.options;
  const leanOptions = { ...restOptions, lean: true, trace: "off" as const };
  const baseline = simulate({ ...original, options: leanOptions }, deps);
  const base = baseline.periods.map((p) => {
    const { sourceYear: _s, ...m } = p.market;
    return m;
  });
  const periods = baseline.periods.length;
  const input: SimulationInput = {
    ...original,
    plan: applyAccountOverrides(original, base[0], options),
    options: leanOptions,
  };

  const sampler: SamplerContext = { base, baseCurrency: input.household.currency };
  if (options.startYears) sampler.startYears = options.startYears;
  const totalTrials = trialCountFor(settings, periods, sampler);
  const from = Math.max(0, Math.min(totalTrials, options.trialOffset ?? 0));
  const to = Math.min(totalTrials, from + (options.trialCount ?? totalTrials));

  const plan = input.plan;
  const seed = (settings.seed ?? options.seed ?? hashString(`${plan.id}:${plan.version}`)) >>> 0;
  const primary = input.household.people.find((p) => p.role === "primary");
  const retirement = plan.milestones.find(
    (m) => m.enabled && m.kind === "retirement" && (!m.personId || m.personId === primary?.id),
  );
  const ba = plan.assumptions.bondAllocation;
  const bondShare =
    ba.kind === "fixed" ? ba.share : ba.kind === "glidepath" ? (ba.points[0]?.value ?? 0) : 0;
  const years = baseline.periods.map((p) => p.year);
  const periodStarts = baseline.periods.map((p) => parseMonth(p.startMonth));
  const last = baseline.periods[periods - 1];
  periodStarts.push(last ? parseMonth(last.startMonth) + last.months : 0);
  const ages: Record<string, number[]> = Object.create(null);
  for (const person of input.household.people)
    ages[person.id] = baseline.periods.map((p) => p.ages[person.id] ?? Number.NaN);
  const metrics = [...(options.metrics ?? ALL_STOCHASTIC_METRICS)];
  const milestones = plan.milestones
    .filter((m) => m.enabled)
    .map((m) => ({ id: m.id, name: m.name }));
  const sequenceYears = settings.sequenceRiskYears ?? 10;
  const fingerprint = hashString(
    JSON.stringify([
      settings,
      seed,
      totalTrials,
      plan.id,
      plan.version,
      years,
      metrics,
      options.startYears ?? null,
    ]),
  ).toString(16);
  return {
    settings,
    input,
    deps,
    baseline,
    base,
    periods,
    years,
    periodStarts,
    ages,
    seed,
    totalTrials,
    from,
    to,
    sampler,
    metrics,
    milestones,
    retirementId: retirement?.id ?? null,
    bondShare,
    sequenceYears,
    fingerprint,
  };
}

/**
 * Accounts with `behaviour.monteCarlo = 'fixed'` (or a `treatment: 'fixed'` override) keep the plan's
 * deterministic growth (and, unless the account holds bonds under a non-fixed allocation, dividend
 * yield) in every trial. Custom overrides pin explicit rates. The bond share of a mixed account still
 * follows the sampled bond return, as in ProjectionLab where bonds always follow plan-level settings.
 * Implemented as plan `accountSettings` patches, so the engine needs no special mode.
 */
function applyAccountOverrides(
  input: SimulationInput,
  base0: MarketPeriod | undefined,
  options: StochasticRunOptions,
): SimulationInput["plan"] {
  const plan = input.plan;
  const finances =
    plan.startingConditions.kind === "snapshot" ? plan.startingConditions.finances : input.finances;
  const accounts = [...finances.accounts, ...plan.plannedAccounts];
  let settings: Record<string, AccountBehaviourPatch> | null = null;
  for (const a of accounts) {
    const patch = plan.accountSettings[a.id] ?? {};
    const eff = { ...a.behaviour, ...patch };
    const override = options.accountOverrides?.[a.id];
    let growth: AccountBehaviourPatch["growth"];
    let dividendYield: number | undefined;
    if (override && "growth" in override) {
      growth = { kind: "fixed", rate: override.growth };
      dividendYield = override.dividendYield;
    } else if (
      (override?.treatment === "fixed" || eff.monteCarlo === "fixed") &&
      eff.growth.kind === "inherit"
    ) {
      if (!base0) continue;
      const cls = ACCOUNT_TYPE_INFO[a.type]?.assetClass ?? "portfolio";
      growth = {
        kind: "fixed",
        rate: cls === "cash" ? base0.cash : cls === "crypto" ? base0.crypto : base0.stocks,
      };
      if (cls === "portfolio" && eff.dividends.yield.kind === "inherit") {
        const share = staticBondShare(eff.bondAllocation, plan.assumptions.bondAllocation);
        if (share !== null)
          dividendYield = (1 - share) * base0.dividendYield + share * base0.bondYield;
      }
    } else continue;
    settings ??= Object.assign(
      Object.create(null) as Record<string, AccountBehaviourPatch>,
      plan.accountSettings,
    );
    const next: AccountBehaviourPatch = { ...patch, growth };
    if (dividendYield !== undefined)
      next.dividends = { ...eff.dividends, yield: { kind: "fixed", rate: dividendYield } };
    settings[a.id] = next;
  }
  return settings ? { ...plan, accountSettings: settings } : plan;
}

function staticBondShare(
  own: { kind: string; share?: number },
  planAlloc: SimulationInput["plan"]["assumptions"]["bondAllocation"],
): number | null {
  if (own.kind === "none") return 0;
  if (own.kind === "fixed") return own.share ?? 0;
  if (own.kind !== "inherit") return null;
  if (planAlloc.kind === "none") return 0;
  if (planAlloc.kind === "fixed") return planAlloc.share;
  return null;
}
