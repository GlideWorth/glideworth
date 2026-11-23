/**
 * What-if scenario templates and household survivor scenarios, each expressed as a plan patch so
 * they can be previewed (diff + simulate), applied, or stored as a branch (`createBranch`).
 */
import { formatMonth, parseMonth } from "../engine/dates.js";
import type { SimulationInput } from "../engine/types.js";
import { ScenarioError } from "../errors.js";
import type { PatchOp } from "../schema/changes.js";
import type { MonthDate } from "../schema/primitives.js";
import { fmtMoney, fmtMonth, fmtPercent } from "./format.js";

export interface ScenarioTemplate {
  id: string;
  title: string;
  description: string;
  patch: PatchOp[];
  /** Modelling caveats the user should know (e.g. survivor benefits not modelled yet). */
  notes: string[];
}

export interface TemplateInfo {
  id: string;
  title: string;
  params: string[];
}

/** Catalogue for UIs / MCP tool descriptions. */
export const WHAT_IF_TEMPLATES: TemplateInfo[] = [
  { id: "market-crash", title: "Market crash", params: ["year", "drop"] },
  { id: "job-loss", title: "Job loss", params: ["incomeId", "start", "months"] },
  { id: "career-break", title: "Career break", params: ["personId", "start", "months", "share"] },
  { id: "early-retirement", title: "Retire earlier", params: ["years", "milestoneId"] },
  {
    id: "downsizing",
    title: "Downsize your home",
    params: ["month", "equityReleased", "housingCut"],
  },
  { id: "child", title: "Have a child", params: ["birthMonth", "annualCost", "childcareAnnual"] },
  { id: "inheritance", title: "Receive an inheritance", params: ["month", "amount"] },
  {
    id: "long-term-care",
    title: "Long-term care",
    params: ["personId", "fromAge", "annualCost", "years"],
  },
  { id: "survivor", title: "Partner dies at age X", params: ["personId", "age"] },
];

const money = (input: SimulationInput, v: number) =>
  fmtMoney(v, { currency: input.household.currency, locale: input.household.locale });
const date = (m: number) => ({ kind: "date" as const, date: formatMonth(m), offsetMonths: 0 });
const slug = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64);

function person(input: SimulationInput, personId?: string) {
  const p = personId
    ? input.household.people.find((x) => x.id === personId)
    : input.household.people.find((x) => x.role === "primary");
  if (!p) throw new ScenarioError(`unknown person '${personId}'`, { personId });
  return p;
}

/**
 * A one-year stock market fall in `year` (then back to the plan's assumption). Expressed as an
 * `assumptions.rateOverrides` entry, so it works on top of any return assumption (fixed, schedule
 * or a historical sequence).
 */
export function marketCrashScenario(
  input: SimulationInput,
  opts: { year: number; drop?: number },
): ScenarioTemplate {
  const drop = opts.drop ?? 0.3;
  const spec = input.plan.assumptions.stockReturn;
  const override = {
    series: "stocks" as const,
    range: {
      start: { kind: "date" as const, date: `${opts.year}-01`, offsetMonths: 0 },
      end: { kind: "date" as const, date: `${opts.year + 1}-01`, offsetMonths: 0 },
      endInclusive: false,
    },
    rate: -drop,
  };
  const existing = input.plan.assumptions.rateOverrides;
  const after =
    spec.kind === "fixed"
      ? `return ${fmtPercent(spec.rate)} a year as before`
      : "follow the plan assumption again";
  return {
    id: `market-crash-${opts.year}`,
    title: `Markets fall ${fmtPercent(drop)} in ${opts.year}`,
    description: `Stocks lose ${fmtPercent(drop)} in ${opts.year}, then ${after}.`,
    patch: [
      existing
        ? { op: "add", path: "/assumptions/rateOverrides/-", value: override }
        : { op: "add", path: "/assumptions/rateOverrides", value: [override] },
    ],
    notes: [
      "Uses a temporary stock-return override; for many random crashes use Monte Carlo instead.",
    ],
  };
}

