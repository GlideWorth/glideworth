/**
 * UK FIRE calculator with the bridge: ISA (and other non-pension savings) pays your spending from the
 * age you stop work until a private pension can be taken, the pension pays from then, and the State
 * Pension joins it from State Pension age. Answers the FIRE age, whether the ISA can bridge the gap,
 * and how big each pot has to be.
 *
 * Engine use:
 *  - Saving phase: `simulate` of each pot on its own (one generic account, the yearly saving added,
 *    the return after inflation), as the FIRE calculator does. Pension contributions are entered as
 *    the total going in, tax relief and employer payments included.
 *  - Retirement phase: `simulate` of a UK household (`location.country` GB, `tax.mode` 'estimate':
 *    the engine's UK income tax rules) holding a stocks and shares ISA and a SIPP, a living expense and
 *    the new State Pension from State Pension age. The engine applies its pension access rule (the
 *    SIPP cannot be drawn before the normal minimum pension age) and its default drawdown order (the
 *    pension before the ISA once both can be drawn); UK pensions are drawn as UFPLS by default.
 *  - FIRE age: the first whole age at which stopping work leaves no year short to the plan's end.
 *  - Pots needed: bisection over the engine (the ISA alone over the bridge; the pension alone from
 *    the age it can be taken, with the State Pension), to the nearest penny.
 *
 * Everything is in today's money: inflation is 0, so the State Pension is flat in real terms and tax
 * thresholds frozen in cash terms are not eroded (stated on the page).
 */
import {
  type ProjectionResult,
  SimulationInput,
  type SimulationInputInput,
  UK_PENSION_ACCESS,
  UK_TAX_YEARS,
} from "@glideworth/core";
import { balanceAfter, presentValue } from "../closed-form";
import { money, pctInput } from "../format";
import { num, rate, str } from "../state";
import type { ChartSpec, Table, Timing, Values, ViewModel } from "../types";
import { balances, run } from "./common";
import { buildInput, PERSON_ID, START_YEAR, timingText } from "./model";
import { ageText, MONTHS, ukAges } from "./uk-pension-age";

export const CURRENCY = "GBP";

/** The engine's UK tax year that starts in the calculators' reference year (2026/27). */
export const UK_YEAR = UK_TAX_YEARS.find((y) => y.startYear === START_YEAR) ?? UK_TAX_YEARS[0]!;
/** Weeks in a year used to turn the weekly State Pension into a yearly amount. */
export const WEEKS_PER_YEAR = 52;
/** Full new State Pension a year in today's money: the weekly rate × 52. */
export const FULL_STATE_PENSION = UK_YEAR.statePension.fullNewWeekly * WEEKS_PER_YEAR;

const ISA_ID = "isa";
const PENSION_ID = "pension";

/** Age at the start of the reference year when born in January of `START_YEAR - age`. */
export function birthYearOf(age: number): number {
  return START_YEAR - age;
}

/** One pot growing at the return with a yearly saving: balances at each age from `age`. */
function potPath(
  balance: number,
  save: number,
  r: number,
  timing: Timing,
  age: number,
  years: number,
): number[] {
  if (years <= 0) return [balance];
  const res = run(
    buildInput({
      currency: CURRENCY,
      age,
      years,
      balance,
      timing,
      taxRate: 0,
      realReturn: r,
      income: [{ id: "saving", name: "Yearly saving", amount: save, from: 0, to: null }],
    }),
  );
  return [balance, ...balances(res)];
}

export interface RetirementOptions {
  birthYear: number;
  /** Age at which the run starts (stopping work). */
  startAge: number;
  /** Age at which the run ends (exclusive: the plan pays up to this birthday). */
  endAge: number;
  isa: number;
  pension: number;
  spend: number;
  statePension: number;
  statePensionAge: number;
  realReturn: number;
  timing: Timing;
  region: string;
}

export interface RetirementRun {
  result: ProjectionResult;
  /** Ages at the start of each year of the run. */
  ages: number[];
  /** Closing balances by year. */
  isa: number[];
  pension: number[];
  isaDrawn: number[];
  pensionDrawn: number[];
  statePension: number[];
  tax: number[];
  /** Age in the first year with spending unpaid, or null. */
  firstShortAge: number | null;
}

