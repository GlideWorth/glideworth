/**
 * "Why did my number change?"
 *
 * Splits the movement of the headline results between two points in time (a check-in and now, or two
 * check-ins) into causes a person recognises. Each point carries the inputs it was computed from (plan,
 * household, current finances) and, when it was computed earlier, the values it stored then and the
 * fingerprints of Glideworth's side (engine version, tax tables, market history).
 *
 * Method: a fixed sequence of states, each changing one kind of input on top of the previous one, all
 * computed with today's engine. The causes are measured in this order (RESULT_CHANGE_ORDER):
 *
 *   0. the stored "before" values (as computed then)
 *   1. glideworth  today's engine, tax tables and market history on the SAME "before" inputs
 *   2. time        the start month moved to the "after" month, with the balances the plan expected then
 *                  (interpolated from the "before" projection)
 *   3. balances    the actual "after" balances, accounts and exchange rates instead of the expected ones
 *   4. household   the "after" household details (people, location)
 *   5. plan        the "after" plan (the user's edits); each edit is also measured alone on the same base
 *   6. the stored "after" values, when "after" is a stored check-in (Glideworth's side again)
 *
 * Steps telescope, so the parts add up to the total exactly. Changing one thing at a time gives
 * order-dependent answers; this order is stated in the output. A Glideworth step with no fingerprint
 * change (the same inputs recomputed to a different answer) is reported as `unexplained`, not hidden.
 *
 * Pure: no clock, no randomness beyond the seeded Monte Carlo; months come in with the inputs.
 */
import { ENGINE_VERSION, simulate as coreSimulate } from "../engine/simulate.js";
import { type ProjectionResult, type SimulationInput, SimulationOptions } from "../engine/types.js";
import type { Household } from "../schema/household.js";
import type { CurrentFinances, Plan } from "../schema/plan.js";
import type {
  HeadlineValues,
  ResultChange,
  ResultChangeCause,
  ResultChangeMetric,
  ResultChangePart,
  ResultChangeStep,
  ResultFingerprints,
  ResultMetricChange,
} from "../schema/result-change.js";
import type { SolverDeps } from "../solvers/contracts.js";
import { checkAbort } from "../solvers/search.js";
import { MARKET_DATASETS } from "../stochastic/data/index.js";
import { hashString } from "../stochastic/math.js";
import { runMonteCarloAsync } from "../stochastic/index.js";
import * as taxData from "../tax/data/index.js";
import { groupPatch } from "./difference.js";
import { diffJson, diffPlans } from "./diff.js";
import { type FormatContext, fmtMoney, fmtPercent, pluralDuration } from "./format.js";
import { deepEqual } from "./json.js";
import { applyPlanPatch } from "./patch.js";

export const RESULT_CHANGE_ORDER: readonly ResultChangeCause[] = [
  "glideworth",
  "time",
  "balances",
  "household",
  "plan",
];

const CAUSE_LABEL: Record<ResultChangeCause, string> = {
  glideworth: "Changes on Glideworth's side (engine, tax tables, market history)",
  time: "The passage of time (a later start)",
  balances: "Updated balances (actual versus what the plan expected)",
  household: "Household details you changed",
  plan: "Plan edits you made",
};

const METRIC_META: Record<
  ResultChangeMetric,
  { label: string; unit: ResultMetricChange["unit"]; basis?: "real" }
> = {
  successRate: { label: "Chance of success", unit: "fraction" },
  fiYear: { label: "Financial-independence year", unit: "year" },
  endNetWorthReal: { label: "Net worth at the end of the plan", unit: "money", basis: "real" },
};

export const RESULT_CHANGE_METHOD =
  "Each cause is applied one step at a time on top of the ones before it, in the order listed in `order`, and every step is recomputed with today's engine. A different order could split the same total differently; the total does not change. Plan edits are also measured one at a time on the same base, and what they do not explain together is shown as their interaction.";

export const RESULT_CHANGE_NOTES = [
  "These are estimates from the plan's assumptions, not financial advice.",
  "The chance of success uses the earlier point's number of trials and random seed for every step, so each step sees the same market paths.",
];

// ----------------------------------------------------------------------------- fingerprints

