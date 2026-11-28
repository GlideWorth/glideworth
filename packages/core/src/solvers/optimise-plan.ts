/**
 * Plan optimiser: a heuristic search over the flow "levers" a caller names (keep or disable a flow, scale
 * its amount, redirect a mortgage overpayment into an account or the other way round), scored by the
 * deterministic engine. It answers "which of these changes gets me the earliest retirement / financial
 * independence, or the most money at the end, without the plan running short?".
 *
 * It is NOT a global optimiser: it only moves the levers it is given, over the values it is given.
 * Small spaces are searched exhaustively; larger ones by coordinate descent (one lever at a time, keep any
 * improvement, repeat until a full pass improves nothing). Every evaluation is a deterministic projection
 * (no Monte Carlo, no randomness), so the same request always gives the same answer.
 */
import { z } from "zod";
import { formatMonth, parseMonth } from "../engine/dates.js";
import { simulate as coreSimulate } from "../engine/simulate.js";
import type { ProjectionResult, SimulationInput } from "../engine/types.js";
import { ScenarioError } from "../errors.js";
import { fmtMoney, fmtMonth } from "../insights/format.js";
import { clone, deepEqual } from "../insights/json.js";
import { applyPlanPatch } from "../insights/patch.js";
import type { PatchOp } from "../schema/changes.js";
import type { Flow } from "../schema/flows.js";
import type { Plan } from "../schema/plan.js";
import { Id } from "../schema/primitives.js";
import type { SolverDeps } from "./contracts.js";
import { checkAbort, deterministicInput, isAbortError } from "./search.js";
import { milestoneAtMonthPatch, planFinances, planStartMonth } from "./variables.js";

export const OptimiseGoal = z.enum(["earliest-retirement", "earliest-fi", "max-end-net-worth"]);
export type OptimiseGoal = z.infer<typeof OptimiseGoal>;

export const OptimiseLever = z.discriminatedUnion("kind", [
  /** Try the flow as it is and switched the other way (enabled -> disabled, or disabled -> enabled). */
  z.object({ kind: z.literal("toggle"), flowId: Id }),
  /** Try the flow's amount (or share) multiplied by `steps` evenly spaced factors in [min, max], and 1. */
  z.object({
    kind: z.literal("scale"),
    flowId: Id,
    min: z.number().min(0).max(10).default(0.5),
    max: z.number().min(0).max(10).default(2),
    steps: z.number().int().min(2).max(21).default(5),
  }),
  /**
   * Try the flow as it is and pointed elsewhere with the same amount and dates: a debt paydown becomes a
   * contribution to `accountId`, a contribution becomes a paydown of `targetId` (a debt, or a real asset's
   * loan).
   */
  z.object({
    kind: z.literal("redirect"),
    flowId: Id,
    accountId: Id.optional(),
    targetId: Id.optional(),
  }),
]);
export type OptimiseLever = z.infer<typeof OptimiseLever>;
export type OptimiseLeverInput = z.input<typeof OptimiseLever>;

export const OptimisePlanRequest = z.object({
  goal: OptimiseGoal,
  /** The milestone the goal moves (default: the plan's retirement or financial-independence milestone). */
  milestoneId: Id.optional(),
  levers: z.array(OptimiseLever).min(1).max(12),
  /** Engine runs allowed (the baseline is always run). */
  maxEvaluations: z.number().int().min(1).max(1000).default(200),
  /** Alternatives returned besides the best candidate. */
  alternatives: z.number().int().min(0).max(10).default(5),
});
export type OptimisePlanRequest = z.infer<typeof OptimisePlanRequest>;
export type OptimisePlanRequestInput = z.input<typeof OptimisePlanRequest>;

export interface OptimiseCandidate {
  /** Readable lever settings that differ from the plan as it is (empty for the baseline). */
  changes: string[];
  /** The deterministic projection never runs short (at the goal month, for date goals). */
  feasible: boolean;
  /** Date goals: the earliest month reached (YYYY-MM), null when never or infeasible. */
  month: string | null;
  endNetWorthReal: number | null;
  lifetimeTaxesReal: number | null;
  firstShortfallYear: number | null;
  /** RFC 6902 ops that turn the plan into this candidate (lever changes only). */
  ops: PatchOp[];
  error?: string;
}

