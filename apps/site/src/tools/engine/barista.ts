/**
 * Barista FIRE: the portfolio you need on the day you leave full-time work, when part-time pay covers
 * part of your spending for a number of years.
 *
 * Engine use: `solveRequiredPortfolio` (deterministic objective 'noShortfall') on a plan with the
 * spending, the part-time pay as after-tax income that stops at the chosen age, and the flat tax on
 * withdrawals. The solver scales the starting balance until every year is just funded. The same is
 * done for full retirement (no part-time pay) for comparison.
 */
import { solveRequiredPortfolio } from "@glideworth/core";
import { presentValue } from "../closed-form";
import { money, pct, pctInput } from "../format";
import { num, rate, str } from "../state";
import type { ChartSpec, Timing, Values, ViewModel } from "../types";
import { axis, balances, run } from "./common";
import { buildInput, type ModelOptions, taxText, timingText } from "./model";

interface Plan {
  age: number;
  years: number;
  spend: number;
  pt: number;
  ptYears: number;
  r: number;
  tax: number;
  timing: Timing;
  cur: string;
}

function model(p: Plan, balance: number, withPartTime: boolean): ModelOptions {
  return {
    currency: p.cur,
    age: p.age,
    years: p.years,
    balance,
    timing: p.timing,
    taxRate: p.tax,
    realReturn: p.r,
    spending: [{ id: "spending", name: "Spending", amount: p.spend, from: 0, to: null }],
    income:
      withPartTime && p.pt > 0 && p.ptYears > 0
        ? [{ id: "part-time", name: "Part-time pay", amount: p.pt, from: 0, to: p.ptYears }]
        : [],
  };
}

/** Net yearly withdrawals the formula funds (tax grossed up on what the portfolio pays). */
function formulaFlows(p: Plan, withPartTime: boolean): number[] {
  return Array.from({ length: p.years }, (_, t) => {
    const gap = p.spend - (withPartTime && t < p.ptYears ? p.pt : 0);
    return gap > 0 ? gap / (1 - p.tax) : gap;
  });
}

/** The engine's required starting portfolio (noShortfall), searched to about a millionth. */
export async function requiredPortfolio(p: Plan, withPartTime: boolean): Promise<number> {
  const pv = Math.max(0, presentValue(formulaFlows(p, withPartTime), p.r, p.timing));
  if (p.spend <= 0) return 0;
  // Search around the formula's answer; the base is any positive balance (the solver scales it).
  const base = Math.max(1, pv, p.spend);
  const res = await solveRequiredPortfolio(buildInput(model(p, base, withPartTime)), {
    objective: { kind: "noShortfall" },
    bounds: { min: 0, max: Math.max(2, (2 * pv) / base) },
    tolerance: 1e-7,
    maxEvaluations: 120,
  });
  if (res.value === null) return Number.NaN;
  return res.value * base;
}

function read(v: Values): Plan {
  const age = num(v, "age");
  return {
    age,
    years: num(v, "planTo") - age,
    spend: num(v, "spend"),
    pt: num(v, "pt"),
    ptYears: num(v, "ptUntil") - age,
    r: rate(v, "ret"),
    tax: rate(v, "tax"),
    timing: str(v, "timing") as Timing,
    cur: str(v, "cur"),
  };
}

export async function baristaNumbers(v: Values) {
  const p = read(v);
  const barista = await requiredPortfolio(p, true);
  const full = await requiredPortfolio(p, false);
  return {
    p,
    barista,
    full,
    formulaBarista: presentValue(formulaFlows(p, true), p.r, p.timing),
    formulaFull: presentValue(formulaFlows(p, false), p.r, p.timing),
    shortcut: Math.max(0, p.spend - p.pt) * 25,
  };
}

