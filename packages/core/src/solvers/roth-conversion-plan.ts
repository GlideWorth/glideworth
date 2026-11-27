/**
 * Roth conversion plan (US): choose a conversion amount for each year and each person, say why, and
 * compare the result with making no conversions (and with the plan's current conversions, if any).
 *
 * How an amount is chosen. The engine runs the plan with the proposed conversions as one-year
 * transfer flows (traditional -> Roth, which the engine taxes as Roth conversions). After each
 * year's cash-flow settle a probe reads the year's final tax input: wages, pensions, the taxable
 * part of Social Security, interest, dividends, realised gains, RMDs and the withdrawals that paid
 * the year's bills and taxes. With this person's conversion taken out it asks the tax stack how
 * much more ordinary income fits under each ceiling:
 *   - bracket: the federal ordinary bracket rate stays at or below the chosen rate,
 *   - IRMAA:   MAGI stays at or below the chosen IRMAA tier (only in years when someone on the
 *              return is 63 or older, because the engine charges IRMAA from 65 on the MAGI of two
 *              years earlier),
 *   - ACA:     ACA MAGI stays at or below the premium tax credit cliff (`cliff` x FPL from the ACA
 *              table) in years with marketplace cover, unless the enhanced-credit law toggle is on.
 * The conversion is the smallest room, capped by what is left in the person's traditional accounts.
 * Because the conversion's own tax can be paid from traditional accounts (more income), the
 * amounts are iterated to a fixed point, so each year's final projection has the conversion filling
 * the room and no more. Thresholds come only from the existing tax tables (tax/data/us-federal.ts).
 *
 * Couples: each person has their own ceiling; people with the lower ceiling convert first, so the
 * higher ceiling is measured on top of the other spouse's conversion (a joint return has one set of
 * brackets).
 *
 * Choosing the ceilings ("auto", when no `targets` are given): try each bracket (and no conversion)
 * for everyone, then improve block by block (`blockYears` per block, per person) on the objective
 * (after-tax wealth at the end of the plan by default), keeping only changes that do not bring a
 * shortfall forward. Deterministic: the same plan gives the same schedule.
 *
 * Estimates, not advice. Pure: no clock, no randomness.
 */
import { z } from "zod";
import { isOpen, isWithdrawable } from "../engine/accounts.js";
import { formatMonth } from "../engine/dates.js";
import type { EngineContext, PeriodState } from "../engine/context.js";
import { buildTaxInput } from "../engine/settle.js";
import { simulate as coreSimulate } from "../engine/simulate.js";
import type { ProjectionResult, SimulationInput } from "../engine/types.js";
import { ScenarioError } from "../errors.js";
import { netLegacyAtEnd } from "../insights/analytics.js";
import { fmtMoney, pluralDuration } from "../insights/format.js";
import { applyPlanPatch } from "../insights/patch.js";
import { ACCOUNT_TYPE_INFO } from "../schema/account-types.js";
import type { PatchOp } from "../schema/changes.js";
import { Id, Rate } from "../schema/primitives.js";
import { runTaxStack, stackTotal } from "../tax/analytics.js";
import { pickYear } from "../tax/common.js";
import { US_ACA_YEARS, US_FEDERAL_2026 } from "../tax/data/us-federal.js";
import { largestSatisfying, type TaxTarget, targetSatisfied } from "../tax/strategy.js";
import type { TaxJurisdiction, TaxWithdrawalItem, TaxYearInput } from "../tax/types.js";
import type { SolverDeps } from "./contracts.js";
import { checkAbort, makeMetric } from "./search.js";
import { planFinances } from "./variables.js";

// ------------------------------------------------------------------------------------- request

export const RothConversionTarget = z
  .object({
    personId: Id.optional().describe("Whose conversions this applies to; omit for everyone."),
    fromYear: z.number().int().min(1900).max(2300).optional(),
    toYear: z.number().int().min(1900).max(2300).optional(),
    bracketRate: Rate.nullable().describe(
      "Convert up to the top of this federal bracket (0.22 = the 22% bracket); null = no conversion in these years.",
    ),
  })
  .meta({ id: "RothConversionTarget" });
export type RothConversionTarget = z.infer<typeof RothConversionTarget>;

export const RothConversionPlanRequest = z
  .object({
    targets: z
      .array(RothConversionTarget)
      .max(200)
      .optional()
      .describe(
        "Your own ceilings by person and year (later entries win). Omit to let the planner choose the bracket for each block of years.",
      ),
    irmaaTier: z
      .number()
      .int()
      .min(1)
      .max(5)
      .nullable()
      .default(null)
      .describe(
        "Also keep MAGI at or below this IRMAA tier (1 = no surcharge) in years when someone is 63 or older. Null = no IRMAA ceiling.",
      ),
    aca: z
      .boolean()
      .default(true)
      .describe(
        "Keep income under the ACA premium tax credit cliff in years with marketplace cover.",
      ),
    fromYear: z.number().int().min(1900).max(2300).optional(),
    toYear: z.number().int().min(1900).max(2300).optional(),
    objective: z
      .enum(["afterTaxEndWealth", "lifetimeTax"])
      .default("afterTaxEndWealth")
      .describe(
        "What the planner optimises when it chooses ceilings: after-tax wealth at the end (net legacy, today's money) or lifetime tax.",
      ),
    blockYears: z.number().int().min(1).max(50).default(5),
    bracketRates: z
      .array(Rate)
      .max(10)
      .optional()
      .describe("Brackets the planner may choose from (default: the federal rates up to 32%)."),
    sourceAccountIds: z.array(Id).max(50).optional(),
    successRate: z
      .boolean()
      .default(false)
      .describe("Also run Monte Carlo (chance of success) for each compared plan (slower)."),
    maxEvaluations: z.number().int().min(1).max(500).default(150),
  })
  .meta({ id: "RothConversionPlanRequest" });