const fingerprint = (v: unknown): string =>
  hashString(JSON.stringify(v, (_k, x: unknown) => (typeof x === "function" ? undefined : x)))
    .toString(16)
    .padStart(8, "0");

let fingerprints: ResultFingerprints | null = null;

/** What Glideworth contributes to a result today. Store it with a result to tell later what changed. */
export function resultFingerprints(): ResultFingerprints {
  fingerprints ??= {
    engineVersion: ENGINE_VERSION,
    taxTables: fingerprint({ ...taxData }),
    marketData: fingerprint(MARKET_DATASETS),
  };
  return fingerprints;
}

// ----------------------------------------------------------------------------- headline values

const FI_MILESTONE = /(^|[-_])fi($|[-_])|financial independence|\bFIRE?\b/i;

/** The financial-independence year a check-in reports: the FI milestone, else the retirement year. */
export function fiYearOf(result: ProjectionResult): number | null {
  const fi = result.milestones.find(
    (m) => FI_MILESTONE.test(`${m.milestoneId} ${m.name}`) && m.status === "reached",
  );
  return fi?.month ? Number(fi.month.slice(0, 4)) : (result.summary.retirementYear ?? null);
}

// ----------------------------------------------------------------------------- expected balances

const monthIndex = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;

/** Linear interpolation over (month index, value) points sorted by month; clamps at the ends. */
function interpolate(points: [number, number][], t: number): number {
  let prev = points[0]!;
  for (const p of points) {
    if (p[0] === t) return p[1];
    if (p[0] > t) {
      if (p[0] === prev[0]) return p[1];
      return prev[1] + ((p[1] - prev[1]) * (t - prev[0])) / (p[0] - prev[0]);
    }
    prev = p;
  }
  return prev[1];
}

/**
 * The finances the plan expected at `asOf`: each account, property and debt that the projection follows
 * is moved to its projected value, interpolated linearly within the year (in its own currency), and the
 * start month becomes `asOf`. Items the projection does not follow keep their balance. Cost bases are
 * left as they were.
 */
export function expectedFinances(
  finances: CurrentFinances,
  result: ProjectionResult,
  asOf: string,
): CurrentFinances {
  const t0 = monthIndex(finances.asOf);
  const t = monthIndex(asOf);
  if (t <= t0) return { ...finances, asOf };
  const ends = result.periods.map((p) => monthIndex(p.startMonth) + p.months);
  const path = (start: number, pick: (i: number) => number | undefined): number => {
    const pts: [number, number][] = [[t0, start]];
    result.periods.forEach((_, i) => {
      const v = pick(i);
      if (v !== undefined) pts.push([ends[i]!, v]);
    });
    return pts.length === 1 ? start : interpolate(pts, t);
  };
  return {
    ...finances,
    asOf,
    accounts: finances.accounts.map((a) =>
      a.archived
        ? a
        : {
            ...a,
            balance: path(a.balance, (i) => {
              const ap = result.periods[i]!.accounts.find((x) => x.accountId === a.id);
              return ap ? (ap.closingOriginal ?? ap.closing) : undefined;
            }),
          },
    ),
    realAssets: finances.realAssets.map((r) => {
      if (r.archived) return r;
      const at = (i: number) => result.periods[i]!.realAssets.find((x) => x.assetId === r.id);
      return {
        ...r,
        currentValue: path(r.currentValue, (i) => {
          const rp = at(i);
          return rp ? (rp.valueOriginal ?? rp.value) : undefined;
        }),
        ...(r.loan
          ? {
              loan: {
                ...r.loan,
                balance: path(r.loan.balance, (i) => {
                  const rp = at(i);
                  return rp ? (rp.loanBalanceOriginal ?? rp.loanBalance) : undefined;
                }),
              },
            }
          : {}),
      };
    }),
    debts: finances.debts.map((d) =>
      d.archived
        ? d
        : {
            ...d,
            balance: path(d.balance, (i) => {
              const dp = result.periods[i]!.debts.find((x) => x.debtId === d.id);
              return dp ? (dp.closingOriginal ?? dp.closing) : undefined;
            }),
          },
    ),
  };
}

// ----------------------------------------------------------------------------- attribution

export interface ResultCheckpoint {
  household: Household;
  finances: CurrentFinances;
  plan: Plan;
  /** What was stored when this point was computed (absent for "now"). */
  stored?: { values: HeadlineValues; fingerprints: ResultFingerprints } | undefined;
}

