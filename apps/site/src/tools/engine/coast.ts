/**
 * Coast FIRE: the amount invested today that growth alone carries to the FIRE number by retirement,
 * and the age you reach it if you keep saving.
 *
 * Engine use: `simulate` on one invested account at the visitor's real return (inflation 0).
 *  - The growth factor from each age to retirement comes from a run of a 1,000,000 balance with no
 *    flows; coast number at age a = FIRE number x growth(now -> a) / growth(now -> retirement).
 *  - "Keep saving" adds the yearly saving as after-tax income that is saved into the account
 *    (timing per the visitor's choice); the coast age is the first year end at or above that age's
 *    coast number. A second run stops saving at that age, to show it still reaches the target.
 */
import { coastNumber, fireNumber, growthFactor, yearsToCoast } from "../closed-form";
import { money, pct, pctInput, whole } from "../format";
import { num, rate, str } from "../state";
import type { ChartSpec, Timing, Values, ViewModel } from "../types";
import { axis, balances, run } from "./common";
import { buildInput, timingText } from "./model";

const UNIT = 1_000_000;

interface Inputs {
  age: number;
  retire: number;
  balance: number;
  spend: number;
  wr: number;
  r: number;
  save: number;
  timing: Timing;
  cur: string;
}

function read(v: Values): Inputs {
  return {
    age: num(v, "age"),
    retire: num(v, "retire"),
    balance: num(v, "balance"),
    spend: num(v, "spend"),
    wr: rate(v, "wr"),
    r: rate(v, "ret"),
    save: num(v, "save"),
    timing: str(v, "timing") as Timing,
    cur: str(v, "cur"),
  };
}

/** Engine growth factors G[t] from now to t years ahead (G[0] = 1), for t = 0..n. */
export function engineGrowth(
  r: number,
  age: number,
  n: number,
  timing: Timing,
  cur = "USD",
): number[] {
  const res = run(
    buildInput({ currency: cur, age, years: n, balance: UNIT, timing, taxRate: 0, realReturn: r }),
  );
  return [1, ...balances(res).map((b) => b / UNIT)];
}

function path(i: Inputs, saveYears: number | null): number[] {
  const n = i.retire - i.age;
  const res = run(
    buildInput({
      currency: i.cur,
      age: i.age,
      years: n,
      balance: i.balance,
      timing: i.timing,
      taxRate: 0,
      realReturn: i.r,
      income:
        i.save > 0 && saveYears !== 0
          ? [{ id: "saving", name: "Yearly saving", amount: i.save, from: 0, to: saveYears }]
          : [],
    }),
  );
  return [i.balance, ...balances(res)];
}

export interface CoastNumbers {
  target: number;
  n: number;
  growth: number;
  coastToday: number;
  formulaCoast: number;
  /** Years from now to the coast age (whole years, engine), or null when not reached by retirement. */
  coastYears: number | null;
  formulaCoastYears: number;
  atRetirementNoSaving: number;
  atRetirementStopAtCoast: number | null;
}

export function coastNumbers(
  v: Values,
): CoastNumbers & { keep: number[]; stop: number[] | null; none: number[]; coastByAge: number[] } {
  const i = read(v);
  const n = i.retire - i.age;
  const target = fireNumber(i.spend, i.wr);
  const G = engineGrowth(i.r, i.age, n, i.timing, i.cur);
  const Gn = G[n]!;
  const coastByAge = G.map((g) => (target * g) / Gn);
  const none = G.map((g) => i.balance * g);
  const keep = i.save > 0 ? path(i, null) : none;
  let coastYears: number | null = null;
  for (let t = 0; t <= n; t++)
    if (keep[t]! >= coastByAge[t]! - 1e-6) {
      coastYears = t;
      break;
    }
  const stop = coastYears !== null && coastYears > 0 && i.save > 0 ? path(i, coastYears) : null;
  return {
    target,
    n,
    growth: Gn,
    coastToday: coastByAge[0]!,
    formulaCoast: coastNumber(target, i.r, n),
    coastYears,
    formulaCoastYears: yearsToCoast(i.balance, i.save, i.r, target, n, i.timing),
    atRetirementNoSaving: none[n]!,
    atRetirementStopAtCoast: stop ? stop[n]! : null,
    keep,
    stop,
    none,
    coastByAge,
  };
}