export interface OptimisePlanResult {
  goal: OptimiseGoal;
  milestoneId: string | null;
  /** The milestone's month in the plan as it is (date goals). */
  plannedMonth: string | null;
  method: "exhaustive" | "coordinate-descent";
  status: "complete" | "max-evaluations";
  /** Engine runs used, the baseline included. */
  evaluations: number;
  /** Lever combinations evaluated (the baseline included) out of `spaceSize`. */
  candidatesEvaluated: number;
  spaceSize: number;
  baseline: OptimiseCandidate;
  best: OptimiseCandidate;
  alternatives: OptimiseCandidate[];
  /** earliest-retirement: ops that also move the retirement milestone to the best candidate's month. */
  milestoneOps: PatchOp[];
  explanation: string;
}

interface Option {
  label: string | null;
  apply: (f: Flow) => Flow;
}

interface LeverSpace {
  lever: OptimiseLever;
  flowName: string;
  options: Option[];
  asIs: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** The scalable number of a flow, as a path inside the flow and its current value. */
function scalablePart(f: Flow): { get: () => number; set: (g: Flow, v: number) => void } | null {
  if (f.kind === "transfer") {
    const a = f.amount;
    if (a.kind === "amount")
      return {
        get: () => a.amount.value,
        set: (g, v) => {
          if (g.kind === "transfer" && g.amount.kind === "amount")
            g.amount.amount.value = round2(v);
        },
      };
    if (a.kind === "percentOfBalance")
      return {
        get: () => a.share,
        set: (g, v) => {
          if (g.kind === "transfer" && g.amount.kind === "percentOfBalance")
            g.amount.share = round4(clamp01(v));
        },
      };
    return null;
  }
  const m = f.method;
  if (m.kind === "amount")
    return {
      get: () => m.amount.value,
      set: (g, v) => {
        if (g.kind !== "transfer" && g.method.kind === "amount") g.method.amount.value = round2(v);
      },
    };
  if (
    m.kind === "percentOfRemaining" ||
    m.kind === "percentOfIncome" ||
    m.kind === "percentOfBalance"
  )
    return {
      get: () => m.share,
      set: (g, v) => {
        const gm = g.kind === "transfer" ? null : g.method;
        if (gm && "share" in gm) gm.share = round4(clamp01(v));
      },
    };
  return null;
}

function scaleFlow(f: Flow, factor: number, original: Flow): Flow {
  const part = scalablePart(original);
  const target = scalablePart(f);
  if (!part || !target) return f;
  const g = clone(f);
  target.set(g, part.get() * factor);
  return g;
}

/** A debt paydown as a contribution to `accountId`, or a contribution as a paydown of `targetId`. */
function redirectFlow(f: Flow, lever: Extract<OptimiseLever, { kind: "redirect" }>): Flow {
  const base = {
    id: f.id,
    name: f.name,
    owner: f.owner,
    range: f.range,
    mandatory: f.mandatory,
    enabled: f.enabled,
    ...(f.notes !== undefined ? { notes: f.notes } : {}),
    ...(f.appearance !== undefined ? { appearance: f.appearance } : {}),
  };
  if (f.kind === "debtPaydown") {
    const m = f.method;
    if (m.kind === "percentOfBalance") return f;
    return {
      ...base,
      kind: "contribution",
      accountId: lever.accountId!,
      strategy: { kind: "indefinite" },
      method: clone(m),
      limit: { kind: "none" },
      route: "standard",
      fundFromAccountIds: [],
    } as Flow;
  }
  if (f.kind === "contribution") {
    const m = f.method;
    if (m.kind === "percentOfIncome") return f;
    return { ...base, kind: "debtPaydown", targetId: lever.targetId!, method: clone(m) } as Flow;
  }
  return f;
}

/** Validate the levers against the plan and list each lever's options (index `asIs` = the plan as it is). */
function leverSpaces(input: SimulationInput, levers: OptimiseLever[]): LeverSpace[] {
  const plan = input.plan;
  const fin = planFinances(input);
  const names = new Map<string, string>();
  for (const x of [...fin.accounts, ...fin.debts, ...fin.realAssets]) names.set(x.id, x.name);
  for (const x of plan.plannedAccounts ?? []) names.set(x.id, x.name);
  for (const x of plan.plannedRealAssets ?? []) names.set(x.id, x.name);
  const accountIds = new Set([
    ...fin.accounts.map((a) => a.id),
    ...(plan.plannedAccounts ?? []).map((a) => a.id),
  ]);
  const loanIds = new Set([
    ...fin.debts.map((d) => d.id),
    ...fin.realAssets.filter((r) => r.loan).map((r) => r.id),
    ...(plan.plannedRealAssets ?? []).filter((r) => r.purchase.financing).map((r) => r.id),
  ]);
  const seen = new Set<string>();
  return levers.map((lever) => {
    const f = plan.flows.find((x) => x.id === lever.flowId);
    if (!f)
      throw new ScenarioError(`unknown flow '${lever.flowId}'`, {
        flowId: lever.flowId,
        flowIds: plan.flows.map((x) => x.id),
      });
    const key = `${lever.kind}:${lever.flowId}`;
    if (seen.has(key))
      throw new ScenarioError(`two '${lever.kind}' levers on flow '${lever.flowId}'`, {
        flowId: lever.flowId,
      });
    seen.add(key);
    const asIsOption: Option = { label: null, apply: (g) => g };
    if (lever.kind === "toggle") {
      const label = f.enabled ? "off" : "on";
      return {
        lever,
        flowName: f.name,
        asIs: 0,
        options: [asIsOption, { label, apply: (g) => ({ ...g, enabled: !f.enabled }) as Flow }],
      };
    }
    if (lever.kind === "scale") {
      if (!scalablePart(f)) {
        const ok = plan.flows.filter((x) => scalablePart(x)).map((x) => x.id);
        throw new ScenarioError(
          `flow '${f.id}' has no fixed amount or share to scale (its method is '${f.kind === "transfer" ? f.amount.kind : f.method.kind}'); flows that can be scaled: ${ok.join(", ") || "(none)"}`,
          { flowId: f.id, scalableFlowIds: ok },
        );
      }
      if (lever.max < lever.min)
        throw new ScenarioError(`scale lever on '${f.id}': max is below min`, { flowId: f.id });
      const factors = new Set<number>([1]);
      for (let i = 0; i < lever.steps; i++)
        factors.add(round4(lever.min + ((lever.max - lever.min) * i) / (lever.steps - 1)));
      const sorted = [...factors].sort((a, b) => a - b);
      return {
        lever,
        flowName: f.name,
        asIs: sorted.indexOf(1),
        options: sorted.map((s) =>
          s === 1 ? asIsOption : { label: `x${s}`, apply: (g: Flow) => scaleFlow(g, s, f) },
        ),
      };
    }
    // redirect
    if (f.kind === "debtPaydown") {
      if (!lever.accountId)
        throw new ScenarioError(
          `redirect lever on debt paydown '${f.id}' needs accountId: the account to contribute to instead`,
          { flowId: f.id, accountIds: [...accountIds] },
        );
      if (!accountIds.has(lever.accountId))
        throw new ScenarioError(`unknown account '${lever.accountId}'`, {
          accountId: lever.accountId,
          accountIds: [...accountIds],
        });
      if (f.method.kind === "percentOfBalance")
        throw new ScenarioError(
          `flow '${f.id}' pays a share of the debt's balance, which has no equivalent contribution; give it an amount first`,
          { flowId: f.id },
        );
    } else if (f.kind === "contribution") {
      if (!lever.targetId)
        throw new ScenarioError(
          `redirect lever on contribution '${f.id}' needs targetId: the debt or real asset (its loan) to pay down instead`,
          { flowId: f.id, debtIds: [...loanIds] },
        );
      if (!loanIds.has(lever.targetId))
        throw new ScenarioError(
          `'${lever.targetId}' is not a debt or a real asset with a loan in this plan`,
          { targetId: lever.targetId, debtIds: [...loanIds] },
        );
      if (f.method.kind === "percentOfIncome")
        throw new ScenarioError(
          `flow '${f.id}' contributes a share of an income, which has no equivalent debt payment; give it an amount first`,
          { flowId: f.id },
        );
    } else
      throw new ScenarioError(
        `flow '${f.id}' is a transfer; only debt paydowns and contributions can be redirected`,
        { flowId: f.id },
      );
    const to =
      f.kind === "debtPaydown"
        ? `contribute to ${names.get(lever.accountId!) ?? lever.accountId}`
        : `pay down ${names.get(lever.targetId!) ?? lever.targetId}`;
    return {
      lever,
      flowName: f.name,
      asIs: 0,
      options: [asIsOption, { label: to, apply: (g) => redirectFlow(g, lever) }],
    };
  });
}

/** The plan for a choice of options, and the ops from the original plan (one or two per changed flow). */
function build(plan: Plan, spaces: LeverSpace[], choice: number[]) {
  const order = { redirect: 0, scale: 1, toggle: 2 } as const;
  const byFlow = new Map<string, { space: LeverSpace; option: Option }[]>();
  spaces.forEach((space, i) => {
    const option = space.options[choice[i]!]!;
    if (option.label === null) return;
    const list = byFlow.get(space.lever.flowId) ?? [];
    list.push({ space, option });
    byFlow.set(space.lever.flowId, list);
  });
  const ops: PatchOp[] = [];
  const changes: string[] = [];
  for (const [flowId, list] of byFlow) {
    const original = plan.flows.find((f) => f.id === flowId)!;
    list.sort((a, b) => order[a.space.lever.kind] - order[b.space.lever.kind]);
    let next: Flow = clone(original);
    for (const { option } of list) next = option.apply(next);
    const path = `/flows/[id=${flowId}]`;
    // A flow switched off needs nothing else (its amount or target no longer matter).
    if (original.enabled && !next.enabled) {
      ops.push({ op: "replace", path: `${path}/enabled`, value: false });
      changes.push(`${original.name}: off`);
      continue;
    }
    for (const { space, option } of list) changes.push(`${space.flowName}: ${option.label}`);
    if (next.kind !== original.kind) {
      ops.push({ op: "replace", path, value: next });
      continue;
    }
    if (next.enabled !== original.enabled)
      ops.push({ op: "replace", path: `${path}/enabled`, value: next.enabled });
    if (next.kind === "transfer" && original.kind === "transfer") {
      if (!deepEqual(next.amount, original.amount))
        ops.push({ op: "replace", path: `${path}/amount`, value: next.amount });
    } else if (next.kind !== "transfer" && original.kind !== "transfer") {
      if (!deepEqual(next.method, original.method))
        ops.push({ op: "replace", path: `${path}/method`, value: next.method });
    }
  }
  return { ops, changes };
}

class BudgetSpent extends Error {}

/** The goal's milestone and each lever's options; throws ScenarioError naming what is wrong. */
function prepare(input: SimulationInput, req: OptimisePlanRequest) {
  const plan = input.plan;
  let milestoneId: string | null = null;
  if (req.goal !== "max-end-net-worth") {
    const kind = req.goal === "earliest-retirement" ? "retirement" : "financial-independence";
    const m = req.milestoneId
      ? plan.milestones.find((x) => x.id === req.milestoneId)
      : plan.milestones.find((x) => x.kind === kind);
    if (!m)
      throw new ScenarioError(
        req.milestoneId
          ? `unknown milestone '${req.milestoneId}'`
          : `the plan has no ${kind} milestone; pass milestoneId`,
        { milestoneIds: plan.milestones.map((x) => x.id) },
      );
    milestoneId = m.id;
  }
  return { milestoneId, spaces: leverSpaces(input, req.levers) };
}

/** Check a request against the plan without running anything (the same errors `optimisePlan` throws). */
export function checkOptimisePlanRequest(
  input: SimulationInput,
  raw: OptimisePlanRequestInput,
): void {
  prepare(input, OptimisePlanRequest.parse(raw));
}

export async function optimisePlan(
  input: SimulationInput,
  raw: OptimisePlanRequestInput,
  deps: SolverDeps = {},
): Promise<OptimisePlanResult> {
  const req = OptimisePlanRequest.parse(raw);
  const plan = input.plan;
  const sim = deps.simulate ?? ((i: SimulationInput) => coreSimulate(i));
  const start = planStartMonth(input);

  const { milestoneId, spaces } = prepare(input, req);
  const spaceSize = spaces.reduce((n, s) => n * s.options.length, 1);

  let evaluations = 0;
  let budgetExempt = true;
  const run = (p: Plan): ProjectionResult => {
    checkAbort(deps.signal);
    if (!budgetExempt && evaluations >= req.maxEvaluations) throw new BudgetSpent();
    evaluations++;
    deps.onProgress?.(evaluations);
    return sim(deterministicInput({ ...input, plan: p }));
  };

  // Baseline run: horizon and the milestone as planned.
  const baseRun = run(plan);
  const horizon = parseMonth(baseRun.meta.endMonth) - start;
  const planned = milestoneId
    ? (baseRun.milestones.find((m) => m.milestoneId === milestoneId)?.month ?? null)
    : null;

  /** Scored candidate: `value` is the goal (months from start for date goals, lower is better). */
  type Scored = OptimiseCandidate & { value: number | null; key: string; changeCount: number };
  const memo = new Map<string, Scored>();

  const outcome = (r: ProjectionResult) => ({
    endNetWorthReal: Math.round(r.summary.endNetWorthReal),
    lifetimeTaxesReal: Math.round(r.summary.lifetimeTaxesReal),
    firstShortfallYear: r.summary.firstShortfallYear,
  });

  /** Earliest feasible retirement month (months from start) for a candidate plan, or null. */
  const earliestRetirement = (
    p: Plan,
    mustBeat: number | null,
  ): { month: number; result: ProjectionResult } | null => {
    const at = (month: number) =>
      run(
        applyPlanPatch(
          p,
          milestoneAtMonthPatch({ ...input, plan: p }, milestoneId!, start + month),
        ),
      );
    let hi = mustBeat ?? horizon;
    let hiResult = at(hi);
    if (!hiResult.summary.success) return null;
    let lo = 0;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const r = at(mid);
      if (r.summary.success) {
        hi = mid;
        hiResult = r;
      } else lo = mid + 1;
    }
    return { month: hi, result: hiResult };
  };