/** A UK household from `startAge` to `endAge`: ISA, SIPP, State Pension, UK income tax estimate. */
export function buildRetirementInput(o: RetirementOptions): SimulationInput {
  const start = o.birthYear + o.startAge;
  const input: SimulationInputInput = {
    household: {
      id: "calculator",
      name: "Calculator",
      planningMode: "individual",
      people: [{ id: PERSON_ID, name: "You", role: "primary", birthMonth: `${o.birthYear}-01` }],
      location: { country: "GB", region: o.region },
      currency: CURRENCY,
      locale: "en-GB",
    },
    finances: {
      asOf: `${start}-01`,
      accounts: [
        {
          id: ISA_ID,
          name: "ISA",
          type: "uk-isa",
          owner: PERSON_ID,
          balance: Math.max(0, o.isa),
        },
        {
          id: PENSION_ID,
          name: "Pension",
          type: "uk-sipp",
          owner: PERSON_ID,
          balance: Math.max(0, o.pension),
        },
      ],
    },
    plan: {
      id: "calculator-plan",
      householdId: "calculator",
      name: "Calculator plan",
      tax: { mode: "estimate", filingStatus: "single" },
      leftover: { kind: "save", accountId: ISA_ID },
      milestones: [],
      income:
        o.statePension > 0
          ? [
              {
                id: "state-pension",
                type: "state-pension",
                name: "State Pension",
                owner: PERSON_ID,
                country: "GB",
                amount: { value: o.statePension, basis: "real" },
                frequency: "yearly",
                deferral: { kind: "none" },
                range: {
                  start: { kind: "age", personId: PERSON_ID, age: o.statePensionAge },
                  end: { kind: "planEnd" },
                },
              },
            ]
          : [],
      expenses:
        o.spend > 0
          ? [
              {
                id: "spending",
                type: "living",
                name: "Spending",
                owner: PERSON_ID,
                amount: { value: o.spend, basis: "real" },
                frequency: "yearly",
                range: { start: { kind: "planStart" }, end: { kind: "planEnd" } },
              },
            ]
          : [],
      assumptions: {
        inflation: { kind: "fixed", rate: 0 },
        stockReturn: { kind: "fixed", rate: o.realReturn },
        dividendYield: { kind: "fixed", rate: 0 },
        bondReturn: { kind: "fixed", rate: 0 },
        bondYield: { kind: "fixed", rate: 0 },
        cashReturn: { kind: "fixed", rate: 0 },
        bondAllocation: { kind: "none" },
        cashFlowTiming: o.timing,
        end: { kind: "ref", ref: { kind: "date", date: `${o.birthYear + o.endAge}-01` } },
      },
    },
    options: { trace: "off" },
  };
  return SimulationInput.parse(input);
}

export function retirementRun(o: RetirementOptions): RetirementRun {
  const result = run(buildRetirementInput(o));
  const acct = (p: ProjectionResult["periods"][number], id: string) =>
    p.accounts.find((a) => a.accountId === id);
  const ps = result.periods;
  const short = ps.findIndex((p) => p.totals.shortfall > 1e-6);
  return {
    result,
    ages: ps.map((_, i) => o.startAge + i),
    isa: ps.map((p) => acct(p, ISA_ID)?.closing ?? 0),
    pension: ps.map((p) => acct(p, PENSION_ID)?.closing ?? 0),
    isaDrawn: ps.map((p) => acct(p, ISA_ID)?.withdrawals ?? 0),
    pensionDrawn: ps.map((p) => acct(p, PENSION_ID)?.withdrawals ?? 0),
    statePension: ps.map((p) =>
      p.income.filter((l) => l.sourceId === "state-pension").reduce((s, l) => s + l.amount, 0),
    ),
    tax: ps.map((p) => p.totals.taxes),
    firstShortAge: short < 0 ? null : o.startAge + short,
  };
}