export interface ResultChangeOptions {
  /** Trials and seed for the chance of success (the earlier check-in's). Null: skip chance of success. */
  monteCarlo?: { trials: number; seed: number } | null | undefined;
  format?: FormatContext | undefined;
}

type State = { household: Household; finances: CurrentFinances; plan: Plan };

const financesKey = (f: CurrentFinances) => ({ ...f, updatedAt: undefined });

/** Split the change in the headline results between `before` and `after` into causes (see the file header). */
export async function attributeResultChange(
  before: ResultCheckpoint,
  after: ResultCheckpoint,
  opts: ResultChangeOptions = {},
  deps: SolverDeps = {},
): Promise<ResultChange> {
  const now = resultFingerprints();
  const sim = deps.simulate ?? ((i: SimulationInput) => coreSimulate(i));
  const mc = opts.monteCarlo ?? null;
  const metrics: ResultChangeMetric[] = mc
    ? ["successRate", "fiYear", "endNetWorthReal"]
    : ["fiYear", "endNetWorthReal"];
  const fmt = opts.format ?? { currency: before.household.currency };

  // Memoised evaluation: identical states (a step where nothing of that kind changed) are computed once.
  const seen: { state: State; values: HeadlineValues; result: ProjectionResult }[] = [];
  let evaluations = 0;
  const evaluate = async (state: State) => {
    const hit = seen.find((s) => deepEqual(s.state, state));
    if (hit) return hit;
    checkAbort(deps.signal);
    const input: SimulationInput = {
      household: state.household,
      finances: state.finances,
      plan: { ...state.plan, lineage: undefined },
      options: SimulationOptions.parse({ trace: "off" }),
    };
    const result = sim(input);
    let successRate: number | null = null;
    if (mc) {
      const settings = { ...input.plan.monteCarlo, trials: mc.trials, seed: mc.seed };
      const run = deps.evaluate
        ? await deps.evaluate({ ...input, plan: { ...input.plan, monteCarlo: settings } })
        : await runMonteCarloAsync(input, settings, {
            keepTrials: false,
            ...(deps.signal ? { signal: deps.signal } : {}),
          });
      successRate = run.successRate;
    }
    const values: HeadlineValues = {
      successRate,
      fiYear: fiYearOf(result),
      endNetWorthReal: result.summary.endNetWorthReal,
    };
    evaluations += 1;
    deps.onProgress?.(evaluations);
    const entry = { state, values, result };
    seen.push(entry);
    return entry;
  };

  // The states, in RESULT_CHANGE_ORDER.
  const s1: State = { household: before.household, finances: before.finances, plan: before.plan };
  const e1 = await evaluate(s1);
  const s2: State = {
    ...s1,
    finances: expectedFinances(before.finances, e1.result, after.finances.asOf),
  };
  const s3: State = { ...s1, finances: after.finances };
  const s4: State = { ...s3, household: after.household };
  const s5: State = { ...s4, plan: after.plan };
  const e2 = await evaluate(s2);
  const e3 = await evaluate(s3);
  const e4 = await evaluate(s4);
  const e5 = await evaluate(s5);

  // Plan edits, each alone on the step-4 base (deterministic measures only).
  const diff = diffPlans(before.plan, after.plan, fmt.currency ? { currency: fmt.currency } : {});
  const groups = groupPatch(diff);
  const editValues: { key: string; description: string; values: HeadlineValues | null }[] = [];
  for (const g of groups) {
    const description =
      g.changes.map((c) => c.description).join("; ") || g.ops.map((o) => o.path).join("; ");
    let values: HeadlineValues | null = null;
    try {
      checkAbort(deps.signal);
      const r = sim({
        household: s4.household,
        finances: s4.finances,
        plan: { ...applyPlanPatch(before.plan, g.ops), lineage: undefined },
        options: SimulationOptions.parse({ trace: "off", lean: true }),
      });
      values = {
        successRate: null,
        fiYear: fiYearOf(r),
        endNetWorthReal: r.summary.endNetWorthReal,
      };
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
    }
    editValues.push({ key: g.key, description, values });
  }

  // Glideworth's side: which fingerprints moved, at either end.
  const changedFp = (fp: ResultFingerprints | undefined) =>
    fp
      ? (["engineVersion", "taxTables", "marketData"] as const).filter((k) => fp[k] !== now[k])
      : [];
  const fpBefore = changedFp(before.stored?.fingerprints);
  const fpAfter = changedFp(after.stored?.fingerprints);
  const fpChanged = [...new Set([...fpBefore, ...fpAfter])];

  const sub = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b);
  const add = (a: number | null, b: number | null) => (a === null || b === null ? null : a + b);

  const metricChanges: ResultMetricChange[] = metrics.map((metric) => {
    const v = (h: HeadlineValues) => h[metric];
    const start = before.stored ? v(before.stored.values) : v(e1.values);
    const end = after.stored ? v(after.stored.values) : v(e5.values);
    const total = sub(end, start);
    // Glideworth's side: recompute the same inputs today at each stored end.
    const gw = add(
      before.stored ? sub(v(e1.values), start) : 0,
      after.stored ? sub(end, v(e5.values)) : 0,
    );
    const plan = sub(v(e5.values), v(e4.values));
    const edits =
      metric === "successRate"
        ? editValues.map((e) => ({ key: e.key, description: e.description, delta: null }))
        : editValues.map((e) => ({
            key: e.key,
            description: e.description,
            delta: e.values ? sub(v(e.values), v(e4.values)) : null,
          }));
    const editSum = edits.reduce<number | null>((s, e) => add(s, e.delta), 0);
    const parts: ResultChangePart[] = [
      { cause: "glideworth", label: CAUSE_LABEL.glideworth, delta: fpChanged.length ? gw : 0 },
      { cause: "time", label: CAUSE_LABEL.time, delta: sub(v(e2.values), v(e1.values)) },
      { cause: "balances", label: CAUSE_LABEL.balances, delta: sub(v(e3.values), v(e2.values)) },
      { cause: "household", label: CAUSE_LABEL.household, delta: sub(v(e4.values), v(e3.values)) },
      {
        cause: "plan",
        label: CAUSE_LABEL.plan,
        delta: plan,
        ...(edits.length
          ? { edits, interaction: metric === "successRate" ? null : sub(plan, editSum) }
          : {}),
      },
    ];
    const explained = parts.reduce<number | null>((s, p) => add(s, p.delta), 0);
    return {
      metric,
      ...METRIC_META[metric],
      before: start,
      after: end,
      total,
      parts,
      unexplained: sub(total, explained),
    };
  });

  // What changed, in words.
  const months = monthIndex(after.finances.asOf) - monthIndex(before.finances.asOf);
  const householdOps = diffJson(before.household, after.household);
  const householdKeys = [
    ...new Set(householdOps.map((o) => o.path.split("/")[1] ?? "").filter(Boolean)),
  ];
  const balanceDetails = describeFinances(before.finances, after.finances);
  const steps: ResultChangeStep[] = [
    {
      cause: "glideworth",
      label: CAUSE_LABEL.glideworth,
      changed: fpChanged.length > 0,
      details: fpChanged.map((k) => {
        const was = before.stored?.fingerprints[k] ?? after.stored?.fingerprints[k];
        if (k === "engineVersion") return `Engine version ${was} → ${now.engineVersion}`;
        return k === "taxTables" ? "Tax tables updated" : "Market history updated";
      }),
    },
    {
      cause: "time",
      label: CAUSE_LABEL.time,
      changed: months !== 0,
      details:
        months !== 0
          ? [
              `Start moved from ${before.finances.asOf} to ${after.finances.asOf} (${pluralDuration(months, "month")})`,
            ]
          : [],
    },
    {
      cause: "balances",
      label: CAUSE_LABEL.balances,
      changed: balanceDetails.length > 0,
      details: balanceDetails,
    },
    {
      cause: "household",
      label: CAUSE_LABEL.household,
      changed: householdOps.length > 0,
      details: householdKeys.map((k) => `Changed: ${k}`),
    },
    {
      cause: "plan",
      label: CAUSE_LABEL.plan,
      changed: diff.changes.length > 0 || diff.patch.length > 0,
      details: diff.changes.map((c) => c.description),
    },
  ];
  const noChange =
    steps.every((s) => !s.changed) &&
    metricChanges.every((m) => !m.total || Math.abs(m.total) < 1e-9);

  return {
    available: true,
    noChange,
    order: [...RESULT_CHANGE_ORDER],
    method: RESULT_CHANGE_METHOD,
    fingerprints: {
      before: before.stored?.fingerprints ?? null,
      after: after.stored?.fingerprints ?? null,
      now,
    },
    steps,
    metrics: metricChanges,
    summary: noChange
      ? [
          "Nothing changed: the same plan, household, balances and start month, and the same engine, tax tables and market history.",
        ]
      : metricChanges
          .filter((m) => m.before !== null || m.after !== null)
          .map((m) => summarise(m, fmt)),
    notes: [...RESULT_CHANGE_NOTES],
  };
}