  const evaluate = (choice: number[], mustBeat: number | null): Scored => {
    const { ops, changes } = build(plan, spaces, choice);
    const key = JSON.stringify(ops);
    const hit = memo.get(key);
    if (hit) return hit;
    let scored: Scored;
    const empty = { endNetWorthReal: null, lifetimeTaxesReal: null, firstShortfallYear: null };
    try {
      const p = ops.length ? applyPlanPatch(plan, ops) : plan;
      if (req.goal === "earliest-retirement") {
        const found = earliestRetirement(p, mustBeat);
        scored = found
          ? {
              changes,
              ops,
              key,
              changeCount: changes.length,
              feasible: true,
              value: found.month,
              month: formatMonth(start + found.month),
              ...outcome(found.result),
            }
          : {
              changes,
              ops,
              key,
              changeCount: changes.length,
              // Pruned (not earlier than the best so far) or never without a shortfall.
              feasible: mustBeat !== null,
              value: null,
              month: null,
              ...empty,
            };
      } else {
        const r = ops.length ? run(p) : baseRun;
        const ms = milestoneId ? r.milestones.find((m) => m.milestoneId === milestoneId) : null;
        const month = ms?.status === "reached" && ms.month ? ms.month : null;
        scored = {
          changes,
          ops,
          key,
          changeCount: changes.length,
          feasible: r.summary.success,
          month,
          value:
            req.goal === "max-end-net-worth"
              ? r.summary.endNetWorthReal
              : month === null
                ? null
                : parseMonth(month) - start,
          ...outcome(r),
        };
      }
    } catch (e) {
      if (e instanceof BudgetSpent) throw e;
      if (isAbortError(e)) throw e;
      scored = {
        changes,
        ops,
        key,
        changeCount: changes.length,
        feasible: false,
        value: null,
        month: null,
        ...empty,
        error: (e as Error).message,
      };
    }
    // A pruned retirement candidate is not memoised as final: it was only compared with one bound.
    if (!(req.goal === "earliest-retirement" && scored.value === null && mustBeat !== null))
      memo.set(key, scored);
    return scored;
  };

