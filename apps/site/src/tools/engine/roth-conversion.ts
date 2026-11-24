/**
 * Roth conversion calculator: how much to convert this year to fill up to the top of a chosen federal
 * bracket, the federal tax on that conversion, and a multi-year ladder against no conversions.
 *
 * Engine use:
 *  - This year: the engine's US federal plug-in through core's `incomeHeadroom` (target
 *    { kind: 'bracket' }, the same search the planner's tax strategy uses), `incrementalTax` and
 *    `marginalProgression`. Social Security, the deductions and the capital gains stacking all move
 *    with the conversion, because every step re-runs the plug-in.
 *  - Ladder: `simulate` twice on a US household with `tax.mode: 'estimate'` (federal only): once with
 *    the plan's tax strategy converting up to the bracket for the chosen number of years, once
 *    without. The engine pays spending and tax from taxable savings first, takes required minimum
 *    distributions and charges tax every year. Everything is in today's money (inflation 0), so the
 *    year's published thresholds stay at their real value.
 */
import {
  type FilingStatus,
  type ProjectionResult,
  SimulationInput,
  type SimulationInputInput,
  simulate,
  US_FIXED,
  usRmdStartAge,
} from "@glideworth/core";
import { money, pct } from "../format";
import { num, rate, str } from "../state";
import type { ChartSpec, Values, ViewModel } from "../types";
import { flows } from "./common";
import {
  analyse,
  bracketHeadroom,
  bracketRates,
  extraTax,
  FILING_LABELS,
  progression,
  ratePct,
  SPOUSE,
  sourceNotes,
  usTaxInput,
  YOU,
} from "./us-tax";

const m = (x: number) => money(x, "USD");

export interface RothInputs {
  year: number;
  status: FilingStatus;
  target: number;
  age: number;
  age2: number;
  joint: boolean;
  ss: number;
  ssAge: number;
  inc: number;
  qd: number;
  trad: number;
  taxable: number;
  rbal: number;
  spend: number;
  years: number;
  ret: number;
  planTo: number;
  heir: number;
}

export function readRoth(v: Values): RothInputs {
  const status = str(v, "status") as FilingStatus;
  return {
    year: Number(str(v, "year")),
    status,
    target: Number(str(v, "target")) / 100,
    age: num(v, "age"),
    age2: num(v, "age2"),
    joint: status === "married-joint",
    ss: num(v, "ss"),
    ssAge: num(v, "ssAge"),
    inc: num(v, "inc"),
    qd: num(v, "qd"),
    trad: num(v, "trad"),
    taxable: num(v, "taxable"),
    rbal: num(v, "rbal"),
    spend: num(v, "spend"),
    years: num(v, "years"),
    ret: rate(v, "ret"),
    planTo: num(v, "planTo"),
    heir: rate(v, "heir"),
  };
}

/** This year's income before any conversion, for the federal plug-in. */
export function baseYear(i: RothInputs) {
  return usTaxInput({
    year: i.year,
    status: i.status,
    ages: i.joint ? [i.age, i.age2] : [i.age],
    income: [
      { id: "social-security", character: "social-security", amount: i.age >= i.ssAge ? i.ss : 0 },
      { id: "income", character: "ordinary", amount: i.inc },
      { id: "qualified", character: "qualified-dividend", amount: i.qd },
    ],
  });
}

/** The conversion that fills up to the top of `rate` this year, and its federal tax. */
export function fillTo(i: RothInputs, rateTarget = i.target, cap = Number.POSITIVE_INFINITY) {
  const input = baseYear(i);
  const room = bracketHeadroom(input, rateTarget);
  const amount = Math.min(room, cap);
  const tax = extraTax(input, amount);
  return { input, room, amount, tax, average: amount > 0 ? tax / amount : 0 };
}

// --------------------------------------------------------------------------------------- the ladder

const TRAD = "trad";
const ROTH = "roth";
const TAXABLE = "taxable";