function pausePatch(
  input: SimulationInput,
  incomeIds: string[],
  start: number,
  months: number,
  share: number,
): PatchOp[] {
  return incomeIds.map((id) => {
    const inc = input.plan.income.find((i) => i.id === id);
    if (!inc) throw new ScenarioError(`unknown income '${id}'`, { incomeId: id });
    return {
      op: inc.partTime ? "replace" : "add",
      path: `/income/[id=${id}]/partTime`,
      value: {
        range: { start: date(start), end: date(start + months), endInclusive: false },
        share,
      },
    } as PatchOp;
  });
}

/** Lose a job: the income stops for `months` from `start`. */
export function jobLossScenario(
  input: SimulationInput,
  opts: { incomeId: string; start: MonthDate; months: number },
): ScenarioTemplate {
  const inc = input.plan.income.find((i) => i.id === opts.incomeId);
  if (!inc)
    throw new ScenarioError(`unknown income '${opts.incomeId}'`, { incomeId: opts.incomeId });
  return {
    id: slug(`job-loss-${opts.incomeId}-${opts.start}`),
    title: `${inc.name} stops for ${opts.months} months`,
    description: `No ${inc.name} from ${fmtMonth(opts.start)} for ${opts.months} months.`,
    patch: pausePatch(input, [inc.id], parseMonth(opts.start), opts.months, 0),
    notes: ["Redundancy pay or benefits are not added; add them as one-off income if relevant."],
  };
}

/** Career break (or part-time spell) for a person: all their earned income scales by `share`. */
export function careerBreakScenario(
  input: SimulationInput,
  opts: { personId?: string; start: MonthDate; months: number; share?: number },
): ScenarioTemplate {
  const p = person(input, opts.personId);
  const ids = input.plan.income
    .filter(
      (i) =>
        i.owner === p.id &&
        ["salary", "hourly", "self-employment", "bonus"].includes(i.type) &&
        // A bonus set as a share of a salary already follows the salary's part-time share.
        !(i.type === "bonus" && i.percentOfSalary),
    )
    .map((i) => i.id);
  if (ids.length === 0)
    throw new ScenarioError(`${p.name} has no earned income`, { personId: p.id });
  const share = opts.share ?? 0;
  return {
    id: slug(`career-break-${p.id}-${opts.start}`),
    title:
      share === 0
        ? `${p.name} takes a ${opts.months}-month break`
        : `${p.name} works ${fmtPercent(share)} for ${opts.months} months`,
    description: `${p.name}'s earnings ${share === 0 ? "stop" : `fall to ${fmtPercent(share)}`} from ${fmtMonth(opts.start)} for ${opts.months} months.`,
    patch: pausePatch(input, ids, parseMonth(opts.start), opts.months, share),
    notes: ["Pension contributions tied to these earnings keep their own settings."],
  };
}

/** Retire `years` earlier (negative = later). */
export function earlyRetirementScenario(
  input: SimulationInput,
  opts: { years: number; milestoneId?: string },
): ScenarioTemplate {
  const ms = opts.milestoneId
    ? input.plan.milestones.find((m) => m.id === opts.milestoneId)
    : input.plan.milestones.find((m) => m.kind === "retirement");
  if (!ms) throw new ScenarioError("no retirement milestone", {});
  const c = ms.criteria.length === 1 ? ms.criteria[0]! : null;
  let patch: PatchOp[];
  if (c?.kind === "age")
    patch = [
      {
        op: "replace",
        path: `/milestones/[id=${ms.id}]/criteria/0/age`,
        value: c.age - opts.years,
      },
    ];
  else if (c?.kind === "date")
    patch = [
      {
        op: "replace",
        path: `/milestones/[id=${ms.id}]/criteria/0/date`,
        value: formatMonth(parseMonth(c.date) - Math.round(opts.years * 12)),
      },
    ];
  else
    throw new ScenarioError(`${ms.name} is not a simple age or date milestone`, {
      milestoneId: ms.id,
    });
  const verb = opts.years >= 0 ? "earlier" : "later";
  return {
    id: slug(`retire-${verb}-${Math.abs(opts.years)}`),
    title: `${ms.name} ${Math.abs(opts.years)} year${Math.abs(opts.years) === 1 ? "" : "s"} ${verb}`,
    description: `Move ${ms.name} ${Math.abs(opts.years)} years ${verb}; everything tied to it moves too.`,
    patch,
    notes: [],
  };
}