  const lowerIsBetter = req.goal !== "max-end-net-worth";
  /** Negative when a ranks before b. */
  const compare = (a: Scored, b: Scored): number => {
    if (a.feasible !== b.feasible) return a.feasible ? -1 : 1;
    if ((a.value === null) !== (b.value === null)) return a.value === null ? 1 : -1;
    if (a.value !== null && b.value !== null && a.value !== b.value)
      return lowerIsBetter ? a.value - b.value : b.value - a.value;
    const nw = (b.endNetWorthReal ?? -Infinity) - (a.endNetWorthReal ?? -Infinity);
    if (nw !== 0 && Number.isFinite(nw)) return nw;
    return a.changeCount - b.changeCount;
  };

  const baseChoice = spaces.map((s) => s.asIs);
  const baseline = evaluate(baseChoice, null);
  budgetExempt = false;

  const perCandidate =
    req.goal === "earliest-retirement" ? Math.ceil(Math.log2(horizon + 1)) + 1 : 1;
  const exhaustive = (spaceSize - 1) * perCandidate <= req.maxEvaluations;
  let status: OptimisePlanResult["status"] = "complete";
  let best = baseline;
  const better = (c: Scored) => c.value !== null && compare(c, best) < 0;

  try {
    if (exhaustive) {
      const choice = spaces.map(() => 0);
      const total = spaceSize;
      for (let n = 0; n < total; n++) {
        let rest = n;
        for (let i = 0; i < spaces.length; i++) {
          choice[i] = rest % spaces[i]!.options.length;
          rest = Math.floor(rest / spaces[i]!.options.length);
        }
        const c = evaluate([...choice], null);
        if (better(c)) best = c;
      }
    } else {
      let current = [...baseChoice];
      for (let pass = 0; pass < 20; pass++) {
        let improved = false;
        for (let i = 0; i < spaces.length; i++) {
          for (let o = 0; o < spaces[i]!.options.length; o++) {
            if (o === current[i]) continue;
            const choice = [...current];
            choice[i] = o;
            const bound =
              req.goal === "earliest-retirement" && best.value !== null ? best.value : null;
            const c = evaluate(choice, bound);
            if (better(c)) {
              best = c;
              current = choice;
              improved = true;
            }
          }
        }
        if (!improved) break;
      }
    }
  } catch (e) {
    if (!(e instanceof BudgetSpent)) throw e;
    status = "max-evaluations";
  }