export function ladderInput(i: RothInputs, convert: boolean): SimulationInput {
  const start = `${i.year}-01`;
  const months = (years: number) => Math.max(0, Math.round(years * 12));
  const input: SimulationInputInput = {
    household: {
      id: "roth-calculator",
      name: "Roth conversion calculator",
      planningMode: i.joint ? "couple" : "individual",
      people: [
        { id: YOU, name: "You", role: "primary", birthMonth: `${i.year - i.age}-01` },
        ...(i.joint
          ? [
              {
                id: SPOUSE,
                name: "Spouse",
                role: "partner" as const,
                birthMonth: `${i.year - i.age2}-01`,
              },
            ]
          : []),
      ],
      location: { country: "US" },
      currency: "USD",
      locale: "en-US",
    },
    finances: {
      asOf: start,
      accounts: [
        { id: TRAD, name: "Traditional IRA", type: "traditional-ira", owner: YOU, balance: i.trad },
        { id: ROTH, name: "Roth IRA", type: "roth-ira", owner: YOU, balance: i.rbal },
        {
          id: TAXABLE,
          name: "Taxable savings",
          type: "taxable",
          owner: YOU,
          balance: i.taxable,
          costBasis: i.taxable,
        },
      ],
    },
    plan: {
      id: "roth-calculator-plan",
      householdId: "roth-calculator",
      name: convert ? "Convert" : "No conversions",
      tax: {
        mode: "estimate",
        filingStatus: i.status,
        jurisdictions: ["us-federal"],
        lawToggles: { "us.irmaa": false },
      },
      income: [
        ...(i.ss > 0
          ? [
              {
                id: "social-security",
                type: "social-security" as const,
                name: "Social Security",
                owner: YOU,
                amount: { value: i.ss, basis: "real" as const },
                frequency: "yearly" as const,
                range: {
                  start: { kind: "planStart" as const, offsetMonths: months(i.ssAge - i.age) },
                  end: { kind: "planEnd" as const },
                },
              },
            ]
          : []),
        ...(i.inc > 0
          ? [
              {
                id: "income",
                type: "other" as const,
                name: "Pensions and other income",
                owner: YOU,
                amount: { value: i.inc, basis: "real" as const },
                frequency: "yearly" as const,
                tax: { character: "ordinary" as const },
                range: { start: { kind: "planStart" as const }, end: { kind: "planEnd" as const } },
              },
            ]
          : []),
        ...(i.qd > 0
          ? [
              {
                id: "qualified",
                type: "other" as const,
                name: "Qualified dividends and gains",
                owner: YOU,
                amount: { value: i.qd, basis: "real" as const },
                frequency: "yearly" as const,
                tax: { character: "qualified-dividend" as const },
                range: { start: { kind: "planStart" as const }, end: { kind: "planEnd" as const } },
              },
            ]
          : []),
      ],
      expenses:
        i.spend > 0
          ? [
              {
                id: "spending",
                type: "living",
                name: "Spending",
                owner: YOU,
                amount: { value: i.spend, basis: "real" },
                frequency: "yearly",
                range: { start: { kind: "planStart" }, end: { kind: "planEnd" } },
              },
            ]
          : [],
      ...(convert
        ? {
            taxStrategy: {
              enabled: true,
              range: {
                start: { kind: "planStart" as const },
                end: { kind: "planStart" as const, offsetMonths: months(i.years) },
              },
              target: { kind: "bracket" as const, rate: i.target },
              modules: { rothConversions: true, withdrawalShielding: false, gainHarvesting: false },
              conversionSourceAccountIds: [TRAD],
              conversionDestinationAccountId: ROTH,
            },
          }
        : {}),
      assumptions: {
        inflation: { kind: "fixed", rate: 0 },
        stockReturn: { kind: "fixed", rate: i.ret },
        dividendYield: { kind: "fixed", rate: 0 },
        bondReturn: { kind: "fixed", rate: 0 },
        bondYield: { kind: "fixed", rate: 0 },
        cashReturn: { kind: "fixed", rate: 0 },
        bondAllocation: { kind: "none" },
        cashFlowTiming: "mid",
        end: { kind: "ref", ref: { kind: "date", date: `${i.year + (i.planTo - i.age)}-01` } },
      },
    },
    options: { trace: "off" },
  };
  return SimulationInput.parse(input);
}

