/**
 * 72(t) calculator: the yearly payment under the fixed annuitisation method of IRS Notice 2022-6, and
 * what the fixed payment does to the balance over the years you take it.
 *
 * The only rule used is core's `seppAnnuityFactor` (Notice 2022-6 §2.01(c), with the mortality rates
 * of 26 CFR 1.401(a)(9)-9(e) in `IRS_MORTALITY_RATES`): payment = balance ÷ annuity factor at the age
 * reached in the first payment year and the visitor's interest rate. The interest-rate limit and the
 * minimum length of the payments are not in Glideworth's data, so they are the visitor's inputs. The
 * required minimum distribution and fixed amortisation methods divide by a life expectancy at the
 * visitor's age; Glideworth's official Uniform Lifetime table starts at 70, so they are left out.
 *
 * The balance projection is plain arithmetic: each year the payment is taken at the start of the year
 * (the factor's first payment is immediate), then the rest grows at the growth rate.
 */
import { seppAnnuityFactor } from "@glideworth/core";
import { money, pctInput } from "../format";
import { num, rate } from "../state";
import type { ChartSpec, Values, ViewModel } from "../types";

const CUR = "USD";

export function annuityFactor(age: number, interest: number): number {
  return seppAnnuityFactor(age, interest);
}

/** Yearly payment under fixed annuitisation. */
export function seppPayment(balance: number, age: number, interest: number): number {
  if (!(balance > 0)) return 0;
  return balance / seppAnnuityFactor(age, interest);
}

export interface SeppYear {
  /** Year of payments, 1-based. */
  n: number;
  age: number;
  paid: number;
  /** Balance at the end of the year, after the payment and growth. */
  closing: number;
}

/** Balance over the payment years: payment at the start of each year, then growth on the rest. */
export function seppPath(
  balance: number,
  payment: number,
  years: number,
  growth: number,
  age: number,
): SeppYear[] {
  let b = Math.max(0, balance);
  const out: SeppYear[] = [];
  for (let i = 0; i < years; i++) {
    const paid = Math.min(payment, b);
    b = Math.max(0, (b - paid) * (1 + growth));
    out.push({ n: i + 1, age: age + i, paid, closing: b });
  }
  return out;
}

/** Interest rates for the comparison table: yours and up to four lower ones, half a point apart. */
export function comparisonRates(interestPercent: number): number[] {
  const out: number[] = [];
  for (let d = 2; d >= 0; d -= 0.5) {
    const x = Number((interestPercent - d).toFixed(2));
    if (x >= 0) out.push(x);
  }
  return out;
}

export async function runSepp(v: Values): Promise<ViewModel> {
  const balance = num(v, "balance");
  const age = num(v, "age");
  const i = rate(v, "interest");
  const years = num(v, "years");
  const g = rate(v, "growth");
  const m = (x: number) => money(x, CUR);

  const factor = annuityFactor(age, i);
  const payment = seppPayment(balance, age, i);
  const path = seppPath(balance, payment, years, g, age);
  const end = path[path.length - 1]!;
  const paidTotal = path.reduce((s, y) => s + y.paid, 0);
  const shortYear = path.find((y) => y.paid < payment - 1e-6);

  const headline =
    balance <= 0
      ? "With no balance there is no payment."
      : `At ${pctInput(i * 100)} interest and age ${age}, the fixed annuitisation method gives ${m(payment)} a year (${m(payment / 12)} a month) from ${m(balance)}: the balance divided by an annuity factor of ${factor.toFixed(4)}.`;

  const rates = comparisonRates(num(v, "interest"));
  const ageRows = [-5, 0, 5, 10]
    .map((d) => age + d)
    .filter((a) => a >= 18 && a <= 90)
    .map((a) => [
      String(a),
      annuityFactor(a, i).toFixed(4),
      m(seppPayment(balance, a, i)),
      m(seppPayment(balance, a, i) / 12),
    ]);

  const chart: ChartSpec = {
    id: "sepp-balance",
    kind: "line",
    title: "Account balance while you take the payments",
    summary:
      balance > 0
        ? `Taking ${m(payment)} a year for ${years} years with ${pctInput(g * 100)} growth, the balance goes from ${m(balance)} to ${m(end.closing)}${shortYear ? `; it runs out in year ${shortYear.n}` : ""}.`
        : "There is no balance to show.",
    xLabel: "Age",
    yLabel: "Dollars",
    x: [age, ...path.map((y) => y.age + 1)],
    series: [
      {
        label: `Balance after ${m(payment)} a year`,
        values: [balance, ...path.map((y) => y.closing)],
        tone: 1,
        style: "solid",
      },
    ],
    currency: CUR,
    table: {
      caption: "Payment and balance for each year of payments",
      columns: ["Year", "Age", "Payment", "Balance at end"],
      rows: path.map((y) => [String(y.n), String(y.age), m(y.paid), m(y.closing)]),
    },
  };

  return {
    tool: "sepp-72t",
    headline,
    announce: `Yearly payment: ${m(payment)}.`,
    figures: [
      { label: "Yearly payment", value: m(payment), detail: `${m(payment / 12)} a month` },
      {
        label: "Annuity factor",
        value: factor.toFixed(4),
        detail: `Age ${age}, ${pctInput(i * 100)} interest`,
      },
      {
        label: `Paid over ${years} ${years === 1 ? "year" : "years"}`,
        value: m(paidTotal),
        detail: "The same number of dollars every year",
      },
      {
        label: "Balance at the end",
        value: m(end.closing),
        detail: `At ${pctInput(g * 100)} growth a year`,
      },
    ],
    charts: [chart],
    extraTables: [
      {
        caption: "The same balance at lower interest rates",
        columns: ["Interest rate", "Annuity factor", "Yearly payment", "Monthly payment"],
        rows: rates.map((x) => [
          pctInput(x),
          annuityFactor(age, x / 100).toFixed(4),
          m(seppPayment(balance, age, x / 100)),
          m(seppPayment(balance, age, x / 100) / 12),
        ]),
      },
      {
        caption: `Starting at other ages (${pctInput(i * 100)} interest)`,
        columns: ["Age in first year", "Annuity factor", "Yearly payment", "Monthly payment"],
        rows: ageRows,
      },
    ],
    method: [
      "Annuity factor: seppAnnuityFactor() from Glideworth’s US data, the present value of 1 a year for life with the first payment now, from the mortality rates in 26 CFR 1.401(a)(9)-9(e), which IRS Notice 2022-6 names for this method, at the interest rate you entered.",
      "Payment = balance ÷ annuity factor, worked out once and then the same number of dollars every year.",
      `Balance: each year’s payment comes out at the start of the year, then the rest grows ${pctInput(g * 100)}. Growth is before inflation because the payment does not rise with prices.`,
      "Not checked: the interest-rate limit, the minimum length of the payments, and whether your account and your dates qualify. No tax is worked out.",
    ],
    warnings: shortYear
      ? [
          `At ${pctInput(g * 100)} growth the account cannot pay the full amount in year ${shortYear.n} (age ${shortYear.age}).`,
        ]
      : [],
  };
}