  const ranked = [...memo.values()].filter((c) => c.value !== null).sort(compare);
  const alternatives = ranked.filter((c) => c.key !== best.key).slice(0, req.alternatives);
  const strip = ({ value: _v, key: _k, changeCount: _c, ...c }: Scored): OptimiseCandidate => c;

  const milestoneOps =
    req.goal === "earliest-retirement" && best.value !== null
      ? milestoneAtMonthPatch(
          { ...input, plan: best.ops.length ? applyPlanPatch(plan, best.ops) : plan },
          milestoneId!,
          start + best.value,
        )
      : [];

  return {
    goal: req.goal,
    milestoneId,
    plannedMonth: planned,
    method: exhaustive ? "exhaustive" : "coordinate-descent",
    status,
    evaluations,
    candidatesEvaluated: memo.size,
    spaceSize,
    baseline: strip(baseline),
    best: strip(best),
    alternatives: alternatives.map(strip),
    milestoneOps,
    explanation: explain(req.goal, baseline, best, input.household.currency, planned),
  };
}

function describeValue(goal: OptimiseGoal, c: OptimiseCandidate, currency: string): string {
  if (goal === "max-end-net-worth")
    return `${fmtMoney(c.endNetWorthReal ?? 0, { currency })} in today's money`;
  return c.month ? fmtMonth(c.month) : "never";
}

function explain(
  goal: OptimiseGoal,
  baseline: OptimiseCandidate & { value: number | null },
  best: OptimiseCandidate & { value: number | null },
  currency: string,
  planned: string | null,
): string {
  const what =
    goal === "earliest-retirement"
      ? "Earliest retirement without a shortfall"
      : goal === "earliest-fi"
        ? "Financial independence"
        : "Net worth at the end";
  if (best.value === null)
    return `None of the lever settings tried keeps the plan from running short${goal === "earliest-fi" ? " while reaching financial independence" : ""}.`;
  const plannedNote =
    goal === "earliest-retirement" && planned
      ? ` (retirement is planned for ${fmtMonth(planned)})`
      : "";
  if (best === baseline || best.changes.length === 0)
    return `${what}: ${describeValue(goal, best, currency)} with the plan as it is${plannedNote}; none of the lever settings tried does better.`;
  const before =
    baseline.value === null
      ? goal === "max-end-net-worth"
        ? "the plan as it is runs short"
        : "not reachable with the plan as it is"
      : `${describeValue(goal, baseline, currency)} as it is`;
  return `${what}: ${describeValue(goal, best, currency)} with ${best.changes.join("; ")} (${before})${plannedNote}. A search over the levers given, not every possible plan.`;
}