export interface LadderPath {
  ages: number[];
  converted: number[];
  tax: number[];
  rmd: number[];
  trad: number[];
  roth: number[];
  taxable: number[];
  /** Roth + taxable + traditional × (1 − heir rate), at each year end. */
  afterTax: number[];
  totalConverted: number;
  lifetimeTax: number;
  totalRmd: number;
  endAfterTax: number;
  shortfallYear: number | null;
}

function path(r: ProjectionResult, i: RothInputs): LadderPath {
  const acct = (id: string) => r.periods.map((p) => p.accounts.find((a) => a.accountId === id));
  const trad = acct(TRAD);
  const close = (xs: ReturnType<typeof acct>) => xs.map((a) => a?.closing ?? 0);
  const t = close(trad);
  const ro = close(acct(ROTH));
  const tx = close(acct(TAXABLE));
  const converted = trad.map((a) => a?.transfersOut ?? 0);
  const rmd = trad.map((a) => a?.requiredDistribution ?? 0);
  const tax = flows(r, "taxes");
  const afterTax = t.map((v, k) => ro[k]! + tx[k]! + v * (1 - i.heir));
  const short = r.periods.findIndex((p) => p.totals.shortfall > 1e-6);
  return {
    ages: r.periods.map((_, k) => i.age + k),
    converted,
    tax,
    rmd,
    trad: t,
    roth: ro,
    taxable: tx,
    afterTax,
    totalConverted: converted.reduce((s, x) => s + x, 0),
    lifetimeTax: tax.reduce((s, x) => s + x, 0),
    totalRmd: rmd.reduce((s, x) => s + x, 0),
    endAfterTax: afterTax[afterTax.length - 1] ?? i.trad * (1 - i.heir) + i.rbal + i.taxable,
    shortfallYear: short < 0 ? null : i.age + short,
  };
}

export function ladder(i: RothInputs): { none: LadderPath; convert: LadderPath } {
  return {
    none: path(simulate(ladderInput(i, false)), i),
    convert: path(simulate(ladderInput(i, true)), i),
  };
}

// --------------------------------------------------------------------------------------- the view

/** A round step for the rate chart: about 40 points up to `upTo`. */
function stepFor(upTo: number): number {
  const raw = upTo / 40;
  const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  for (const k of [1, 2, 2.5, 5, 10]) if (k * p >= raw) return k * p;
  return 10 * p;
}