function describeFinances(a: CurrentFinances, b: CurrentFinances): string[] {
  if (deepEqual(financesKey({ ...a, asOf: b.asOf }), financesKey(b))) return [];
  const out = [
    ...describeItems("account", a.accounts, b.accounts, (x) => x.balance),
    ...describeItems("property", a.realAssets, b.realAssets, (x) => x.currentValue),
    ...describeItems("debt", a.debts, b.debts, (x) => x.balance),
  ];
  if (!deepEqual(a.fxRates ?? [], b.fxRates ?? [])) out.push("Exchange rates updated");
  if (out.length === 0) out.push("Other account details updated");
  return out;
}

function describeItems<T extends { id: string }>(
  noun: string,
  xs: T[],
  ys: T[],
  value: (x: T) => number,
): string[] {
  const out: string[] = [];
  const plural = (n: number, s: string) =>
    `${n} ${n === 1 ? s : s.endsWith("y") ? `${s.slice(0, -1)}ies` : `${s}s`}`;
  const moved = ys.filter((y) => {
    const x = xs.find((z) => z.id === y.id);
    return x !== undefined && value(x) !== value(y);
  }).length;
  const added = ys.filter((y) => !xs.some((x) => x.id === y.id)).length;
  const removed = xs.filter((x) => !ys.some((y) => y.id === x.id)).length;
  if (moved) out.push(`${plural(moved, `${noun} value`)} updated`);
  if (added) out.push(`${plural(added, noun)} added`);
  if (removed) out.push(`${plural(removed, noun)} removed`);
  return out;
}

