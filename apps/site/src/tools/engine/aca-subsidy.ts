/**
 * ACA premium tax credit calculator for early retirees: household size, MAGI and the benchmark silver
 * premium for a coverage year give the poverty-line percentage, the applicable percentage, the
 * expected contribution and the credit, and how much more MAGI the household can have before the
 * credit ends.
 *
 * Engine use: the credit is the engine's US federal plug-in (`usFederalJurisdiction`, fact 'us.ptc')
 * on a year whose ACA MAGI is the amount entered, with the benchmark premium and household size the
 * planner's ACA expense would pass. The poverty line and the applicable percentage shown next to it
 * are core's `federalPovertyLine` and `acaApplicablePercentage` on the year's `US_ACA_YEARS` row
 * (Rev. Proc. 2025-25 / 2026-26 and the HHS poverty guidelines). The enhanced (ARPA/IRA) schedule is
 * not offered: it is a law toggle in core without a current source.
 */
import { acaApplicablePercentage, federalPovertyLine } from "@glideworth/core";
import { money, pct } from "../format";
import { num, str } from "../state";
import type { ChartSpec, Values, ViewModel } from "../types";
import { acaYear, federalFacts, usTaxInput } from "./us-tax";

const m = (x: number) => money(x, "USD");

export interface AcaInputs {
  year: number;
  size: number;
  magi: number;
  /** Yearly benchmark premium (the monthly input × 12). */
  bench: number;
  /** Yearly premium of the chosen plan. */
  plan: number;
}

export function readAca(v: Values): AcaInputs {
  return {
    year: Number(str(v, "year")),
    size: num(v, "size"),
    magi: num(v, "magi"),
    bench: num(v, "bench") * 12,
    plan: num(v, "plan") * 12,
  };
}

/** Credit for a year, from the federal plug-in. */
export function creditAt(i: AcaInputs, magi: number): number {
  if (i.bench <= 0) return 0;
  const facts = federalFacts(
    usTaxInput({
      year: i.year,
      status: "single",
      ages: [60],
      // ACA MAGI = AGI here: the amount is entered as ordinary income with no Social Security.
      income: [{ id: "magi", character: "ordinary", amount: magi }],
      aca: { benchmarkPremium: i.bench, householdSize: i.size },
    }),
  );
  return facts["us.ptc"] ?? 0;
}

export function acaNumbers(i: AcaInputs) {
  const row = acaYear(i.year);
  const fpl = federalPovertyLine(i.size, 1, row);
  const multiple = fpl > 0 ? i.magi / fpl : 0;
  const applicable = acaApplicablePercentage(multiple, false, row);
  const contribution = applicable === null ? null : applicable * i.magi;
  const credit = creditAt(i, i.magi);

  // Highest MAGI with any credit (bisection on the plug-in; the credit never rises with income).
  const top = Math.max(i.magi, fpl) + fpl * 10;
  let endMagi: number | null = null;
  const from = Math.max(i.magi, fpl);
  if (creditAt(i, from) > 0) {
    let lo = from;
    let hi = top;
    while (hi - lo > 0.5) {
      const mid = (lo + hi) / 2;
      if (creditAt(i, mid) > 0) lo = mid;
      else hi = mid;
    }
    endMagi = lo;
  }
  const creditAtEnd = endMagi === null ? 0 : creditAt(i, endMagi);
  // A cliff: the credit drops by more than a dollar at the last dollar of income that keeps it.
  const cliff = endMagi !== null && creditAtEnd > 1;
  const per1000 = credit > 0 ? credit - creditAt(i, i.magi + 1_000) : 0;
  return {
    row,
    fpl,
    multiple,
    applicable,
    contribution,
    credit,
    endMagi,
    creditAtEnd,
    cliff,
    headroom: endMagi === null ? null : Math.max(0, endMagi - i.magi),
    per1000,
    benchNet: Math.max(0, i.bench - credit),
    planNet: Math.max(0, i.plan - credit),
  };
}