export async function runCoast(v: Values): Promise<ViewModel> {
  const i = read(v);
  const c = coastNumbers(v);
  const m = (x: number) => money(x, i.cur);
  const reached = i.balance >= c.coastToday - 1e-6;
  const coastAge = c.coastYears === null ? null : i.age + c.coastYears;
  const gap = c.coastToday - i.balance;

  let headline: string;
  if (c.target <= 0)
    headline =
      "With no spending in retirement your FIRE number is 0, so there is nothing left to save for.";
  else if (reached)
    headline = `You have reached Coast FIRE. ${m(i.balance)} invested today grows to ${m(c.atRetirementNoSaving)} by age ${i.retire} at ${pctInput(i.r * 100)} a year after inflation, which covers your FIRE number of ${m(c.target)}.`;
  else if (i.save > 0 && coastAge !== null)
    headline = `Your Coast FIRE number today is ${m(c.coastToday)}. You have ${m(i.balance)}, so you are ${m(gap)} short. Saving ${m(i.save)} a year, you reach Coast FIRE at age ${coastAge}; from then on, growth alone would carry you to ${m(c.target)} by age ${i.retire}.`;
  else if (i.save > 0)
    headline = `Your Coast FIRE number today is ${m(c.coastToday)}. You have ${m(i.balance)}. Saving ${m(i.save)} a year, you do not reach Coast FIRE before age ${i.retire} at this return.`;
  else
    headline = `Your Coast FIRE number today is ${m(c.coastToday)}. You have ${m(i.balance)}, so you are ${m(gap)} short: with no more saving you would have ${m(c.atRetirementNoSaving)} at ${i.retire}, ${pct(c.atRetirementNoSaving / c.target, 0)} of your FIRE number.`;

  const announce = reached
    ? `Coast FIRE reached. Coast number ${m(c.coastToday)}.`
    : `Coast FIRE number ${m(c.coastToday)}; you are ${m(gap)} short${coastAge !== null && i.save > 0 ? `; coast age ${coastAge}` : ""}.`;

  const ages = axis(i.age, c.n);
  const series: ChartSpec["series"] = [
    { label: "Coast number at each age", values: c.coastByAge, tone: 3, style: "dotted" },
  ];
  if (c.stop)
    series.push({
      label: `Saving ${m(i.save)} a year until age ${coastAge}`,
      values: c.stop,
      tone: 1,
      style: "solid",
    });
  else if (i.save > 0 && !reached)
    series.push({ label: `Saving ${m(i.save)} a year`, values: c.keep, tone: 1, style: "solid" });
  series.push({ label: "No more saving from today", values: c.none, tone: 2, style: "dashed" });

  const tableRows = ages.map((a, t) => [
    String(a),
    m(c.coastByAge[t]!),
    ...(c.stop ? [m(c.stop[t]!)] : []),
    m(c.none[t]!),
  ]);
  const chart: ChartSpec = {
    id: "coast-chart",
    kind: "line",
    title: "Portfolio by age against the coast number",
    summary: reached
      ? `Your balance is above the coast number at every age, and reaches ${m(c.atRetirementNoSaving)} by ${i.retire} with no more saving.`
      : coastAge !== null && c.stop
        ? `The coast number rises from ${m(c.coastToday)} today to ${m(c.target)} at ${i.retire}. Saving ${m(i.save)} a year, your balance crosses it at age ${coastAge}; if you stop saving then, it still reaches ${m(c.atRetirementStopAtCoast ?? 0)} at ${i.retire}.`
        : `The coast number rises from ${m(c.coastToday)} today to ${m(c.target)} at ${i.retire}. With no more saving your balance reaches ${m(c.atRetirementNoSaving)}.`,
    xLabel: "Age",
    yLabel: "Today’s money",
    x: ages,
    series,
    hLines: c.target > 0 ? [{ y: c.target, label: `FIRE number ${m(c.target)}` }] : [],
    markers:
      coastAge !== null && coastAge > i.age ? [{ x: coastAge, label: `Coast at ${coastAge}` }] : [],
    currency: i.cur,
    table: {
      caption: "Coast number and balance at the end of each year of age",
      columns: [
        "Age",
        "Coast number",
        ...(c.stop ? [`Saving until ${coastAge}`] : []),
        "No more saving",
      ],
      rows: tableRows,
    },
  };

  // Sensitivity: the engine's coast number at nearby returns.
  const sens = [-0.02, -0.01, 0, 0.01, 0.02]
    .map((d) => i.r + d)
    .filter((r) => r >= -0.1 && r <= 0.15)
    .map((r) => {
      const G = engineGrowth(r, i.age, c.n, i.timing, i.cur);
      return [pctInput(Number((r * 100).toFixed(2))), m(c.target / G[c.n]!)];
    });

  const figures = [
    {
      label: "FIRE number",
      value: m(c.target),
      detail: `${m(i.spend)} ÷ ${pctInput(i.wr * 100)} (${whole(1 / i.wr)} times spending)`,
    },
    {
      label: `Coast number at ${i.age}`,
      value: m(c.coastToday),
      detail: `What growth alone turns into ${m(c.target)} by ${i.retire}`,
    },
    {
      label: reached ? "Ahead of it by" : "Still to go",
      value: m(Math.abs(gap)),
      detail: `You have ${m(i.balance)}`,
    },
    {
      label: "Coast age",
      value: reached
        ? `${i.age} (now)`
        : coastAge !== null && i.save > 0
          ? String(coastAge)
          : "Not before retirement",
      detail: i.save > 0 ? `Saving ${m(i.save)} a year` : "Enter a yearly saving to find it",
    },
    {
      label: `At ${i.retire} with no more saving`,
      value: m(c.atRetirementNoSaving),
      detail:
        c.target > 0 ? `${pct(c.atRetirementNoSaving / c.target, 0)} of your FIRE number` : "",
    },
  ];

  const fc = c.formulaCoastYears;
  return {
    tool: "coast-fire",
    headline,
    announce,
    figures,
    charts: [chart],
    table: {
      caption: "Coast number today at other returns (engine)",
      columns: ["Return after inflation", "Coast number today"],
      rows: sens,
    },
    comparison: {
      title: "Formula and engine side by side",
      rows: [
        { label: "Coast number today", formula: m(c.formulaCoast), engine: m(c.coastToday) },
        {
          label: "Coast age",
          formula: Number.isFinite(fc) && i.save > 0 ? (i.age + fc).toFixed(1) : "–",
          engine: coastAge !== null && i.save > 0 ? String(coastAge) : "–",
        },
        {
          label: `Value at ${i.retire} with no more saving`,
          formula: m(i.balance * growthFactor(i.r, c.n)),
          engine: m(c.atRetirementNoSaving),
        },
      ],
      note: "The coast number agrees to the unit: with a steady return the engine compounds exactly as the formula does. The coast age differs because the engine checks your balance once a year, at each year end, so it reports the first whole age at or past the crossing; the formula gives the fractional point. Savings follow the timing you chose, as in the formula.",
    },
    method: [
      `Engine: simulate() with one invested account growing ${pctInput(i.r * 100)} a year after inflation (inflation set to 0, so every figure is in today’s money).`,
      `Coast number = FIRE number ÷ the growth the engine projects from age ${i.age} to ${i.retire} (×${c.growth.toFixed(4)}).`,
      timingText(i.timing),
      "No tax, fees or withdrawals before retirement.",
    ],
    warnings:
      i.r <= 0
        ? [
            "With a return of 0% or less after inflation, growth does not help: the coast number is at least your full FIRE number.",
          ]
        : [],
  };
}