/** Downsize: release equity at `month` and cut housing costs from then on. */
export function downsizingScenario(
  input: SimulationInput,
  opts: { month: MonthDate; equityReleased: number; housingCut?: number },
): ScenarioTemplate {
  const at = parseMonth(opts.month);
  const cut = opts.housingCut ?? 0.3;
  const patch: PatchOp[] = [
    {
      op: "add",
      path: "/income/-",
      value: {
        id: slug(`inc-downsize-${opts.month}`),
        type: "windfall",
        name: "Equity released by downsizing",
        owner: "joint",
        amount: { value: opts.equityReleased, basis: "real" },
        frequency: "once",
        range: { start: date(at), end: { kind: "never" } },
        tax: { character: "tax-free", withholding: { mode: "none" }, exemptIn: [] },
      },
    },
  ];
  for (const e of input.plan.expenses.filter(
    (x) => x.enabled && x.type === "housing" && x.frequency !== "once",
  )) {
    patch.push({ op: "replace", path: `/expenses/[id=${e.id}]/range/end`, value: date(at) });
    patch.push({
      op: "add",
      path: "/expenses/-",
      value: {
        ...e,
        id: slug(`${e.id}-downsized`),
        name: `${e.name} (smaller home)`,
        amount: { ...e.amount, value: e.amount.value * (1 - cut) },
        range: { ...e.range, start: date(at) },
      },
    });
  }
  return {
    id: slug(`downsize-${opts.month}`),
    title: `Downsize in ${fmtMonth(opts.month)}`,
    description: `Release ${money(input, opts.equityReleased)} of home equity in ${fmtMonth(opts.month)} and cut housing costs by ${fmtPercent(cut)}.`,
    patch,
    notes: [
      "Equity is added as tax-free cash (main-residence relief); moving costs and stamp duty should be netted off the amount.",
      "Property running costs on the home asset itself are unchanged; adjust the asset's settings for a full picture.",
    ],
  };
}

/** Have a child: child costs to 18 and childcare in the early years. */
export function childScenario(
  input: SimulationInput,
  opts: {
    birthMonth: MonthDate;
    annualCost: number;
    childcareAnnual?: number;
    childcareFromMonths?: number;
    childcareToYears?: number;
  },
): ScenarioTemplate {
  const b = parseMonth(opts.birthMonth);
  const patch: PatchOp[] = [
    {
      op: "add",
      path: "/expenses/-",
      value: {
        id: slug(`exp-child-${opts.birthMonth}`),
        type: "dependent-support",
        name: "Child costs",
        owner: "joint",
        amount: { value: opts.annualCost, basis: "real" },
        frequency: "yearly",
        range: { start: date(b), end: date(b + 18 * 12) },
        spendingType: "essential",
      },
    },
  ];
  if (opts.childcareAnnual)
    patch.push({
      op: "add",
      path: "/expenses/-",
      value: {
        id: slug(`exp-childcare-${opts.birthMonth}`),
        type: "childcare",
        name: "Childcare",
        owner: "joint",
        amount: { value: opts.childcareAnnual, basis: "real" },
        frequency: "yearly",
        range: {
          start: date(b + (opts.childcareFromMonths ?? 12)),
          end: date(b + (opts.childcareToYears ?? 5) * 12),
        },
        spendingType: "essential",
      },
    });
  return {
    id: slug(`child-${opts.birthMonth}`),
    title: `Have a child in ${fmtMonth(opts.birthMonth)}`,
    description: `Child costs of ${money(input, opts.annualCost)} a year to age 18${opts.childcareAnnual ? `, plus childcare of ${money(input, opts.childcareAnnual)} a year` : ""}.`,
    patch,
    notes: [
      "Combine with a career-break scenario for parental leave. Child benefit and tax credits are not added.",
    ],
  };
}