/** Smallest balance (to the penny) for which `works(balance)` holds; `works` must be monotone. */
function smallest(works: (b: number) => boolean, guess: number): number {
  if (works(0)) return 0;
  let hi = Math.max(1, guess);
  for (let i = 0; i < 40 && !works(hi); i++) hi *= 2;
  if (!works(hi)) return Number.POSITIVE_INFINITY;
  let lo = 0;
  while (hi - lo > 0.005) {
    const mid = (lo + hi) / 2;
    if (works(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

export interface UkFireResult {
  age: number;
  retire: number;
  planTo: number;
  birthYear: number;
  accessAge: number;
  firstAccessAge: number;
  accessGap: boolean;
  statePensionAge: number;
  statePension: number;
  /** Bridge years from stopping work to the pension age (0 when you stop at or after it). */
  bridgeYears: number;
  /** Pot balances at each age from `age` to `planTo` while saving (no retirement). */
  isaPath: number[];
  pensionPath: number[];
  /** Projected pots on the day you stop work. */
  isaAtRetire: number;
  pensionAtRetire: number;
  /** ISA needed to pay the spending alone over the bridge (engine) and by the formula. */
  isaNeeded: number;
  isaNeededFormula: number;
  /** Age from which the pension pays (the later of the retirement and the pension ages). */
  pensionFrom: number;
  /** Pension needed at `pensionFrom` to pay the spending to `planTo` with the State Pension. */
  pensionNeededAtStart: number;
  /** The same, discounted back to the retirement age and to today (Coast FIRE for the pension). */
  pensionNeededAtRetire: number;
  pensionCoastToday: number;
  /** The plan for the chosen retirement age, with both pots together. */
  plan: RetirementRun;
  /** Earliest whole age at which the plan pays every year to `planTo`, or null. */
  fireAge: number | null;
  firePlan: RetirementRun | null;
}

export function ukFire(v: Values): UkFireResult {
  const age = num(v, "age");
  const retire = num(v, "retire");
  const planTo = num(v, "planTo");
  const spend = num(v, "spend");
  const r = rate(v, "ret");
  const timing = str(v, "timing") as Timing;
  const region = str(v, "region");
  const statePension = FULL_STATE_PENSION * rate(v, "sp");
  const birthYear = birthYearOf(age);
  const ages = ukAges(birthYear, 1);
  const accessAge = ages.steadyAccessAge;
  const spa = ages.statePensionAge;

  const years = planTo - age;
  const isaPath = potPath(num(v, "isa"), num(v, "isaSave"), r, timing, age, years);
  const pensionPath = potPath(num(v, "pension"), num(v, "penSave"), r, timing, age, years);

  const common = {
    birthYear,
    endAge: planTo,
    spend,
    statePension,
    statePensionAge: spa,
    realReturn: r,
    timing,
    region,
  };
  const planAt = (R: number) =>
    retirementRun({
      ...common,
      startAge: R,
      isa: isaPath[R - age] ?? 0,
      pension: pensionPath[R - age] ?? 0,
    });

  const plan = planAt(retire);
  let fireAge: number | null = null;
  let firePlan: RetirementRun | null = null;
  for (let R = age; R < planTo; R++) {
    const p = R === retire ? plan : planAt(R);
    if (p.firstShortAge === null) {
      fireAge = R;
      firePlan = p;
      break;
    }
  }

  // The bridge: the ISA alone pays the spending from stopping work until the pension can be taken.
  const bridgeYears = Math.max(0, Math.min(accessAge, planTo) - retire);
  const isaNeededFormula = presentValue(Array<number>(bridgeYears).fill(spend), r, timing);
  const isaNeeded =
    bridgeYears === 0
      ? 0
      : smallest(
          (b) =>
            retirementRun({
              ...common,
              startAge: retire,
              endAge: retire + bridgeYears,
              isa: b,
              pension: 0,
            }).firstShortAge === null,
          isaNeededFormula,
        );

  // The pension alone, from the age it can be taken, with the State Pension and the tax estimate.
  const pensionFrom = Math.min(Math.max(retire, accessAge), planTo);
  const pensionNeededAtStart =
    pensionFrom >= planTo
      ? 0
      : smallest(
          (b) =>
            retirementRun({ ...common, startAge: pensionFrom, isa: 0, pension: b })
              .firstShortAge === null,
          spend * (planTo - pensionFrom),
        );
  const discount = (n: number) => (1 + r) ** -Math.max(0, n);
  return {
    age,
    retire,
    planTo,
    birthYear,
    accessAge,
    firstAccessAge: ages.firstAccessAge,
    accessGap: ages.gap !== null,
    statePensionAge: spa,
    statePension,
    bridgeYears,
    isaPath,
    pensionPath,
    isaAtRetire: isaPath[retire - age] ?? 0,
    pensionAtRetire: pensionPath[retire - age] ?? 0,
    isaNeeded,
    isaNeededFormula,
    pensionFrom,
    pensionNeededAtStart,
    pensionNeededAtRetire: pensionNeededAtStart * discount(pensionFrom - retire),
    pensionCoastToday: pensionNeededAtStart * discount(pensionFrom - age),
    plan,
    fireAge,
    firePlan,
  };
}

/** Yearly averages of one phase of a retirement run (ages from `from` up to `to`, exclusive). */
function phaseRow(
  p: RetirementRun,
  label: string,
  from: number,
  to: number,
  m: (x: number) => string,
) {
  const idx = p.ages.map((a, i) => (a >= from && a < to ? i : -1)).filter((i) => i >= 0);
  if (idx.length === 0) return null;
  const avg = (xs: number[]) => idx.reduce((s, i) => s + (xs[i] ?? 0), 0) / idx.length;
  return [
    label,
    to - from === 1 ? String(from) : `${from} to ${to - 1}`,
    m(avg(p.isaDrawn)),
    m(avg(p.pensionDrawn)),
    m(avg(p.statePension)),
    m(avg(p.tax)),
  ];
}

export async function runUkFire(v: Values): Promise<ViewModel> {
  const f = ukFire(v);
  const m = (x: number) => money(x, CURRENCY);
  const spend = num(v, "spend");
  const r = rate(v, "ret");
  const timing = str(v, "timing") as Timing;
  const isaSave = num(v, "isaSave");
  const penSave = num(v, "penSave");
  const { age, retire, planTo, accessAge } = f;
  const spaText = ageText(f.statePensionAge, true);
  const spaShort = ageText(f.statePensionAge);
  const bridges = f.isaAtRetire + 0.005 >= f.isaNeeded;
  const short = f.plan.firstShortAge;

  // Chart: both pots from today, saving until the retirement age, then the UK plan.
  const n = planTo - age;
  const x = Array.from({ length: n + 1 }, (_, i) => age + i);
  const saving = retire - age;
  const isaLine = x.map((_, i) =>
    i <= saving ? (f.isaPath[i] ?? 0) : (f.plan.isa[i - saving - 1] ?? 0),
  );
  const penLine = x.map((_, i) =>
    i <= saving ? (f.pensionPath[i] ?? 0) : (f.plan.pension[i - saving - 1] ?? 0),
  );
  const markers = [
    ...(retire > age ? [{ x: retire, label: `Stop work at ${retire}` }] : []),
    ...(accessAge > retire && accessAge < planTo
      ? [{ x: accessAge, label: `Pension from ${accessAge}` }]
      : []),
    ...(f.statePension > 0 && f.statePensionAge < planTo
      ? [{ x: f.statePensionAge, label: `State Pension from ${spaShort}` }]
      : []),
    ...(short !== null ? [{ x: short, label: `Short from ${short}` }] : []),
  ];
  const chart: ChartSpec = {
    id: "uk-fire-chart",
    kind: "line",
    title: "ISA and pension by age, stopping work at your chosen age",
    summary:
      short === null
        ? `Saving until ${retire}, then spending ${m(spend)} a year: the ISA pays until the pension can be taken at ${accessAge}, the pension pays after that${f.statePension > 0 ? ` with the State Pension from ${spaShort}` : ""}, and every year to ${planTo} is paid.`
        : `Saving until ${retire}, then spending ${m(spend)} a year: the money runs short at age ${short}${short < accessAge ? `, before the pension can be taken at ${accessAge}` : ""}.`,
    xLabel: "Age",
    yLabel: "Today’s money",
    x,
    series: [
      { label: "ISA and other savings", values: isaLine, tone: 1, style: "solid" },
      { label: "Pension", values: penLine, tone: 2, style: "dashed" },
    ],
    markers,
    currency: CURRENCY,
    table: {
      caption: "ISA and pension at the end of each year of age",
      columns: ["Age", "ISA and savings", "Pension"],
      rows: x.map((a, i) => [String(a), m(isaLine[i] ?? 0), m(penLine[i] ?? 0)]),
    },
  };

  // Phases of the plan for the chosen retirement age.
  const phases = [
    phaseRow(f.plan, "Bridge", retire, Math.min(accessAge, planTo), m),
    phaseRow(
      f.plan,
      "Pension",
      Math.max(retire, accessAge),
      Math.min(Math.ceil(f.statePensionAge), planTo),
      m,
    ),
    phaseRow(
      f.plan,
      "Pension and State Pension",
      Math.max(retire, accessAge, Math.ceil(f.statePensionAge)),
      planTo,
      m,
    ),
  ].filter((row): row is string[] => row !== null);
  const table: Table = {
    caption: `Average a year in each phase, stopping work at ${retire} (UK income tax estimate)`,
    columns: ["Phase", "Ages", "From ISA", "From pension", "State Pension", "Income tax"],
    rows: phases,
  };

  const bridgeText =
    f.bridgeYears === 0
      ? `You stop work at or after ${accessAge}, the age your pension can be taken, so there is no gap for your ISA to bridge.`
      : bridges
        ? `Your ISA of ${m(f.isaAtRetire)} at ${retire} bridges the ${f.bridgeYears}-year gap to ${accessAge}, when your pension can be taken; it needs ${m(f.isaNeeded)}.`
        : `Your ISA of ${m(f.isaAtRetire)} at ${retire} falls ${m(f.isaNeeded - f.isaAtRetire)} short of the ${m(f.isaNeeded)} needed to bridge the ${f.bridgeYears} years until your pension can be taken at ${accessAge}.`;
  const fireText =
    f.fireAge === null
      ? `On these numbers no retirement age before ${planTo} pays every year to ${planTo}.`
      : f.fireAge <= age
        ? `You could stop work now: the plan already pays every year to ${planTo}.`
        : `Your FIRE age is ${f.fireAge}: the earliest age at which stopping work pays every year to ${planTo}.`;
  const headline = `${fireText} ${bridgeText}`;

  const allowanceWarnings = [
    ...(isaSave > UK_YEAR.isa.overall
      ? [
          `Your yearly ISA saving is above the ISA allowance of ${m(UK_YEAR.isa.overall)} (${UK_YEAR.label}). The calculator does not cap it; money over the allowance would go into a taxable account in practice.`,
        ]
      : []),
    ...(penSave > UK_YEAR.pensions.annualAllowance
      ? [
          `Your yearly pension contributions are above the annual allowance of ${m(UK_YEAR.pensions.annualAllowance)} (${UK_YEAR.label}). The calculator does not charge tax on the excess or carry forward unused allowance.`,
        ]
      : []),
    ...(f.accessGap
      ? [
          `You reach ${f.firstAccessAge} before the minimum pension age rises to ${accessAge} in ${MONTHS[UK_PENSION_ACCESS.laterFromMonth - 1]} ${UK_PENSION_ACCESS.laterFromYear}, so you could take a pension from ${f.firstAccessAge} until then, but without a protected pension age not again until ${accessAge}. The bridge figures run to ${accessAge}. The year-by-year plan checks access once a year, in January, so it may draw the pension in a year that starts before the rise.`,
        ]
      : []),
  ];

  return {
    tool: "uk-fire",
    headline,
    announce:
      f.fireAge === null
        ? `No FIRE age before ${planTo}. ${bridges ? "The ISA bridges the gap." : "The ISA does not bridge the gap."}`
        : `FIRE age ${Math.max(age, f.fireAge)}. ${f.bridgeYears === 0 ? "No bridge needed." : bridges ? "The ISA bridges the gap." : "The ISA does not bridge the gap."}`,
    figures: [
      {
        label: "FIRE age",
        value: f.fireAge === null ? `Not before ${planTo}` : String(Math.max(age, f.fireAge)),
        detail: `Earliest age that pays every year to ${planTo}`,
      },
      {
        label: `Can your ISA bridge ${retire} to ${Math.max(retire, accessAge)}?`,
        value: f.bridgeYears === 0 ? "No gap" : bridges ? "Yes" : "No",
        detail:
          f.bridgeYears === 0
            ? `You stop at or after the pension age`
            : bridges
              ? `${m(f.isaAtRetire - f.isaNeeded)} to spare`
              : `${m(f.isaNeeded - f.isaAtRetire)} short`,
      },
      {
        label: `ISA needed at ${retire}`,
        value: m(f.isaNeeded),
        detail: `You would have ${m(f.isaAtRetire)}`,
      },
      {
        label: `Pension needed at ${retire}`,
        value: m(f.pensionNeededAtRetire),
        detail: `You would have ${m(f.pensionAtRetire)}${f.pensionFrom > retire ? `; it grows to ${m(f.pensionNeededAtStart)} by ${f.pensionFrom}` : ""}`,
      },
      ...(f.pensionFrom > age
        ? [
            {
              label: "Pension today for Coast FIRE",
              value: m(f.pensionCoastToday),
              detail: `Grows to ${m(f.pensionNeededAtStart)} by ${f.pensionFrom} with no more contributions`,
            },
          ]
        : []),
      {
        label: "Pension age and State Pension age",
        value: `${accessAge} and ${spaShort}`,
        detail: `Born January ${f.birthYear}${f.accessGap ? `; ${f.firstAccessAge} only until the age rises` : ""}`,
      },
    ],
    charts: [chart],
    table,
    comparison: {
      title: "Formula and engine side by side",
      rows: [
        {
          label: `ISA at ${retire}`,
          formula: m(balanceAfter(num(v, "isa"), isaSave, r, retire - age, timing)),
          engine: m(f.isaAtRetire),
        },
        {
          label: `Pension at ${retire}`,
          formula: m(balanceAfter(num(v, "pension"), penSave, r, retire - age, timing)),
          engine: m(f.pensionAtRetire),
        },
        {
          label: "ISA needed for the bridge",
          formula: m(f.isaNeededFormula),
          engine: m(f.isaNeeded),
        },
      ],
      note: "The saving phase and the ISA bridge have textbook formulas (a balance growing with yearly additions; the present value of the spending over the bridge years), and the engine agrees with them to the penny. The pension needed after the bridge depends on the UK income tax estimate and the State Pension year by year, so only the engine gives it.",
    },
    method: [
      `Saving phase: the engine’s simulate() for each pot, growing ${pctInput(r * 100)} a year after inflation with ${m(isaSave)} a year into the ISA and ${m(penSave)} a year into pensions, until ${retire}.`,
      `Retirement: simulate() of a UK household with a stocks and shares ISA and a SIPP, ${m(spend)} of spending a year, the State Pension of ${m(f.statePension)} a year from ${spaText} and the engine’s UK income tax estimate${str(v, "region") === "SCT" ? " with Scottish rates" : ""}. The pension cannot be drawn before ${accessAge}; once it can, it is drawn before the ISA.`,
      `Pots needed: the smallest ISA that pays ${m(spend)} a year on its own from ${retire} to ${Math.max(retire, accessAge)}, and the smallest pension that pays it from ${f.pensionFrom} to ${planTo} with the State Pension and after tax, found by bisection over the engine.`,
      "Everything is in today’s money: no inflation, so tax thresholds and the State Pension stay at today’s values.",
      timingText(timing),
    ],
    warnings: allowanceWarnings,
  };
}