export async function runRothConversion(v: Values): Promise<ViewModel> {
  const i = readRoth(v);
  const status = FILING_LABELS[i.status];
  const fill = fillTo(i, i.target, i.trad > 0 ? i.trad : Number.POSITIVE_INFINITY);
  const before = analyse(fill.input);
  const capped = i.trad > 0 && fill.room > i.trad;

  // What filling each bracket would cost this year (the year's table for the filing status).
  const rates = bracketRates(i.year, i.status).slice(0, -1);
  const byBracket = rates.map((r) => {
    const f = fillTo(i, r);
    return { rate: r, room: f.room, tax: f.tax, average: f.average };
  });

  const upTo = Math.max(50_000, Math.ceil((Math.max(fill.room, 1) * 1.5) / 10_000) * 10_000);
  const step = stepFor(upTo);
  const steps = progression(fill.input, upTo, step);
  const rateChart: ChartSpec = {
    id: "roth-conversion-rate",
    kind: "line",
    title: `Federal tax rate on each further ${m(step)} converted, ${i.year}`,
    summary: `The rate on the first ${m(step)} converted is ${pct(steps[0]?.marginalRate ?? 0)}. Converting ${m(fill.room)} reaches the top of the ${ratePct(i.target)} bracket; beyond that the rate is ${pct(steps.find((s) => s.extra > fill.room + step)?.marginalRate ?? steps[steps.length - 1]?.marginalRate ?? 0)}.`,
    xLabel: "Amount converted (thousands of dollars)",
    yLabel: "Tax rate on the step",
    yUnit: "percent",
    x: steps.map((s) => s.extra / 1000),
    series: [
      {
        label: `Rate on each further ${m(step)}`,
        values: steps.map((s) => s.marginalRate),
        tone: 1,
        style: "solid",
      },
    ],
    markers:
      fill.room > 0 && fill.room < upTo
        ? [{ x: fill.room / 1000, label: `Top of ${ratePct(i.target)}` }]
        : [],
    currency: "USD",
    table: {
      caption: "Tax rate on each further step converted",
      columns: ["Converted so far", "Rate on the next step"],
      rows: steps.map((s) => [m(s.extra - step), pct(s.marginalRate)]),
    },
  };

  const lad = i.trad > 0 ? ladder(i) : null;
  const charts: ChartSpec[] = [rateChart];
  let ladderFigures: ViewModel["figures"] = [];
  const ladderMethod: string[] = [];
  const warnings: string[] = [];
  if (lad) {
    const { none, convert } = lad;
    const gain = convert.endAfterTax - none.endAfterTax;
    charts.push(
      {
        id: "roth-conversion-tax",
        kind: "line",
        title: "Federal tax each year, with and without the conversions",
        summary: `Converting up to the top of the ${ratePct(i.target)} bracket for ${i.years} ${i.years === 1 ? "year" : "years"} moves ${m(convert.totalConverted)} into the Roth IRA. Federal tax over the whole plan is ${m(convert.lifetimeTax)} with the conversions and ${m(none.lifetimeTax)} without; required minimum distributions total ${m(convert.totalRmd)} and ${m(none.totalRmd)}.`,
        xLabel: "Age",
        yLabel: "Today’s money",
        x: none.ages,
        series: [
          { label: "No conversions", values: none.tax, tone: 2, style: "dashed" },
          { label: "With the conversions", values: convert.tax, tone: 1, style: "solid" },
        ],
        currency: "USD",
        table: {
          caption: "Conversions and federal tax by year (today’s money)",
          columns: [
            "Age",
            "Converted",
            "Tax with conversions",
            "Tax without",
            "Required distribution without",
          ],
          rows: none.ages.map((a, k) => [
            String(a),
            m(convert.converted[k] ?? 0),
            m(convert.tax[k] ?? 0),
            m(none.tax[k] ?? 0),
            m(none.rmd[k] ?? 0),
          ]),
        },
      },
      {
        id: "roth-conversion-value",
        kind: "line",
        title: "Savings after tax at the end of each year",
        summary: `Counting traditional balances at ${pct(1 - i.heir, 0)} of their value (after the ${pct(i.heir, 0)} tax rate you set), savings at age ${i.planTo} are ${m(convert.endAfterTax)} with the conversions and ${m(none.endAfterTax)} without, a difference of ${m(gain)}.`,
        xLabel: "Age",
        yLabel: "Today’s money",
        x: none.ages,
        series: [
          { label: "No conversions", values: none.afterTax, tone: 2, style: "dashed" },
          { label: "With the conversions", values: convert.afterTax, tone: 1, style: "solid" },
        ],
        currency: "USD",
        table: {
          caption: "Balances at the end of each year (today’s money)",
          columns: [
            "Age",
            "Traditional with",
            "Roth with",
            "Taxable with",
            "Traditional without",
            "Roth without",
            "Taxable without",
          ],
          rows: none.ages.map((a, k) => [
            String(a),
            m(convert.trad[k] ?? 0),
            m(convert.roth[k] ?? 0),
            m(convert.taxable[k] ?? 0),
            m(none.trad[k] ?? 0),
            m(none.roth[k] ?? 0),
            m(none.taxable[k] ?? 0),
          ]),
        },
      },
    );
    ladderFigures = [
      {
        label: `Converted over ${i.years} ${i.years === 1 ? "year" : "years"}`,
        value: m(convert.totalConverted),
        detail: "Today’s money, by the engine",
      },
      {
        label: `After-tax savings at ${i.planTo}`,
        value: gain >= 0 ? `+${m(gain)}` : `−${m(-gain)}`,
        detail: `With conversions ${m(convert.endAfterTax)}, without ${m(none.endAfterTax)}`,
      },
    ];
    ladderMethod.push(
      `Multi-year comparison: the engine’s simulate() run twice to age ${i.planTo}, federal tax estimated every year, once with its tax strategy converting from the traditional IRA to the Roth IRA up to the top of the ${ratePct(i.target)} bracket for ${i.years} ${i.years === 1 ? "year" : "years"} and once without. Spending is paid from taxable savings first; the tax on conversions is paid the same way. Required minimum distributions start at age ${usRmdStartAge(i.year - i.age)} for your birth year, from the engine’s rules.`,
      `Steady ${pct(i.ret)} a year after inflation, inflation 0: everything is in today’s money and the year’s published thresholds keep their real value. Social Security of ${m(i.ss)} a year from age ${i.ssAge}, the same in both runs. Traditional balances left at the end are counted at ${pct(1 - i.heir, 0)} of their value.`,
    );
    for (const [name, p] of [
      ["without conversions", none],
      ["with the conversions", convert],
    ] as const)
      if (p.shortfallYear !== null)
        warnings.push(
          `The savings run out ${name} at about age ${p.shortfallYear}, so later years in that run are not fully paid.`,
        );
  }

  const already = fill.room <= 0;
  const headline = already
    ? `This year’s income already reaches past the top of the ${ratePct(i.target)} bracket, so any conversion would be taxed at a higher rate.`
    : `Converting ${m(fill.amount)} in ${i.year} ${capped ? "(your whole traditional balance) stays within" : "fills up to the top of"} the ${ratePct(i.target)} bracket. Estimated federal tax on the conversion is ${m(fill.tax)}, ${pct(fill.average)} of the amount converted.`;

  return {
    tool: "roth-conversion",
    headline,
    announce: already
      ? "No room left in that bracket this year."
      : `Convert ${m(fill.amount)}; federal tax ${m(fill.tax)}.`,
    figures: [
      {
        label: `Conversion to fill ${ratePct(i.target)}`,
        value: m(fill.amount),
        detail: capped
          ? `Room for ${m(fill.room)}; your balance is smaller`
          : `${status}, ${i.year}`,
      },
      {
        label: "Federal tax on the conversion",
        value: m(fill.tax),
        detail: `${pct(fill.average)} of the amount converted`,
      },
      {
        label: "Tax this year before converting",
        value: m(before.total),
        detail: `Taxable income ${m(before.facts["us.taxableIncome"] ?? 0)}`,
      },
      ...ladderFigures,
    ],
    table: {
      caption: `Converting up to the top of each bracket in ${i.year}`,
      columns: ["Up to the top of", "Conversion", "Federal tax on it", "Average rate"],
      rows: byBracket.map((b) => [
        ratePct(b.rate),
        m(b.room),
        m(b.tax),
        b.room > 0 ? pct(b.average) : "–",
      ]),
    },
    charts,
    method: [
      `This year: the engine’s US federal tax model (usFederalJurisdiction) for ${i.year}, filing ${status.toLowerCase()}. The conversion is found by core’s incomeHeadroom search, adding ordinary income until the next dollar would fall in a higher ordinary bracket; its tax is the difference between the federal tax with and without it, so taxable Social Security, the senior deduction’s phase-out and the capital gains bands all move with it.`,
      `Figures from: ${sourceNotes(i.year).join("; ")}.`,
      ...ladderMethod,
      `Federal income tax only: no state tax, no Medicare premium surcharges (IRMAA), no ACA credit. Conversions are taxed as ordinary income; the ${US_FIXED.rothFiveYearRule}-year rules on Roth withdrawals are not checked.`,
    ],
    warnings,
  };
}