export type RothConversionPlanRequest = z.input<typeof RothConversionPlanRequest>;

// -------------------------------------------------------------------------------------- result

export type CeilingKind = "bracket" | "irmaa" | "aca";
export type RothBinding =
  | CeilingKind
  | "balance"
  | "already-above-ceiling"
  | "no-ceiling"
  | "no-source"
  | "not-alive";

export interface RothConversionYear {
  year: number;
  personId: string;
  personName: string;
  /** Converted this year (nominal money of that year). */
  amount: number;
  amountReal: number;
  /** The bracket ceiling used (null: no conversion planned this year). */
  bracketRate: number | null;
  /** What stopped the conversion. */
  binding: RothBinding;
  /** Room under each ceiling before this person's conversion (nominal). */
  ceilings: { kind: CeilingKind; label: string; room: number }[];
  /** The smallest room (nominal; null when no ceiling applied). */
  room: number | null;
  /** Room left unused after converting (nominal; null when no ceiling applied). */
  roomLeft: number | null;
  /** Left in the person's traditional accounts before converting (nominal). */
  available: number;
  /** The year's income without this person's conversion. */
  otherIncome: { agi: number; magi: number; taxableIncome: number };
  /** Estimated extra tax this year caused by the conversion (nominal and today's money). */
  taxOnConversion: number;
  taxOnConversionReal: number;
  sources: { accountId: string; amount: number }[];
  /** Plain-language reason a person can check. */
  reason: string;
}

export interface RothConversionOutcome {
  id: "none" | "current" | "proposed";
  label: string;
  lifetimeTaxReal: number;
  /** Net legacy at the end of the plan (after estate tax, heirs' tax on pensions, costs), today's money. */
  afterTaxEndWealthReal: number;
  endNetWorthReal: number;
  totalConvertedReal: number;
  success: boolean;
  firstShortfallYear: number | null;
  successRate: number | null;
}

export interface RothConversionPlan {
  status: "ok" | "unsupported";
  verdict: "convert" | "no-conversions";
  summary: string;
  /** The ceilings used, per person and block of years. */
  targets: { personId: string; fromYear: number; toYear: number; bracketRate: number | null }[];
  schedule: RothConversionYear[];
  outcomes: RothConversionOutcome[];
  /** Ops that apply the proposed schedule; propose them as a change set (empty for no conversions). */
  patch: PatchOp[];
  assumptions: string[];
  evaluations: number;
  /** Engine runs used (each evaluation iterates the amounts to a fixed point). */
  simulations: number;
  converged: boolean;
}

// ---------------------------------------------------------------------------------- constants

/** Flow ids of the proposed conversions start with this; the planner recognises its own. */
export const ROTH_PLAN_FLOW_PREFIX = "roth-plan-";
const FEDERAL_ID = "us-federal";
/** Source types never converted by default: inherited IRAs cannot be converted, SIMPLE IRAs have a two-year rule. */
const EXCLUDED_SOURCES = new Set(["inherited-ira", "simple-ira"]);
const SOURCE_PRIORITY = ["traditional-ira", "sep-ira"];

export const ROTH_PLAN_ASSUMPTIONS: readonly string[] = [
  "Estimates from the plan's assumptions, not tax advice.",
  "The bracket ceiling is the federal ordinary-income bracket; long-term gains and qualified dividends do not move it, but they count toward MAGI (IRMAA, ACA) and the conversion's tax.",
  "IRMAA is checked on the conversion year's MAGI when someone on the return is 63 or older (the engine charges IRMAA from 65 on MAGI from two years earlier).",
  "The ACA ceiling keeps ACA MAGI at or below the cliff multiple of the poverty line from the ACA table; it does not apply when the enhanced-credit law toggle is on.",
  "Room is measured as if the whole conversion were taxable (nondeductible IRA basis is ignored when sizing), which can leave a little room unused.",
  "State income tax is in the tax cost and outcomes but is not a ceiling.",
  "After-tax wealth at the end uses the plan's estate settings, including the heirs' tax rate on pensions (tax.estate.heirTaxDeferredRate); that assumption decides much of the comparison.",
  "Inherited and SIMPLE IRAs are not converted. Each conversion's own five-year clock for early withdrawals is not modelled.",
  "Conversions run once a year with the year's other flows; years in the plan's first partial year count as a whole conversion.",
];

// ------------------------------------------------------------------------------------ helpers

interface Person {
  id: string;
  name: string;
  index: number;
  sources: string[];
  destination: string | null;
  plannedDestination: boolean;
}

type Rates = Map<string, Map<number, number | null>>; // personId -> year -> bracket rate (null: none)
type Amounts = Map<string, Map<number, number>>; // personId -> year -> amount

interface ProbeRow {
  year: number;
  personId: string;
  start: number;
  end: number;
  piStart: number;
  rate: number | null;
  available: number;
  converted: number;
  room: number | null;
  ceilings: { kind: CeilingKind; label: string; room: number }[];
  binding: RothBinding;
  next: number;
  alive: boolean;
  otherIncome: { agi: number; magi: number; taxableIncome: number };
  taxOnConversion: number;
  balances: { accountId: string; available: number }[];
}

const mine = (w: TaxWithdrawalItem) =>
  w.isConversion === true && (w.causeId?.startsWith(ROTH_PLAN_FLOW_PREFIX) ?? false);

function merged(outs: ReturnType<typeof runTaxStack>): Record<string, number> {
  const f: Record<string, number> = {};
  for (const o of outs) Object.assign(f, o.facts);
  return f;
}

