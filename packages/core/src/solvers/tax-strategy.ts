/**
 * Tax-strategy search hooks: generate candidate strategies as plan patches, run each through the
 * engine, rank them. The UK is a first-class case:
 *   - pension (SIPP / workplace) vs ISA vs GIA drawdown order,
 *   - using the personal allowance in "gap years" (after retirement, before State Pension) by
 *     drawing pension income up to the allowance and moving it into an ISA,
 *   - tax-free lump sum timing (25% up front as PCLS vs 25% of each withdrawal as UFPLS).
 * Every candidate is scored by the engine (the tax.strategy phase models allowance / band filling,
 * pension-to-ISA moves and gain harvesting; PCLS vs UFPLS is an account setting). A candidate only
 * reports `unsupported` if a plan uses some other feature the engine cannot model.
 */
import { simulate as coreSimulate } from "../engine/simulate.js";
import type { ProjectionResult, SimulationInput } from "../engine/types.js";
import { isNotImplemented, type NotImplementedError } from "../errors.js";
import { fmtMoney } from "../insights/format.js";
import { applyPlanPatch } from "../insights/patch.js";
import { ACCOUNT_TYPE_INFO } from "../schema/account-types.js";
import type { DrawdownCategory } from "../schema/accounts.js";
import type { PatchOp } from "../schema/changes.js";
import type { DrawdownEntry } from "../schema/strategies.js";
import { pickYear } from "../tax/common.js";
import { UK_TAX_YEARS, ukStatePensionAge } from "../tax/data/uk.js";
import type { SolverDeps } from "./contracts.js";
import { checkAbort, isAbortError, makeMetric } from "./search.js";
import { planFinances } from "./variables.js";

export interface StrategyCandidate {
  id: string;
  label: string;
  description: string;
  patch: PatchOp[];
}

export type StrategyObjective = "endNetWorthReal" | "lifetimeTaxesReal" | "successRate";

export interface StrategyEvaluation extends StrategyCandidate {
  status: "ok" | "unsupported" | "error";
  endNetWorthReal: number | null;
  lifetimeTaxesReal: number | null;
  success: boolean | null;
  firstShortfallYear: number | null;
  successRate: number | null;
  /** Score for ranking (higher is better). */
  score: number | null;
  unsupported?: { feature: string; workstream: string };
  error?: string;
}

export interface StrategyComparison {
  objective: StrategyObjective;
  baseline: StrategyEvaluation;
  ranked: StrategyEvaluation[];
  best: StrategyEvaluation | null;
  explanation: string;
}

/** UK personal allowance from the UK tax data (2026/27; frozen until April 2031). */
export const UK_PERSONAL_ALLOWANCE = pickYear(UK_TAX_YEARS, 2026).income.personalAllowance;

/** Run candidates and rank them. The baseline (no patch) is always evaluated first. */
export async function compareStrategies(
  input: SimulationInput,
  candidates: StrategyCandidate[],
  opts: { objective?: StrategyObjective } = {},
  deps: SolverDeps = {},
): Promise<StrategyComparison> {
  const objective = opts.objective ?? "endNetWorthReal";
  const sim = deps.simulate ?? ((i: SimulationInput) => coreSimulate(i));
  const mc =
    objective === "successRate"
      ? makeMetric(input, { kind: "successRate", target: 0 }, deps)
      : null;
  const evalOne = async (c: StrategyCandidate): Promise<StrategyEvaluation> => {
    checkAbort(deps.signal);
    const empty = {
      ...c,
      endNetWorthReal: null,
      lifetimeTaxesReal: null,
      success: null,
      firstShortfallYear: null,
      successRate: null,
      score: null,
    };
    try {
      const plan = applyPlanPatch(input.plan, c.patch);
      const candidate = { ...input, plan };
      const r: ProjectionResult = sim({
        ...candidate,
        options: { ...input.options, trace: "off", lean: true },
      });
      const successRate = mc ? await mc.score(candidate) : null;
      const score =
        objective === "endNetWorthReal"
          ? r.summary.endNetWorthReal
          : objective === "lifetimeTaxesReal"
            ? -r.summary.lifetimeTaxesReal
            : successRate;
      return {
        ...empty,
        status: "ok",
        endNetWorthReal: r.summary.endNetWorthReal,
        lifetimeTaxesReal: r.summary.lifetimeTaxesReal,
        success: r.summary.success,
        firstShortfallYear: r.summary.firstShortfallYear,
        successRate,
        score,
      };
    } catch (e) {
      if (isAbortError(e)) throw e;
      if (isNotImplemented(e)) {
        const ni = e as NotImplementedError;
        return {
          ...empty,
          status: "unsupported",
          unsupported: { feature: ni.feature, workstream: ni.workstream },
        };
      }
      return { ...empty, status: "error", error: (e as Error).message };
    }
  };
  const baseline = await evalOne({
    id: "baseline",
    label: "Current plan",
    description: "The plan as it stands.",
    patch: [],
  });
  const results: StrategyEvaluation[] = [];
  for (const [i, c] of candidates.entries()) {
    results.push(await evalOne(c));
    deps.onProgress?.(i + 1);
  }
  const ranked = [baseline, ...results]
    .filter((r) => r.status === "ok" && r.score !== null)
    .sort((a, b) => b.score! - a.score!);
  const unsupported = results.filter((r) => r.status !== "ok");
  const best = ranked[0] ?? null;
  const cur = input.household.currency;
  const m = (v: number | null) => (v === null ? "n/a" : fmtMoney(v, { currency: cur }));
  let explanation: string;
  if (!best) explanation = "No strategy could be evaluated.";
  else if (best.id === "baseline")
    explanation = "Your current plan already scores best among the strategies tried.";
  else {
    const gain =
      objective === "endNetWorthReal"
        ? `ends with ${m(best.endNetWorthReal)} instead of ${m(baseline.endNetWorthReal)} (today's money)`
        : objective === "lifetimeTaxesReal"
          ? `pays ${m(best.lifetimeTaxesReal)} lifetime tax instead of ${m(baseline.lifetimeTaxesReal)} (today's money)`
          : `has a ${((best.successRate ?? 0) * 100).toFixed(0)}% chance of success instead of ${((baseline.successRate ?? 0) * 100).toFixed(0)}%`;
    explanation = `Best: ${best.label}. It ${gain}.`;
  }
  if (unsupported.length > 0)
    explanation += ` ${unsupported.length} strateg${unsupported.length === 1 ? "y" : "ies"} could not be evaluated yet (${[
      ...new Set(unsupported.map((u) => u.unsupported?.feature ?? u.error ?? "error")),
    ].join(", ")}).`;
  return { objective, baseline, ranked, best, explanation };
}