function fmtDelta(m: ResultMetricChange, d: number, fmt: FormatContext): string {
  const sign = d > 0 ? "+" : d < 0 ? "−" : "±";
  if (m.unit === "fraction") return `${sign}${Math.round(Math.abs(d) * 1000) / 10} points`;
  if (m.unit === "year") {
    const n = Math.round(Math.abs(d) * 10) / 10;
    return `${sign}${pluralDuration(n, "year")}`;
  }
  return `${sign}${fmtMoney(Math.abs(d), fmt)}`;
}

function fmtValue(m: ResultMetricChange, v: number | null, fmt: FormatContext): string {
  if (v === null) return m.unit === "year" ? "not reached" : "unknown";
  if (m.unit === "fraction") return fmtPercent(Math.round(v * 1000) / 1000, fmt);
  if (m.unit === "year") return String(v);
  return fmtMoney(v, fmt);
}

function summarise(m: ResultMetricChange, fmt: FormatContext): string {
  const head = `${m.label}: ${fmtValue(m, m.before, fmt)} → ${fmtValue(m, m.after, fmt)}`;
  if (m.total === null) return `${head}.`;
  const small = (d: number) =>
    m.unit === "fraction" ? Math.abs(d) < 0.0005 : m.unit === "year" ? d === 0 : Math.abs(d) < 0.5;
  if (small(m.total) && m.parts.every((p) => p.delta === null || small(p.delta)))
    return `${head} (no change).`;
  const parts = m.parts
    .filter((p) => p.delta !== null && !small(p.delta))
    .map((p) => `${p.label.split(" (")[0]!.toLowerCase()} ${fmtDelta(m, p.delta!, fmt)}`);
  if (m.unexplained !== null && !small(m.unexplained))
    parts.push(`unexplained ${fmtDelta(m, m.unexplained, fmt)}`);
  return `${head} (${fmtDelta(m, m.total, fmt)}${parts.length ? `: ${parts.join(", ")}` : ""}).`;
}