/** Receive an inheritance. */
export function inheritanceScenario(
  input: SimulationInput,
  opts: { month: MonthDate; amount: number; taxable?: boolean },
): ScenarioTemplate {
  return {
    id: slug(`inheritance-${opts.month}`),
    title: `Inherit ${money(input, opts.amount)} in ${fmtMonth(opts.month)}`,
    description: `A one-off inheritance of ${money(input, opts.amount)} (today's money) in ${fmtMonth(opts.month)}.`,
    patch: [
      {
        op: "add",
        path: "/income/-",
        value: {
          id: slug(`inc-inheritance-${opts.month}`),
          type: "inheritance",
          name: "Inheritance",
          owner: "joint",
          amount: { value: opts.amount, basis: "real" },
          frequency: "once",
          range: {
            start: { kind: "date", date: opts.month, offsetMonths: 0 },
            end: { kind: "never" },
          },
          tax: {
            character: opts.taxable ? "ordinary" : "tax-free",
            withholding: { mode: "none" },
            exemptIn: [],
          },
        },
      },
    ],
    notes: ["Inheritance tax is assumed already paid by the estate."],
  };
}

/** Long-term care for a person from an age, for a number of years (or to the end of the plan). */
export function longTermCareScenario(
  input: SimulationInput,
  opts: { personId?: string; fromAge: number; annualCost: number; years?: number },
): ScenarioTemplate {
  const p = person(input, opts.personId);
  // Healthcare inflation, as for healthcare expenses: general inflation plus the plan's premium.
  const premium = input.plan.assumptions.healthcareInflationPremium;
  const pct = `${Number((premium * 100).toFixed(2))}%`;
  return {
    id: slug(`ltc-${p.id}-${opts.fromAge}`),
    title: `${p.name} needs care from ${opts.fromAge}`,
    description: `Care costs of ${money(input, opts.annualCost)} a year (today's money, rising ${pct} above inflation) for ${p.name} from age ${opts.fromAge}${opts.years ? ` for ${opts.years} years` : ""}.`,
    patch: [
      {
        op: "add",
        path: "/expenses/-",
        value: {
          id: slug(`exp-ltc-${p.id}-${opts.fromAge}`),
          type: "long-term-care",
          name: `${p.name} care`,
          owner: p.id,
          amount: { value: opts.annualCost, basis: "real" },
          frequency: "yearly",
          range: {
            start: { kind: "age", personId: p.id, age: opts.fromAge, offsetMonths: 0 },
            end: opts.years
              ? { kind: "age", personId: p.id, age: opts.fromAge + opts.years, offsetMonths: 0 }
              : { kind: "planEnd", offsetMonths: 0 },
          },
          change: { kind: "inflation", plus: premium },
          spendingType: "essential",
        },
      },
    ],
    notes: [],
  };
}

/**
 * "What if partner A dies at age X": A's life-expectancy milestone moves to X and gains a `death`
 * effect. The engine then stops A's own income at death, passes accounts and assets to the survivor
 * (basis step-up, filing status change) and pays survivor benefits it supports: income with a
 * `survivorShare` continues at that share, US Social Security (amount or estimate mode) pays the
 * survivor the larger of the two benefits. Pensions and annuities of A without a survivor share get
 * `survivorPensionShare` (default 50%, a typical joint-life pension), DB pensions likewise.
 */