export async function runAcaSubsidy(v: Values): Promise<ViewModel> {
  const i = readAca(v);
  const r = acaNumbers(i);
  const floorPct = Math.round(r.row.floor * 100);
  const cliffPct = Math.round(r.row.cliff * 100);

  // Credit and the household's share of the benchmark plan across incomes.
  const xMax = Math.max(i.magi * 1.2, r.fpl * (r.row.cliff + 1));
  const stepK = Math.max(1, Math.ceil(xMax / 1000 / 60));
  const xs: number[] = [];
  for (let k = 0; k <= xMax / 1000 + 1e-9; k += stepK) xs.push(k);
  const credits = xs.map((k) => creditAt(i, k * 1000));
  const chart: ChartSpec = {
    id: "aca-subsidy-chart",
    kind: "line",
    title: `Premium tax credit by household income, ${i.year}`,
    summary:
      i.bench <= 0
        ? "With no benchmark premium entered there is no credit at any income."
        : `For ${i.size} ${i.size === 1 ? "person" : "people"} and a benchmark premium of ${m(i.bench)} a year, the credit starts at ${m(r.fpl * r.row.floor)} (${floorPct}% of the poverty line)${r.endMagi !== null ? ` and ends above ${m(r.endMagi)}${r.cliff ? `, where it drops from ${m(r.creditAtEnd)} to nothing` : ""}` : ""}. At your ${m(i.magi)} it is ${m(r.credit)} a year.`,
    xLabel: "Household MAGI (thousands of dollars)",
    yLabel: "Per year",
    x: xs,
    series: [
      { label: "Premium tax credit", values: credits, tone: 1, style: "solid" },
      {
        label: "What you pay for the benchmark plan",
        values: credits.map((c) => Math.max(0, i.bench - c)),
        tone: 2,
        style: "dashed",
      },
    ],
    markers: [
      { x: i.magi / 1000, label: "Your income" },
      ...(r.cliff && r.endMagi !== null
        ? [{ x: r.endMagi / 1000, label: `${cliffPct}% of poverty line` }]
        : []),
    ],
    currency: "USD",
    table: {
      caption: "Credit and your share of the benchmark plan by income",
      columns: ["MAGI", "Credit per year", "You pay for the benchmark"],
      rows: xs.map((k, j) => [m(k * 1000), m(credits[j]!), m(Math.max(0, i.bench - credits[j]!))]),
    },
  };

  // The schedule's own breakpoints for this household.
  const multiples = [
    r.row.floor,
    ...r.row.applicable.map(([lo]) => lo).filter((x) => x > r.row.floor),
    r.row.cliff,
  ];
  const table = {
    caption: `The ${i.year} schedule for ${i.size} ${i.size === 1 ? "person" : "people"}`,
    columns: [
      "Share of poverty line",
      "MAGI",
      "Applicable percentage",
      "Expected contribution",
      "Credit",
    ],
    rows: multiples.map((mult) => {
      const magi = mult * r.fpl;
      const p = acaApplicablePercentage(mult, false, r.row);
      return [
        `${Math.round(mult * 100)}%`,
        m(magi),
        p === null ? "–" : pct(p, 2),
        p === null ? "–" : m(p * magi),
        m(creditAt(i, magi)),
      ];
    }),
  };

  const warnings: string[] = [];
  if (r.multiple < r.row.floor)
    warnings.push(
      `Your income is below ${floorPct}% of the poverty line, where the model allows no credit. Medicaid eligibility is not modelled.`,
    );

  const headline =
    i.bench <= 0
      ? "Enter the benchmark silver premium to estimate the credit."
      : r.credit <= 0
        ? r.multiple < r.row.floor
          ? `At ${pct(r.multiple, 0)} of the poverty line, below ${floorPct}%, the estimate is no premium tax credit.`
          : `At ${pct(r.multiple, 0)} of the poverty line the estimate is no premium tax credit: ${r.applicable === null ? `above ${cliffPct}% none is allowed` : "your expected contribution is more than the benchmark premium"}.`
        : `Estimated premium tax credit: ${m(r.credit)} a year (${m(r.credit / 12)} a month). Your income is ${pct(r.multiple, 0)} of the poverty line${r.headroom !== null ? `, and the credit ${r.cliff ? "stops completely" : "runs out"} if MAGI rises by more than ${m(r.headroom)}` : ""}.`;

  return {
    tool: "aca-subsidy",
    headline,
    announce: `Premium tax credit ${m(r.credit)} a year.`,
    figures: [
      {
        label: "Premium tax credit",
        value: `${m(r.credit / 12)} a month`,
        detail: `${m(r.credit)} a year`,
      },
      {
        label: "Income as share of poverty line",
        value: pct(r.multiple, 0),
        detail: `Poverty line ${m(r.fpl)} for ${i.size}`,
      },
      {
        label: "Applicable percentage",
        value: r.applicable === null ? "None" : pct(r.applicable, 2),
        detail:
          r.contribution === null
            ? "No credit at this income"
            : `Expected contribution ${m(r.contribution)} a year`,
      },
      {
        label: "Your plan after the credit",
        value: `${m(r.planNet / 12)} a month`,
        detail: `Benchmark plan: ${m(r.benchNet / 12)} a month`,
      },
      {
        label: "Income headroom",
        value: r.headroom === null ? "–" : m(r.headroom),
        detail:
          r.headroom === null
            ? "No credit to lose"
            : r.cliff
              ? `Then the credit drops from ${m(r.creditAtEnd)} to $0`
              : `Each extra $1,000 now costs ${m(r.per1000)} of credit`,
      },
    ],
    table,
    charts: [chart],
    method: [
      `The engine’s US federal tax model (usFederalJurisdiction) for coverage year ${i.year}: credit = benchmark premium − applicable percentage × MAGI, never below zero, with no credit below ${floorPct}% or above ${cliffPct}% of the poverty line (core’s US_ACA_YEARS).`,
      `Sources: ${r.row.sources.map((s) => s.note ?? s.url).join("; ")}.`,
      "Monthly premiums are multiplied by 12 for a full year of coverage. The credit is the year’s figure on your tax return; advance payments and their reconciliation are not modelled here.",
    ],
    warnings,
  };
}