const CATEGORY_LABELS: Partial<Record<DrawdownCategory, string>> = {
  cash: "cash",
  taxable: "taxable (GIA)",
  "tax-deferred": "pension",
  "tax-free": "ISA / tax-free",
  crypto: "crypto",
  hsa: "HSA",
  education: "education",
};

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) =>
    permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]),
  );
}

function presentCategories(input: SimulationInput): DrawdownCategory[] {
  const set = new Set<DrawdownCategory>();
  const excluded = new Set(input.plan.excludedIds);
  for (const a of [...planFinances(input).accounts, ...input.plan.plannedAccounts]) {
    if (a.archived || excluded.has(a.id)) continue;
    set.add(ACCOUNT_TYPE_INFO[a.type].drawdown);
  }
  return [...set];
}

/**
 * Every ordering of the investment categories present (cash stays first), as drawdown-order patches.
 * With 3 categories that is 6 candidates; with 4, 24.
 */
export function drawdownOrderCandidates(
  input: SimulationInput,
  labels = CATEGORY_LABELS,
): StrategyCandidate[] {
  const cats = presentCategories(input).filter((c) => c !== "cash" && c !== "real-assets");
  const perms = cats.length <= 5 ? permutations(cats) : [cats];
  return perms.map((p) => {
    const order: DrawdownEntry[] = [
      { kind: "category", category: "cash" },
      ...p.map((c) => ({ kind: "category" as const, category: c })),
      { kind: "category", category: "real-assets" },
    ];
    const label = p.map((c) => labels[c] ?? c).join(" → ");
    return {
      id: `order:${p.join(">")}`,
      label: `Draw ${label}`,
      description: `Spend cash first, then ${label}.`,
      patch: [{ op: "replace", path: "/drawdown/order", value: order }],
    };
  });
}

/** Is this a UK household (or does it hold UK wrappers)? */
export function isUkPlan(input: SimulationInput): boolean {
  return (
    input.household.location.country === "GB" ||
    planFinances(input).accounts.some((a) => a.type.startsWith("uk-"))
  );
}

/** State Pension age ('YYYY-MM' or year + month): the UK tax data's function, re-exported. */
export { ukStatePensionAge };

/**
 * UK drawdown strategies as candidates:
 *   - every pension / ISA / GIA order,
 *   - gap-year allowance filling: draw pension income up to the personal allowance each year from
 *     retirement to State Pension age and move it to an ISA (as a TaxStrategy income target),
 *   - tax-free lump sum timing: PCLS (25% up front) vs UFPLS (25% of each withdrawal).
 */