export function survivorScenario(
  input: SimulationInput,
  opts: { personId: string; age: number; survivorPensionShare?: number },
): ScenarioTemplate {
  const p = person(input, opts.personId);
  if (input.household.people.length < 2)
    throw new ScenarioError("survivor scenarios need a couple", {});
  const survivor = input.household.people.find((x) => x.id !== p.id)!;
  const patch: PatchOp[] = [];
  const le = input.plan.milestones.find(
    (m) =>
      m.kind === "life-expectancy" &&
      (m.personId === p.id || m.criteria.some((c) => c.kind === "age" && c.personId === p.id)),
  );
  let msId: string;
  if (le) {
    msId = le.id;
    patch.push({
      op: "replace",
      path: `/milestones/[id=${le.id}]/criteria`,
      value: [{ kind: "age", personId: p.id, age: opts.age, when: "at" }],
    });
    if (!le.effects.some((e) => e.kind === "death"))
      patch.push({
        op: "add",
        path: `/milestones/[id=${le.id}]/effects/-`,
        value: { kind: "death", personId: p.id },
      });
  } else {
    msId = slug(`ms-death-${p.id}`);
    patch.push({
      op: "add",
      path: "/milestones/-",
      value: {
        id: msId,
        name: `${p.name} dies`,
        kind: "life-expectancy",
        personId: p.id,
        criteria: [{ kind: "age", personId: p.id, age: opts.age, when: "at" }],
        effects: [{ kind: "death", personId: p.id }],
      },
    });
  }
  const share = opts.survivorPensionShare ?? 0.5;
  const continued: string[] = [];
  for (const inc of input.plan.income.filter((i) => i.enabled && i.owner === p.id)) {
    if (
      (inc.type === "pension" || inc.type === "annuity") &&
      inc.survivorShare === undefined &&
      share > 0
    ) {
      patch.push({ op: "add", path: `/income/[id=${inc.id}]/survivorShare`, value: share });
      continued.push(inc.name);
    }
    if (
      (inc.type === "salary" || inc.type === "hourly") &&
      inc.pension &&
      inc.pension.survivorShare === undefined &&
      share > 0
    ) {
      patch.push({ op: "add", path: `/income/[id=${inc.id}]/pension/survivorShare`, value: share });
      continued.push(`${inc.name} pension`);
    }
  }
  void msId;
  const ss = input.plan.income.some(
    (i) => i.enabled && i.type === "social-security" && i.owner === p.id,
  );
  return {
    id: slug(`survivor-${p.id}-${opts.age}`),
    title: `${p.name} dies at ${opts.age}`,
    description: `${p.name} dies at age ${opts.age}; ${survivor.name} continues alone. ${p.name}'s own income stops${continued.length > 0 ? `; ${continued.join(", ")} continue${continued.length === 1 ? "s" : ""} at ${fmtPercent(share)} for ${survivor.name}` : ""}.`,
    patch,
    notes: [
      ...(ss
        ? ["Social Security: the survivor receives the larger of the two benefits from age 60."]
        : []),
      "Survivor benefits applied: survivor shares on pensions/annuities and US Social Security survivor benefits. An inherited UK State Pension top-up (pre-2016 additional State Pension) is not modelled.",
      "Household spending is unchanged; most survivors spend 20-30% less, so consider a spending cut too.",
    ],
  };
}

/** Survivor scenarios for each partner at each age (default: 70, 80 and 90). */
export function survivorScenarios(
  input: SimulationInput,
  opts: { ages?: number[] } = {},
): ScenarioTemplate[] {
  if (input.household.people.length < 2) return [];
  const ages = opts.ages ?? [70, 80, 90];
  const start = parseMonth(
    input.plan.startingConditions.kind === "snapshot"
      ? input.plan.startingConditions.finances.asOf
      : input.finances.asOf,
  );
  return input.household.people.flatMap((p) =>
    ages
      .filter((age) => parseMonth(p.birthMonth) + age * 12 > start)
      .map((age) => survivorScenario(input, { personId: p.id, age })),
  );
}