function people(input: SimulationInput, req: z.infer<typeof RothConversionPlanRequest>): Person[] {
  const fin = planFinances(input);
  const excluded = new Set(input.plan.excludedIds);
  const accounts = [...fin.accounts, ...input.plan.plannedAccounts].filter(
    (a) => !a.archived && !excluded.has(a.id),
  );
  return input.household.people.map((p, index) => {
    const own = accounts.filter((a) => a.owner === p.id);
    const sources = (
      req.sourceAccountIds
        ? own.filter((a) => req.sourceAccountIds!.includes(a.id))
        : own.filter(
            (a) =>
              ACCOUNT_TYPE_INFO[a.type].taxTreatment === "tax-deferred" &&
              ACCOUNT_TYPE_INFO[a.type].country === "US" &&
              !EXCLUDED_SOURCES.has(a.type) &&
              !a.inherited,
          )
    )
      .map((a, i) => ({ a, i }))
      .sort((x, y) => {
        const px = SOURCE_PRIORITY.indexOf(x.a.type);
        const py = SOURCE_PRIORITY.indexOf(y.a.type);
        return (px < 0 ? 99 : px) - (py < 0 ? 99 : py) || x.i - y.i;
      })
      .map((x) => x.a.id);
    const roth = own.find((a) => a.type === "roth-ira");
    return {
      id: p.id,
      name: p.name,
      index,
      sources,
      destination: roth?.id ?? (sources.length > 0 ? `${ROTH_PLAN_FLOW_PREFIX}roth-${p.id}` : null),
      plannedDestination: !roth && sources.length > 0,
    };
  });
}

/** The plan with every existing conversion switched off (tax strategy conversions, conversion flows). */
function noConversionPatch(input: SimulationInput): PatchOp[] {
  const ops: PatchOp[] = [];
  const ts = input.plan.taxStrategy;
  if (ts?.enabled && ts.modules.rothConversions)
    ops.push({ op: "replace", path: "/taxStrategy/modules/rothConversions", value: false });
  for (const f of existingConversionFlows(input))
    ops.push({ op: "replace", path: `/flows/[id=${f}]/enabled`, value: false });
  return ops;
}

function existingConversionFlows(input: SimulationInput): string[] {
  const fin = planFinances(input);
  const byId = new Map([...fin.accounts, ...input.plan.plannedAccounts].map((a) => [a.id, a]));
  return input.plan.flows
    .filter((f) => {
      if (f.kind !== "transfer" || !f.enabled || f.to.kind !== "account") return false;
      if (f.taxHandling === "tax-exempt") return false;
      const src = byId.get(f.fromAccountId);
      const dst = byId.get(f.to.accountId);
      return (
        !!src &&
        !!dst &&
        ACCOUNT_TYPE_INFO[src.type].taxTreatment === "tax-deferred" &&
        ACCOUNT_TYPE_INFO[dst.type].taxTreatment === "tax-free"
      );
    })
    .map((f) => f.id);
}

function hasCurrentConversions(input: SimulationInput): boolean {
  const ts = input.plan.taxStrategy;
  return (!!ts?.enabled && ts.modules.rothConversions) || existingConversionFlows(input).length > 0;
}

const flowId = (personId: string, year: number, accountId: string) =>
  `${ROTH_PLAN_FLOW_PREFIX}${year}-${personId}-${accountId}`.slice(0, 64);

/** Ops adding the schedule as one-year transfer flows (plus a Roth IRA where a person has none). */
function schedulePatch(
  input: SimulationInput,
  persons: Person[],
  rows: {
    personId: string;
    year: number;
    start: number;
    end: number;
    sources: { accountId: string; amount: number }[];
  }[],
): PatchOp[] {
  const ops: PatchOp[] = [];
  const used = new Set(rows.filter((r) => r.sources.length > 0).map((r) => r.personId));
  for (const p of persons) {
    if (!p.plannedDestination || !used.has(p.id) || !p.destination) continue;
    ops.push({
      op: "add",
      path: "/plannedAccounts/-",
      value: {
        id: p.destination,
        name: `${p.name}'s Roth IRA (for conversions)`,
        type: "roth-ira",
        owner: p.id,
        balance: 0,
        contributionBasis: 0,
        opensAt: { kind: "planStart" },
      },
    } as PatchOp);
  }
  for (const r of rows) {
    const p = persons.find((x) => x.id === r.personId)!;
    for (const s of r.sources) {
      if (s.amount <= 0) continue;
      ops.push({
        op: "add",
        path: "/flows/-",
        value: {
          id: flowId(p.id, r.year, s.accountId),
          kind: "transfer",
          name: `Roth conversion ${r.year} (${p.name})`,
          owner: p.id,
          range: {
            start: { kind: "date", date: formatMonth(r.start) },
            end: { kind: "date", date: formatMonth(r.end) },
          },
          fromAccountId: s.accountId,
          to: { kind: "account", accountId: p.destination! },
          amount: {
            kind: "amount",
            amount: { value: Math.floor(s.amount), basis: "nominal" },
            frequency: "once",
          },
          taxHandling: "auto",
        },
      } as PatchOp);
    }
  }
  void input;
  return ops;
}

// ---------------------------------------------------------------------------------- the probe

interface ProbeConfig {
  persons: Person[];
  rates: Rates;
  irmaaTier: number | null;
  aca: boolean;
  /** Compute full rooms and tax costs (the reporting run), not only what the next pass needs. */
  detail: boolean;
  /** Rooms found earlier (person|year|ceiling): searches start there. Speed only, never the answer. */
  hints: Map<string, number>;
}

/**
 * Largest x in [0, max] with fits(x) (to `tol`), searching outward from a hint: when the hint is
 * close, a handful of tax runs instead of a full bisection. Same answer as `largestSatisfying` up
 * to `tol`; the caller rounds to whole units.
 */