export function ukDrawdownCandidates(input: SimulationInput): StrategyCandidate[] {
  const out = drawdownOrderCandidates(input);
  const fin = planFinances(input);
  const pensions = fin.accounts.filter((a) =>
    ["uk-sipp", "uk-workplace-pension", "uk-pension"].includes(a.type),
  );
  const isa = fin.accounts.find((a) => a.type === "uk-isa");
  const cur = input.household.currency;
  const primary = input.household.people.find((p) => p.role === "primary")!;
  const retirement = input.plan.milestones.find(
    (m) => m.kind === "retirement" && (!m.personId || m.personId === primary.id),
  );
  const spIncome = input.plan.income.find(
    (i) => i.type === "state-pension" && i.owner === primary.id,
  );
  const spStart = spIncome?.range.start ?? {
    kind: "age" as const,
    personId: primary.id,
    age: ukStatePensionAge(primary.birthMonth),
    offsetMonths: 0,
  };
  if (pensions.length > 0 && retirement) {
    out.push({
      id: "uk:fill-personal-allowance",
      label: "Use the personal allowance in the gap years",
      description: `From ${retirement.name} until State Pension starts, draw about ${fmtMoney(UK_PERSONAL_ALLOWANCE, { currency: cur })} a year of taxable pension income (covered by the personal allowance) and shelter it in ${isa ? isa.name : "an ISA"}, so it is not taxed later at a higher rate.`,
      patch: [
        {
          op: input.plan.taxStrategy ? "replace" : "add",
          path: "/taxStrategy",
          value: {
            enabled: true,
            range: {
              start: { kind: "milestone", milestoneId: retirement.id, offsetMonths: 0 },
              end: spStart,
              endInclusive: false,
            },
            target: { kind: "income", amount: { value: UK_PERSONAL_ALLOWANCE, basis: "real" } },
            constraints: { avoidNiit: false, preserveAca: false },
            modules: { rothConversions: true, withdrawalShielding: true, gainHarvesting: true },
            conversionSourceAccountIds: pensions.map((p) => p.id),
            ...(isa ? { conversionDestinationAccountId: isa.id } : {}),
          },
        },
      ],
    });
    if (input.plan.tax.mode === "estimate")
      out.push({
        id: "uk:fill-basic-rate-band",
        label: "Fill the basic-rate band in the gap years",
        description: `From ${retirement.name} until State Pension starts, take pension income up to the top of the basic-rate band each year (taxed at 20%), spending it first and moving the rest into ${isa ? isa.name : "an ISA"} within the ISA allowance, so less is left to be taxed at 40% later.`,
        patch: [
          {
            op: input.plan.taxStrategy ? "replace" : "add",
            path: "/taxStrategy",
            value: {
              enabled: true,
              range: {
                start: { kind: "milestone", milestoneId: retirement.id, offsetMonths: 0 },
                end: spStart,
                endInclusive: false,
              },
              target: { kind: "bracket", rate: 0.2 },
              constraints: { avoidNiit: false, preserveAca: false },
              modules: { rothConversions: true, withdrawalShielding: true, gainHarvesting: true },
              conversionSourceAccountIds: pensions.map((p) => p.id),
              ...(isa ? { conversionDestinationAccountId: isa.id } : {}),
            },
          } as PatchOp,
        ],
      });
    for (const method of ["pcls", "ufpls"] as const) {
      out.push({
        id: `uk:lump-sum:${method}`,
        label:
          method === "pcls"
            ? "Take the 25% tax-free lump sum up front"
            : "Take 25% tax-free from each withdrawal",
        description:
          method === "pcls"
            ? "Crystallise the pension at retirement, take the pension commencement lump sum (PCLS) tax-free, and draw the rest as taxable income."
            : "Leave the pension uncrystallised and take each withdrawal as UFPLS: 25% tax-free, 75% taxable.",
        patch: pensions.map((p) => ({
          op: input.plan.accountSettings[p.id] ? "replace" : "add",
          path: `/accountSettings/${p.id}`,
          value: { ...(input.plan.accountSettings[p.id] ?? {}), ukDrawdownMethod: method },
        })) as PatchOp[],
      });
    }
  }
  return out;
}

/** US-style bracket-filling conversions (Roth conversions up to a bracket), as candidates. */
export function bracketFillCandidates(
  input: SimulationInput,
  rates: number[] = [0.12, 0.22, 0.24],
): StrategyCandidate[] {
  return rates.map((rate) => ({
    id: `bracket-fill:${rate}`,
    label: `Fill the ${(rate * 100).toFixed(0)}% bracket each year`,
    description: `Convert tax-deferred savings to tax-free each year up to the top of the ${(rate * 100).toFixed(0)}% bracket.`,
    patch: [
      {
        op: input.plan.taxStrategy ? "replace" : "add",
        path: "/taxStrategy",
        value: { enabled: true, target: { kind: "bracket", rate } },
      } as PatchOp,
    ],
  }));
}

/** Convenience: run the right candidate set for the household (UK first-class, US bracket filling). */
export async function optimiseTaxStrategy(
  input: SimulationInput,
  opts: { objective?: StrategyObjective } = {},
  deps: SolverDeps = {},
): Promise<StrategyComparison> {
  const candidates = isUkPlan(input)
    ? ukDrawdownCandidates(input)
    : input.household.location.country === "US"
      ? [...drawdownOrderCandidates(input), ...bracketFillCandidates(input)]
      : drawdownOrderCandidates(input);
  return compareStrategies(input, candidates, opts, deps);
}