export async function runBarista(v: Values): Promise<ViewModel> {
  const { p, barista, full, formulaBarista, formulaFull, shortcut } = await baristaNumbers(v);
  const m = (x: number) => money(x, p.cur);
  const saving = full - barista;
  const ptEnd = p.age + p.ptYears;
  const planTo = p.age + p.years;

  const pathB = [barista, ...balances(run(buildInput(model(p, barista, true))))];
  const pathF = [full, ...balances(run(buildInput(model(p, full, false))))];
  const ages = axis(p.age, p.years);
  const chart: ChartSpec = {
    id: "barista-chart",
    kind: "line",
    title: "Portfolio by age, each starting with the amount it needs",
    summary: `Starting with ${m(barista)}, the barista plan draws only the gap while part-time pay lasts, so the balance holds up until ${ptEnd}, then falls to zero at ${planTo}. Full retirement starts with ${m(full)} and draws the whole of your spending from the start.`,
    xLabel: "Age",
    yLabel: "Today’s money",
    x: ages,
    series: [
      { label: `Barista: part-time pay to ${ptEnd}`, values: pathB, tone: 1, style: "solid" },
      { label: "Full retirement", values: pathF, tone: 2, style: "dashed" },
    ],
    markers:
      p.pt > 0 && p.ptYears > 0 && p.ptYears < p.years
        ? [{ x: ptEnd, label: `Pay stops at ${ptEnd}` }]
        : [],
    currency: p.cur,
    table: {
      caption: "Portfolio at the end of each year of age",
      columns: ["Age", "Barista plan", "Full retirement"],
      rows: ages.map((a, t) => [String(a), m(pathB[t] ?? 0), m(pathF[t] ?? 0)]),
    },
  };

  const okB = Number.isFinite(barista);
  const headline = !okB
    ? "The engine could not find a starting portfolio that funds this plan."
    : p.spend <= 0
      ? "With no spending, the plan needs no portfolio."
      : `You need about ${m(barista)} when you leave full-time work at ${p.age}. Full retirement on the same spending would need ${m(full)}, so the part-time pay to ${ptEnd} is worth ${m(saving)} (${pct(full > 0 ? saving / full : 0, 1)}).`;

  return {
    tool: "barista-fire",
    headline,
    announce: okB
      ? `Barista FIRE number ${m(barista)}; full retirement ${m(full)}.`
      : "No answer for these inputs.",
    figures: [
      {
        label: "Barista FIRE number",
        value: m(barista),
        detail: `Part-time pay to ${ptEnd}, plan to ${planTo}`,
      },
      {
        label: "Full retirement number",
        value: m(full),
        detail: "Same spending, no part-time pay",
      },
      {
        label: "Part-time pay is worth",
        value: m(saving),
        detail: full > 0 ? `${pct(saving / full, 1)} less needed` : "",
      },
      {
        label: "25× shortcut",
        value: m(shortcut),
        detail: `(${m(p.spend)} − ${m(p.pt)}) × 25, which assumes the pay lasts for ever`,
      },
    ],
    charts: [chart],
    comparison: {
      title: "Formula and engine side by side",
      rows: [
        { label: "Barista FIRE number", formula: m(formulaBarista), engine: m(barista) },
        { label: "Full retirement number", formula: m(formulaFull), engine: m(full) },
      ],
      note:
        p.timing === "end"
          ? "With money moving at the end of each year the engine matches the present-value formula to within the solver’s precision."
          : "The formula is the present value of each year’s withdrawal. The engine needs slightly less: in the final year it pays the last withdrawal from the year’s grown balance even though, under this timing, the withdrawal should have missed part of that growth. The difference is at most one year’s growth on the last withdrawal, discounted to today.",
    },
    method: [
      `Engine: solveRequiredPortfolio() with objective “every year fully funded” on a plan from ${p.age} to ${planTo}: spending ${m(p.spend)} a year, part-time pay ${m(p.pt)} a year until ${ptEnd} (after tax), growth ${pctInput(p.r * 100)} a year after inflation. The solver scales the starting balance until the plan is just funded.`,
      "All amounts are in today’s money (inflation is set to 0 inside the projection).",
      timingText(p.timing),
      taxText(p.tax),
    ],
    warnings:
      p.pt >= p.spend && p.pt > 0
        ? [
            "Part-time pay covers all of your spending while it lasts; the surplus is saved into the portfolio.",
          ]
        : [],
  };
}