function searchFrom(
  fits: (x: number) => boolean,
  hint: number | undefined,
  max: number,
  tol: number,
): number {
  if (!fits(0)) return 0;
  if (hint === undefined || !(hint > 0)) return largestSatisfying(fits, max, tol);
  const h = Math.min(hint, max);
  let lo: number;
  let hi: number;
  let step = Math.max(tol, 1);
  if (fits(h)) {
    lo = h;
    if (lo >= max) return max;
    hi = Math.min(max, lo + step);
    while (fits(hi)) {
      lo = hi;
      if (lo >= max) return max;
      step *= 4;
      hi = Math.min(max, lo + step);
    }
  } else {
    hi = h;
    lo = Math.max(0, hi - step);
    while (lo > 0 && !fits(lo)) {
      hi = lo;
      step *= 4;
      lo = Math.max(0, hi - step);
    }
  }
  while (hi - lo > tol) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

function ceilingTargets(
  input: TaxYearInput,
  ps: PeriodState,
  rate: number,
  cfg: ProbeConfig,
): { kind: CeilingKind; label: string; target: TaxTarget }[] {
  const out: { kind: CeilingKind; label: string; target: TaxTarget }[] = [
    {
      kind: "bracket",
      label: `the top of the ${(rate * 100).toFixed(0)}% bracket`,
      target: { kind: "bracket", rate },
    },
  ];
  if (cfg.irmaaTier !== null && input.people.some((p) => p.alive && p.age + 2 >= 65))
    out.push({
      kind: "irmaa",
      label:
        cfg.irmaaTier === 1
          ? "the first IRMAA threshold (no Medicare surcharge)"
          : `the top of IRMAA tier ${cfg.irmaaTier}`,
      target: { kind: "irmaa-tier", tier: cfg.irmaaTier },
    });
  if (cfg.aca && ps.aca && !(input.config.lawToggles["us.acaEnhanced"] ?? false))
    out.push({
      kind: "aca",
      label: "the ACA premium tax credit limit",
      target: { kind: "aca-fpl-multiple", multiple: acaCliff(input) },
    });
  return out;
}

/** The premium tax credit cliff (multiple of the poverty line) from the ACA table of the year. */
function acaCliff(input: TaxYearInput): number {
  return pickYear(US_ACA_YEARS, input.year).cliff;
}

function makeProbe(cfg: ProbeConfig, rows: ProbeRow[]) {
  return (ctx: EngineContext, ps: PeriodState) => {
    const year = ps.bounds.year;
    const stack: TaxJurisdiction[] = ps.stack.filter((j) => j.status === "implemented");
    if (!stack.some((j) => j.id === FEDERAL_ID)) return;
    const active = cfg.persons
      .map((p) => ({ p, rate: cfg.rates.get(p.id)?.get(year) }))
      .filter((x): x is { p: Person; rate: number | null } => x.rate !== undefined);
    if (active.length === 0) return;
    active.sort((a, b) => (a.rate ?? -1) - (b.rate ?? -1) || a.p.index - b.p.index);
    const full = buildTaxInput(ctx, ps);
    for (const [i, { p, rate }] of active.entries()) {
      const later = new Set(active.slice(i).map((x) => x.p.id));
      const base: TaxYearInput = {
        ...full,
        withdrawals: full.withdrawals.filter((w) => !(mine(w) && later.has(w.owner))),
      };
      const own = full.withdrawals.filter((w) => mine(w) && w.owner === p.id);
      const converted = own.reduce((s, w) => s + w.amount, 0);
      const balances = p.sources.map((id) => {
        const a = ctx.accountById.get(id);
        // The engine skips a conversion from an account that is closed or cannot be withdrawn from
        // yet (e.g. a workplace plan before separation), so such an account has nothing available.
        if (!a || !isOpen(ctx, a, ps) || !isWithdrawable(ctx, a, ps))
          return { accountId: id, available: 0 };
        const back = own.filter((w) => w.accountId === id).reduce((s, w) => s + w.amount, 0);
        return { accountId: id, available: Math.max(0, a.balance + back) };
      });
      const available = balances.reduce((s, b) => s + b.available, 0);
      const alive = ps.alive[p.id] ?? true;
      const row: ProbeRow = {
        year,
        personId: p.id,
        start: ps.bounds.start,
        end: ps.bounds.end,
        piStart: ps.piStart,
        rate,
        available,
        converted,
        room: null,
        ceilings: [],
        binding: "no-ceiling",
        next: 0,
        alive,
        otherIncome: { agi: 0, magi: 0, taxableIncome: 0 },
        taxOnConversion: 0,
        balances,
      };
      rows.push(row);
      if (cfg.detail) {
        const outs = runTaxStack(stack, base);
        const f = merged(outs);
        row.otherIncome = {
          agi: f.agi ?? 0,
          magi: f.magi ?? f.agi ?? 0,
          taxableIncome: outs[stack.findIndex((j) => j.id === FEDERAL_ID)]?.taxableIncome ?? 0,
        };
        if (converted > 0) {
          const withOwn = { ...base, withdrawals: [...base.withdrawals, ...own] };
          row.taxOnConversion = stackTotal(runTaxStack(stack, withOwn)) - stackTotal(outs);
        }
      }
      if (!alive) {
        row.binding = "not-alive";
        continue;
      }
      if (rate === null) continue;
      if (p.sources.length === 0) {
        row.binding = "no-source";
        continue;
      }
      const src = ctx.accountById.get(p.sources[0]!);
      const synthetic = (x: number): TaxYearInput =>
        x <= 0
          ? base
          : {
              ...base,
              withdrawals: [
                ...base.withdrawals,
                {
                  accountId: p.sources[0]!,
                  accountType: src?.def.type ?? "traditional-ira",
                  treatment: "tax-deferred",
                  owner: p.id,
                  amount: x,
                  taxableAmount: x,
                  character: "ordinary",
                  penaltyRate: 0,
                  ownerAge: ps.ages[p.id] ?? 0,
                  isConversion: true,
                },
              ],
            };
      // During the search the room only matters up to what is left to convert.
      if (!cfg.detail && available < 1) {
        row.binding = "balance";
        continue;
      }
      const max = cfg.detail ? 10_000_000 : Math.max(0, available);
      const tol = cfg.detail ? 0.01 : 1;
      for (const c of ceilingTargets(base, ps, rate, cfg)) {
        const fits = (x: number) =>
          targetSatisfied(base, runTaxStack(stack, synthetic(x)), c.target, p.id);
        const key = `${p.id}|${year}|${c.kind}`;
        const lo = searchFrom(fits, cfg.hints.get(key), max, tol);
        // Whole currency units: take the next whole unit when it still fits (bisection stops just below).
        const up = Math.min(max, Math.floor(lo + tol));
        const room = up > lo && fits(up) ? up : Math.floor(lo);
        cfg.hints.set(key, room);
        row.ceilings.push({ kind: c.kind, label: c.label, room });
      }
      const tight = row.ceilings.reduce((m, c) => (c.room < m.room ? c : m), row.ceilings[0]!);
      row.room = tight.room;
      row.next = Math.max(0, Math.floor(Math.min(tight.room, available)));
      row.binding =
        tight.room < 1 ? "already-above-ceiling" : available <= tight.room ? "balance" : tight.kind;
    }
  };
}

// ---------------------------------------------------------------------- sizing (fixed point)

interface Sized {
  amounts: Amounts;
  hints: Map<string, number>;
  sched: ReturnType<typeof scheduleRows>;
  rows: ProbeRow[];
  result: ProjectionResult;
  plan: SimulationInput["plan"];
  patch: PatchOp[];
  sims: number;
  converged: boolean;
}

function scheduleRows(rows: ProbeRow[], amounts: Amounts) {
  return rows
    .filter((r) => (amounts.get(r.personId)?.get(r.year) ?? 0) > 0)
    .map((r) => {
      let left = amounts.get(r.personId)!.get(r.year)!;
      const sources: { accountId: string; amount: number }[] = [];
      for (const b of r.balances) {
        if (left <= 0) break;
        const take = Math.floor(Math.min(left, b.available));
        if (take > 0) sources.push({ accountId: b.accountId, amount: take });
        left -= take;
      }
      return { personId: r.personId, year: r.year, start: r.start, end: r.end, sources };
    });
}

function size(
  input: SimulationInput,
  basePlan: SimulationInput["plan"],
  persons: Person[],
  cfg: Omit<ProbeConfig, "detail" | "hints">,
  opts: {
    detail: boolean;
    lean: boolean;
    maxPasses?: number;
    /** Start from another schedule (a neighbouring candidate) instead of from nothing. */
    init?: Pick<Sized, "amounts" | "rows" | "hints">;
  },
): Sized {
  const maxPasses = opts.maxPasses ?? 24;
  let amounts: Amounts = opts.init ? opts.init.amounts : new Map();
  let rowsForSchedule: ProbeRow[] = opts.init ? opts.init.rows : [];
  const hints = new Map(opts.init?.hints ?? []);
  let sims = 0;
  for (let pass = 0; ; pass++) {
    const sched = scheduleRows(rowsForSchedule, amounts);
    const patch = schedulePatch(input, persons, sched);
    const plan = applyPlanPatch(basePlan, patch);
    const rows: ProbeRow[] = [];
    const last = pass >= maxPasses;
    const result = coreSimulate(
      { ...input, plan, options: { ...input.options, trace: "off", lean: opts.lean } },
      { afterSettle: makeProbe({ ...cfg, hints, detail: opts.detail && last }, rows) },
    );
    sims++;
    // What was actually converted (balances can cap a flow) and what the next pass wants.
    let delta = 0;
    let over = false;
    const next: Amounts = new Map();
    for (const r of rows) {
      const want = r.next;
      if (want > 0) {
        if (!next.has(r.personId)) next.set(r.personId, new Map());
        const prev = amounts.get(r.personId)?.get(r.year) ?? 0;
        // Damp late passes so an alternating sequence settles.
        const v = pass < 8 ? want : Math.floor((prev + want) / 2);
        next.get(r.personId)!.set(r.year, Math.min(v, want));
      }
      if (r.room !== null && r.converted > r.room + 1) over = true;
      delta = Math.max(delta, Math.abs(r.converted - want));
    }
    const done = !over && delta <= 1;
    if (last || (done && (!opts.detail || pass > 0))) {
      if (opts.detail && !last) {
        // One more run with full detail on exactly this schedule.
        const detailRows: ProbeRow[] = [];
        const r2 = coreSimulate(
          { ...input, plan, options: { ...input.options, trace: "off", lean: opts.lean } },
          { afterSettle: makeProbe({ ...cfg, hints, detail: true }, detailRows) },
        );
        sims++;
        return {
          amounts,
          hints,
          sched,
          rows: detailRows,
          result: r2,
          plan,
          patch,
          sims,
          converged: true,
        };
      }
      return { amounts, hints, sched, rows, result, plan, patch, sims, converged: done };
    }
    amounts = next;
    rowsForSchedule = rows;
  }
}

// ------------------------------------------------------------------------------ the planner

interface Scored {
  rates: Rates;
  sized: Sized;
  score: number;
  legacyReal: number;
  shortfallYear: number | null;
}

function ratesFor(
  persons: Person[],
  years: number[],
  pick: (personId: string, year: number) => number | null,
): Rates {
  const m: Rates = new Map();
  for (const p of persons) {
    const y = new Map<number, number | null>();
    for (const year of years) y.set(year, pick(p.id, year));
    m.set(p.id, y);
  }
  return m;
}

const cloneRates = (r: Rates): Rates => new Map([...r].map(([k, v]) => [k, new Map(v)]));

/** Calendar years the plan covers (from its start to the longest horizon). */
function allYearsOf(input: SimulationInput, plan: SimulationInput["plan"]): number[] {
  const fin =
    plan.startingConditions.kind === "snapshot" ? plan.startingConditions.finances : input.finances;
  const first = Number(fin.asOf.slice(0, 4));
  return Array.from({ length: plan.assumptions.maxYears + 1 }, (_, i) => first + i);
}

function totalConvertedReal(rows: ProbeRow[]): number {
  return rows.reduce((s, r) => s + r.converted / (r.piStart || 1), 0);
}

/** Propose a Roth conversion schedule for a US plan and compare it with no conversions. */
export async function planRothConversions(
  input: SimulationInput,
  rawReq: RothConversionPlanRequest = {},
  deps: SolverDeps = {},
): Promise<RothConversionPlan> {
  const req = RothConversionPlanRequest.parse(rawReq);
  const assumptions = [...ROTH_PLAN_ASSUMPTIONS];
  const empty = (summary: string): RothConversionPlan => ({
    status: "unsupported",
    verdict: "no-conversions",
    summary,
    targets: [],
    schedule: [],
    outcomes: [],
    patch: [],
    assumptions,
    evaluations: 0,
    simulations: 0,
    converged: true,
  });
  if (input.household.location.country !== "US")
    return empty(
      "The Roth conversion plan is for US households. UK pension-to-ISA moves are compared by the tax strategy comparison instead.",
    );
  if (input.plan.tax.mode !== "estimate")
    return empty(
      "The plan's tax mode is not 'estimate', so there are no federal brackets to fill. Switch the plan to estimated tax to plan conversions.",
    );
  const persons = people(input, req);
  if (persons.every((p) => p.sources.length === 0))
    return empty("No one in the plan has a traditional (tax-deferred) account to convert from.");
  for (const t of req.targets ?? [])
    if (t.personId && !persons.some((p) => p.id === t.personId))
      throw new ScenarioError(`unknown person '${t.personId}' in targets`, {
        personId: t.personId,
      });

  const noneOps = noConversionPatch(input);
  const basePlan = applyPlanPatch(input.plan, noneOps);
  const run = (plan: SimulationInput["plan"], trace: "off" | "summary" = "off") =>
    coreSimulate({ ...input, plan, options: { ...input.options, trace, lean: false } });

  // Plan years from a baseline run (also the "no conversions" outcome).
  const noneRows: ProbeRow[] = [];
  const noneResult = coreSimulate(
    { ...input, plan: basePlan, options: { ...input.options, trace: "off", lean: false } },
    {
      afterSettle: makeProbe(
        {
          persons,
          rates: ratesFor(persons, allYearsOf(input, basePlan), () => null),
          irmaaTier: null,
          aca: false,
          detail: false,
          hints: new Map(),
        },
        noneRows,
      ),
    },
  );
  /** What each person could convert each year if nothing were converted (an upper bound). */
  const convertible = new Map<string, Map<number, number>>();
  for (const r of noneRows) {
    if (!convertible.has(r.personId)) convertible.set(r.personId, new Map());
    convertible.get(r.personId)!.set(r.year, r.alive ? r.available : 0);
  }
  const allYears = noneResult.periods.map((p) => p.year);
  const years = allYears.filter(
    (y) =>
      (req.fromYear === undefined || y >= req.fromYear) &&
      (req.toYear === undefined || y <= req.toYear),
  );
  const cfg = { persons, irmaaTier: req.irmaaTier, aca: req.aca };
  const legacy = (plan: SimulationInput["plan"], r: ProjectionResult) =>
    netLegacyAtEnd({ ...input, plan }, r, {
      transferAllowances: input.household.people.length > 1,
    }).netLegacyReal;
  const objective = (legacyReal: number, r: ProjectionResult) =>
    req.objective === "lifetimeTax" ? -r.summary.lifetimeTaxesReal : legacyReal;
  const noneLegacy = legacy(basePlan, noneResult);
  const noneScore = objective(noneLegacy, noneResult);
  const noneShortfall = noneResult.summary.firstShortfallYear;
  let evaluations = 1;
  let sims = 1;

  const evaluate = (rates: Rates, from?: Scored | null): Scored => {
    checkAbort(deps.signal);
    const sized = size(
      input,
      basePlan,
      persons,
      { ...cfg, rates },
      { detail: false, lean: false, ...(from ? { init: from.sized } : {}) },
    );
    evaluations++;
    sims += sized.sims;
    deps.onProgress?.(evaluations);
    const legacyReal = legacy(sized.plan, sized.result);
    return {
      rates,
      sized,
      score: objective(legacyReal, sized.result),
      legacyReal,
      shortfallYear: sized.result.summary.firstShortfallYear,
    };
  };
  // A change must not bring a shortfall forward.
  const safe = (s: Scored) =>
    noneShortfall === null
      ? s.shortfallYear === null
      : s.shortfallYear === null || s.shortfallYear >= noneShortfall;
  // Ignore improvements smaller than this (rounding noise): 0.1% of the no-conversion value, min 1.
  const epsilon = Math.max(1, Math.abs(noneScore) * 0.001);

  let chosen: Rates;
  let chosenScored: Scored | null = null;
  const options = (req.bracketRates ?? defaultBracketRates()).slice().sort((a, b) => a - b);
  if (req.targets && req.targets.length > 0) {
    chosen = ratesFor(persons, years, (pid, year) => {
      let v: number | null | undefined;
      for (const t of req.targets!)
        if (
          (!t.personId || t.personId === pid) &&
          (t.fromYear === undefined || year >= t.fromYear) &&
          (t.toYear === undefined || year <= t.toYear)
        )
          v = t.bracketRate;
      return v === undefined ? null : v;
    });
  } else {
    // 1. One bracket for everyone and every year.
    let best: Scored | null = null;
    for (const rate of options) {
      if (evaluations >= req.maxEvaluations) break;
      const s = evaluate(
        ratesFor(persons, years, () => rate),
        best,
      );
      if (safe(s) && (best === null || s.score > best.score + 1e-9)) best = s;
    }
    let current: Scored | null = best && best.score > noneScore + epsilon ? best : null;
    // 2. Block by block, person by person: try each bracket or no conversion.
    const blocks: number[][] = [];
    for (let i = 0; i < years.length; i += req.blockYears)
      blocks.push(years.slice(i, i + req.blockYears));
    const eligible = persons.filter((p) => p.sources.length > 0);
    let baseRates = current?.rates ?? ratesFor(persons, years, () => null);
    let baseScore = current?.score ?? noneScore;
    // Ceilings in order, "no conversion" lowest. Each block walks one step at a time from its
    // current ceiling, up or down, while that improves the objective (a local search).
    const ladder: (number | null)[] = [null, ...options];
    const tryRate = (block: number[], p: Person, rate: number | null): boolean => {
      const trial = cloneRates(baseRates);
      for (const y of block) trial.get(p.id)!.set(y, rate);
      // A trial with no conversions at all is the baseline itself.
      if ([...trial.values()].every((m) => [...m.values()].every((v) => v === null))) {
        if (noneScore > baseScore + epsilon) {
          baseRates = trial;
          baseScore = noneScore;
          current = null;
          return true;
        }
        return false;
      }
      const s = evaluate(trial, current);
      if (safe(s) && s.score > baseScore + epsilon) {
        baseRates = trial;
        baseScore = s.score;
        current = s;
        return true;
      }
      return false;
    };
    search: for (const block of blocks)
      for (const p of eligible) {
        // Nothing to convert in this block even without any conversions: skip it.
        if (block.every((y) => (convertible.get(p.id)?.get(y) ?? 0) < 1)) continue;
        const at = () => ladder.indexOf(baseRates.get(p.id)?.get(block[0]!) ?? null);
        for (const dir of [1, -1]) {
          let moved = false;
          for (let i = at() + dir; i >= 0 && i < ladder.length; i += dir) {
            if (evaluations >= req.maxEvaluations) break search;
            if (!tryRate(block, p, ladder[i]!)) break;
            moved = true;
          }
          if (moved) break;
        }
      }
    chosen = baseRates;
    chosenScored = current;
  }

  const anyTarget = [...chosen.values()].some((m) => [...m.values()].some((v) => v !== null));
  // The reporting run: the chosen ceilings, sized to a fixed point, with full detail.
  const final = size(
    input,
    basePlan,
    persons,
    { ...cfg, rates: anyTarget ? chosen : ratesFor(persons, years, () => null) },
    {
      detail: true,
      lean: false,
      ...(anyTarget && chosenScored ? { init: chosenScored.sized } : {}),
    },
  );
  sims += final.sims;
  const finalLegacy = legacy(final.plan, final.result);
  const finalScore = objective(finalLegacy, final.result);
  const converted = final.rows.reduce((s, r) => s + r.converted, 0);
  const better =
    anyTarget &&
    converted > 0 &&
    finalScore > noneScore + epsilon &&
    safe({
      rates: chosen,
      sized: final,
      score: finalScore,
      legacyReal: finalLegacy,
      shortfallYear: final.result.summary.firstShortfallYear,
    });
  const fixedTargets = !!req.targets?.length;
  // With user targets the schedule is what they asked for even when it does not win; say so.
  const verdict: RothConversionPlan["verdict"] = better ? "convert" : "no-conversions";

  // ---- Outcomes.
  const mc =
    req.successRate === true ? makeMetric(input, { kind: "successRate", target: 0 }, deps) : null;
  const outcome = async (
    id: RothConversionOutcome["id"],
    label: string,
    plan: SimulationInput["plan"],
    r: ProjectionResult,
    legacyReal: number,
    convertedReal: number,
  ): Promise<RothConversionOutcome> => ({
    id,
    label,
    lifetimeTaxReal: r.summary.lifetimeTaxesReal,
    afterTaxEndWealthReal: legacyReal,
    endNetWorthReal: r.summary.endNetWorthReal,
    totalConvertedReal: convertedReal,
    success: r.summary.success,
    firstShortfallYear: r.summary.firstShortfallYear,
    successRate: mc ? await mc.score({ ...input, plan }) : null,
  });
  const outcomes: RothConversionOutcome[] = [
    await outcome("none", "No conversions", basePlan, noneResult, noneLegacy, 0),
  ];
  if (hasCurrentConversions(input)) {
    const cur = run(input.plan, "summary");
    sims++;
    outcomes.push(
      await outcome(
        "current",
        "Current plan",
        input.plan,
        cur,
        legacy(input.plan, cur),
        convertedRealOf(cur),
      ),
    );
  }
  if (anyTarget && converted > 0)
    outcomes.push(
      await outcome(
        "proposed",
        fixedTargets ? "Your ceilings" : "Proposed schedule",
        final.plan,
        final.result,
        finalLegacy,
        totalConvertedReal(final.rows),
      ),
    );

  // ---- Schedule rows with reasons.
  const cur = input.household.currency;
  const m = (v: number) => fmtMoney(v, { currency: cur });
  const byYear = new Map(final.result.periods.map((p) => [p.year, p]));
  const schedule: RothConversionYear[] = final.rows
    .filter((r) => years.includes(r.year))
    .filter((r) => r.rate !== null || r.converted > 0)
    .map((r) => {
      const p = persons.find((x) => x.id === r.personId)!;
      const pi = byYear.get(r.year)?.priceIndex ?? r.piStart ?? 1;
      const sched = final.sched.find((s) => s.personId === r.personId && s.year === r.year);
      const roomLeft = r.room === null ? null : Math.max(0, r.room - r.converted);
      return {
        year: r.year,
        personId: r.personId,
        personName: p.name,
        amount: r.converted,
        amountReal: r.converted / (pi || 1),
        bracketRate: r.rate,
        binding: r.binding,
        ceilings: r.ceilings,
        room: r.room,
        roomLeft,
        available: r.available,
        otherIncome: r.otherIncome,
        taxOnConversion: r.taxOnConversion,
        taxOnConversionReal: r.taxOnConversion / (pi || 1),
        sources: sched?.sources ?? [],
        reason: reasonFor(r, p, m),
      };
    });

  const targets = summariseTargets(persons, years, chosen);
  const none = outcomes[0]!;
  const proposed = outcomes.find((o) => o.id === "proposed");
  let summary: string;
  if (!anyTarget || !proposed) {
    summary = fixedTargets
      ? "Your ceilings leave no room to convert in any year: other income already reaches them, or there is nothing left to convert."
      : `Estimate: making no conversions looks best for this plan. No bracket, in any block of years, raised ${req.objective === "lifetimeTax" ? "lifetime tax savings" : "after-tax wealth at the end"} by more than ${m(epsilon)} (today's money) without bringing a shortfall forward. Converting means paying tax now at your current rate to avoid tax later; here the later rate (including the heirs' rate of ${(input.plan.tax.estate.heirTaxDeferredRate * 100).toFixed(0)}% on what is left in pensions) is not higher.`;
  } else {
    const dWealth = proposed.afterTaxEndWealthReal - none.afterTaxEndWealthReal;
    const dTax = proposed.lifetimeTaxReal - none.lifetimeTaxReal;
    const head = `Estimate: converting ${m(proposed.totalConvertedReal)} in total (today's money) over ${pluralDuration(new Set(schedule.filter((s) => s.amount > 0).map((s) => s.year)).size, "year")}`;
    const effect = `${dWealth >= 0 ? "raises" : "lowers"} after-tax wealth at the end by ${m(Math.abs(dWealth))} and ${dTax <= 0 ? "lowers" : "raises"} lifetime tax by ${m(Math.abs(dTax))}, compared with no conversions`;
    summary = better
      ? `${head} ${effect}.`
      : `${head} ${effect}. That is not better than making no conversions, so no conversions is the better answer under the plan's assumptions; the schedule is shown for your chosen ceilings only.`;
  }
  return {
    status: "ok",
    verdict,
    summary,
    targets,
    schedule,
    outcomes,
    patch: better || (fixedTargets && converted > 0) ? [...noneOps, ...final.patch] : [],
    assumptions,
    evaluations,
    simulations: sims,
    converged: final.converged,
  };
}

/** Roth conversions in a run with a summary trace (tax strategy and transfer flows), today's money. */
function convertedRealOf(r: ProjectionResult): number {
  let s = 0;
  for (const t of r.trace) {
    if (t.code !== "ROTH_CONVERSION") continue;
    const amount = Number(t.data?.amount ?? 0);
    s += amount / (r.periods[t.periodIndex]?.priceIndex || 1);
  }
  return s;
}

function defaultBracketRates(): number[] {
  // The federal ordinary rates from the tax table, up to 32% (Rev. Proc. 2025-32 via US_FEDERAL_2026).
  const rates = new Set(US_FEDERAL_2026.brackets["married-joint"].map(([, r]) => r));
  return [...rates].filter((r) => r >= 0.1 && r <= 0.32).sort((a, b) => a - b);
}

function summariseTargets(persons: Person[], years: number[], rates: Rates) {
  const out: RothConversionPlan["targets"] = [];
  for (const p of persons) {
    const m = rates.get(p.id);
    if (!m) continue;
    let cur: (typeof out)[number] | null = null;
    for (const y of years) {
      const v = m.get(y) ?? null;
      if (cur && cur.bracketRate === v && cur.toYear === y - 1) cur.toYear = y;
      else {
        cur = { personId: p.id, fromYear: y, toYear: y, bracketRate: v };
        out.push(cur);
      }
    }
  }
  return out;
}

function reasonFor(r: ProbeRow, p: Person, m: (v: number) => string): string {
  const who = `${r.year}, ${p.name}`;
  const income = `other income this year: AGI ${m(r.otherIncome.agi)}, MAGI ${m(r.otherIncome.magi)}`;
  const tax =
    r.converted > 0 ? ` Estimated tax on the conversion this year: ${m(r.taxOnConversion)}.` : "";
  const tight = r.ceilings.length
    ? r.ceilings.reduce((a, c) => (c.room < a.room ? c : a), r.ceilings[0]!)
    : null;
  switch (r.binding) {
    case "not-alive":
      return `${who}: no conversion (not alive in this year of the plan).`;
    case "no-ceiling":
      return r.converted > 0
        ? `${who}: converted ${m(r.converted)}.${tax}`
        : `${who}: no conversion planned this year.`;
    case "no-source":
      return `${who}: no conversion (no traditional account to convert from).`;
    case "already-above-ceiling":
      return `${who}: no conversion. With ${income}, income is already at or above ${tight?.label ?? "the ceiling"}, so there is no room left.`;
    case "balance":
      return `${who}: converted ${m(r.converted)}, everything left in the traditional accounts. ${cap(income)}; ${tight ? `${m(r.room ?? 0)} of room under ${tight.label}, ${m(Math.max(0, (r.room ?? 0) - r.converted))} unused` : ""}.${tax}`;
    default:
      return `${who}: converted ${m(r.converted)}, up to ${tight?.label ?? "the ceiling"}. ${cap(income)}; that left ${m(r.room ?? 0)} of room and ${m(Math.max(0, (r.room ?? 0) - r.converted))} is unused.${tax}`;
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
