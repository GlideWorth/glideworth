/**
 * Input definitions of every calculator: labels, units, ranges, defaults and helper text. No engine
 * code here, so a page script can import its spec without pulling in the engine.
 */
import { UK_TAX_YEARS } from "@glideworth/core";
import { currencyField, realReturnField, seedField, taxField, timingField } from "../state";
import type { NumberField, SelectField, ToolId, ToolSpec, Values } from "../types";

const money = (
  key: string,
  label: string,
  def: number,
  help: string,
  extra: Partial<NumberField> = {},
) =>
  ({
    kind: "number",
    key,
    label,
    unit: "money",
    min: 0,
    max: 1_000_000_000,
    step: 1,
    default: def,
    help,
    ...extra,
  }) satisfies NumberField;

const age = (key: string, label: string, def: number, help: string, min = 16, max = 100) =>
  ({
    kind: "number",
    key,
    label,
    unit: "age",
    min,
    max,
    step: 1,
    default: def,
    help,
  }) satisfies NumberField;

const yrs = (
  key: string,
  label: string,
  def: number,
  help: string,
  min: number,
  max: number,
  extra: Partial<NumberField> = {},
) =>
  ({
    kind: "number",
    key,
    label,
    unit: "years",
    min,
    max,
    step: 1,
    default: def,
    help,
    ...extra,
  }) satisfies NumberField;

const percent = (
  key: string,
  label: string,
  def: number,
  help: string,
  min: number,
  max: number,
  extra: Partial<NumberField> = {},
) =>
  ({
    kind: "number",
    key,
    label,
    unit: "percent",
    min,
    max,
    step: 0.01,
    default: def,
    help,
    ...extra,
  }) satisfies NumberField;

const n = (v: Values, k: string) => (typeof v[k] === "number" ? (v[k] as number) : Number.NaN);

const STOCKS_HISTORY: NumberField = percent(
  "stocks",
  "Share in stocks",
  60,
  "The rest is in 10-year US Treasury bonds, rebalanced every year.",
  0,
  100,
  { step: 1 },
);

const TRIALS = (def: string, options: string[]): SelectField => ({
  kind: "select",
  key: "trials",
  label: "Number of simulations",
  help: "More simulations narrow the sampling noise; the model’s assumptions matter far more.",
  options: options.map((o) => ({ value: o, label: Number(o).toLocaleString("en-US") })),
  default: def,
  advanced: true,
});

export const coastSpec: ToolSpec = {
  id: "coast-fire",
  path: "/tools/coast-fire-calculator/",
  mode: "instant",
  fields: [
    age("age", "Your age now", 30, "In whole years.", 16, 90),
    age(
      "retire",
      "Age you want to retire",
      60,
      "When the portfolio has to reach your FIRE number.",
      17,
      100,
    ),
    money(
      "balance",
      "Invested today",
      100_000,
      "Everything invested for retirement, in today’s money.",
    ),
    money(
      "spend",
      "Yearly spending in retirement",
      40_000,
      "In today’s money. Sets your FIRE number.",
    ),
    percent("wr", "Withdrawal rate", 4, "4% means a FIRE number of 25 times spending.", 0.5, 10),
    realReturnField(5, "Yearly growth after inflation, compounded once a year."),
    money(
      "save",
      "Yearly saving until you coast",
      10_000,
      "Used to find the age you reach Coast FIRE. Use 0 for none.",
    ),
    timingField(),
    currencyField(),
  ],
  validate(v) {
    const e: Record<string, string> = {};
    if (n(v, "retire") <= n(v, "age")) e.retire = "Retirement age must be after your age now.";
    else if (n(v, "retire") - n(v, "age") > 80) e.retire = "Keep the gap to 80 years or less.";
    return e;
  },
};

export const fireSpec: ToolSpec = {
  id: "fire",
  path: "/tools/fire-calculator/",
  mode: "instant",
  fields: [
    age("age", "Your age now", 30, "In whole years.", 16, 90),
    money("spend", "Yearly spending in retirement", 40_000, "In today’s money, after any tax."),
    percent(
      "wr",
      "Withdrawal rate",
      4,
      "Your FIRE number is spending divided by this rate.",
      0.5,
      10,
    ),
    money("balance", "Invested today", 50_000, "Everything invested towards it, in today’s money."),
    money("save", "Yearly saving", 20_000, "Added every year until you reach the number."),
    realReturnField(5, "Yearly growth after inflation while you save."),
    taxField(
      "Taken off each withdrawal in retirement, so it raises the FIRE number. Not a country tax estimate.",
    ),
    yrs(
      "hy",
      "Retirement length to test",
      30,
      "Years of withdrawals in the history test of your number.",
      10,
      60,
      { advanced: true },
    ),
    {
      ...STOCKS_HISTORY,
      help: "Mix used in the history test; the rest is in 10-year US Treasury bonds.",
      advanced: true,
    },
    timingField(),
    currencyField(),
  ],
};

export const fatFireSpec: ToolSpec = {
  id: "fat-fire",
  path: "/tools/fat-fire-calculator/",
  mode: "instant",
  fields: [
    age("age", "Your age now", 40, "In whole years.", 16, 90),
    money(
      "spend",
      "Fat yearly spending",
      150_000,
      "In today’s money. The fat FIRE number scales with this.",
    ),
    money(
      "reg",
      "Regular spending to compare",
      80_000,
      "A middle spending level for this same person. Not a fixed definition.",
    ),
    money(
      "lean",
      "Lean spending to compare",
      40_000,
      "A lower spending level for this same person. Not a fixed definition.",
    ),
    percent(
      "wr",
      "Withdrawal rate",
      3.5,
      "3.5% is a starting point for about 50 years. 4% was studied over about 30.",
      0.5,
      10,
    ),
    money(
      "balance",
      "Invested today",
      500_000,
      "Everything invested towards it, in today’s money.",
    ),
    money("save", "Yearly saving", 150_000, "Added every year until you reach the fat number."),
    realReturnField(5, "Yearly growth after inflation while you save."),
    taxField("Taken off each withdrawal, so it raises every target. Not a country tax estimate."),
    yrs(
      "hy",
      "Retirement length to test",
      50,
      "Years of withdrawals in the history test of the fat number.",
      10,
      60,
      { advanced: true },
    ),
    {
      ...STOCKS_HISTORY,
      help: "Mix used in the history test; the rest is in 10-year US Treasury bonds.",
      advanced: true,
    },
    timingField(),
    currencyField(),
  ],
};

export const baristaSpec: ToolSpec = {
  id: "barista-fire",
  path: "/tools/barista-fire-calculator/",
  mode: "instant",
  fields: [
    age(
      "age",
      "Age you leave full-time work",
      45,
      "The portfolio starts paying from here.",
      16,
      90,
    ),
    money("spend", "Yearly spending", 40_000, "In today’s money."),
    money(
      "pt",
      "Part-time income, after tax",
      15_000,
      "Yearly, in today’s money. Use 0 for full retirement.",
    ),
    age("ptUntil", "Part-time work until age", 60, "The income stops at this birthday.", 16, 100),
    age("planTo", "Plan to age", 90, "The portfolio has to last until this birthday.", 17, 110),
    realReturnField(3, "Yearly growth after inflation, compounded once a year."),
    taxField("Taken off portfolio withdrawals only; enter part-time pay after its own tax."),
    timingField(),
    currencyField(),
  ],
  validate(v) {
    const e: Record<string, string> = {};
    if (n(v, "planTo") <= n(v, "age")) e.planTo = "Plan to an age after you leave full-time work.";
    else if (n(v, "planTo") - n(v, "age") > 80) e.planTo = "Keep the plan to 80 years or less.";
    if (n(v, "ptUntil") < n(v, "age"))
      e.ptUntil = "Part-time work cannot end before you leave full-time work.";
    else if (n(v, "ptUntil") > n(v, "planTo"))
      e.ptUntil = "Part-time work cannot end after the plan does.";
    return e;
  },
};

export const howLongSpec: ToolSpec = {
  id: "how-long",
  path: "/tools/how-long-will-my-money-last/",
  mode: "instant",
  fields: [
    money("balance", "Savings", 500_000, "What you start with, in today’s money."),
    money(
      "spend",
      "Yearly withdrawal",
      30_000,
      "Taken every year, rising with inflation (today’s money).",
    ),
    realReturnField(4, "Steady yearly growth after inflation."),
    age("age", "Your age now", 65, "Only used to show the age the money lasts to.", 16, 110),
    taxField("Taken off each withdrawal, so more is withdrawn to leave the amount above to spend."),
    { ...STOCKS_HISTORY, advanced: true },
    timingField(),
    currencyField(),
  ],
};

const METHOD_HELP =
  "US history resamples real years from 1928 to 2025; random returns draw each year independently.";

export const withdrawalSpec: ToolSpec = {
  id: "withdrawal",
  path: "/tools/retirement-withdrawal-calculator/",
  mode: "simulation",
  fields: [
    money("balance", "Portfolio at retirement", 1_000_000, "In today’s money."),
    percent(
      "rate",
      "Initial withdrawal rate",
      4,
      "First-year withdrawal as a share of the portfolio.",
      0.5,
      15,
    ),
    yrs("years", "Years in retirement", 30, "How long the withdrawals must last.", 5, 60),
    {
      kind: "select",
      key: "method",
      label: "Market model",
      help: METHOD_HELP,
      options: [
        { value: "parametric", label: "Random returns (log-normal)" },
        { value: "history", label: "US history, 1928 to 2025" },
      ],
      default: "parametric",
    },
    percent(
      "mean",
      "Average return after inflation",
      5,
      "Arithmetic mean of the yearly real return.",
      -5,
      15,
      {
        showWhen: { key: "method", values: ["parametric"] },
      },
    ),
    percent("vol", "Volatility", 12, "Standard deviation of the yearly real return.", 0, 40, {
      showWhen: { key: "method", values: ["parametric"] },
    }),
    { ...STOCKS_HISTORY, showWhen: { key: "method", values: ["history"] } },
    TRIALS("1000", ["500", "1000", "2000", "5000"]),
    seedField(),
    taxField("Taken out of each withdrawal before it is spent. Not a country tax estimate."),
    timingField(),
    currencyField(),
  ],
};

export const monteCarloSpec: ToolSpec = {
  id: "monte-carlo",
  path: "/tools/monte-carlo-retirement-calculator/",
  mode: "simulation",
  fields: [
    money("balance", "Portfolio", 1_000_000, "Invested savings at the start, in today’s money."),
    money("spend", "Yearly spending", 40_000, "Rising with inflation (today’s money)."),
    yrs("years", "Years it must last", 30, "The length of the plan.", 1, 70),
    {
      kind: "select",
      key: "method",
      label: "Market model",
      help: METHOD_HELP,
      options: [
        { value: "history", label: "US history, random start years" },
        { value: "block", label: "US history, 5-year blocks" },
        { value: "parametric", label: "Random returns (log-normal)" },
      ],
      default: "history",
    },
    { ...STOCKS_HISTORY, showWhen: { key: "method", values: ["history", "block"] } },
    percent(
      "mean",
      "Average return after inflation",
      5,
      "Arithmetic mean of the yearly real return.",
      -5,
      15,
      {
        showWhen: { key: "method", values: ["parametric"] },
      },
    ),
    percent("vol", "Volatility", 12, "Standard deviation of the yearly real return.", 0, 40, {
      showWhen: { key: "method", values: ["parametric"] },
    }),
    TRIALS("1000", ["500", "1000", "5000", "10000"]),
    seedField(),
    money(
      "inc",
      "Pension or other income",
      0,
      "Yearly, after tax, in today’s money. It reduces withdrawals.",
      {
        advanced: true,
      },
    ),
    yrs(
      "incFrom",
      "Income starts after",
      10,
      "Years from the start of the plan (0 = from the start).",
      0,
      70,
      { advanced: true },
    ),
    taxField("Taken off each withdrawal. Not a country tax estimate."),
    timingField(),
    currencyField(),
  ],
};

// ------------------------------------------------------------------- US retirement tax (group 'tax')
// Every rule and figure behind these three comes from @glideworth/core's US federal data; the specs
// hold only inputs. The fields have no currency choice: the rules are in US dollars.

const year = (key: string, label: string, def: number, help: string, min: number, max: number) =>
  ({
    kind: "number",
    key,
    label,
    unit: "count",
    min,
    max,
    step: 1,
    default: def,
    help,
  }) satisfies NumberField;

export const rmdSpec: ToolSpec = {
  id: "rmd",
  path: "/tools/rmd-calculator/",
  mode: "instant",
  fields: [
    year(
      "born",
      "Year you were born",
      1953,
      "Sets your age each year and the age RMDs start.",
      1920,
      2010,
    ),
    year("year", "Year of the distribution", 2026, "The calendar year the RMD is for.", 2024, 2075),
    money(
      "balance",
      "Balance at the end of the year before",
      500_000,
      "The account’s value on 31 December of the previous year. The RMD is based on it.",
    ),
    realReturnField(4, "Steady yearly growth after inflation, used only to project later RMDs."),
    timingField(),
  ],
  validate(v) {
    const e: Record<string, string> = {};
    if (n(v, "year") - n(v, "born") > 120)
      e.born = "That makes you older than 120 in the distribution year.";
    return e;
  },
};

export const seppSpec: ToolSpec = {
  id: "sepp-72t",
  path: "/tools/72t-calculator/",
  mode: "instant",
  fields: [
    money("balance", "Account balance", 500_000, "The balance the payment is worked out from."),
    age(
      "age",
      "Age in the first year of payments",
      50,
      "The age you reach in the calendar year the payments start.",
      18,
      90,
    ),
    percent(
      "interest",
      "Interest rate",
      5,
      "IRS Notice 2022-6 limits the rate you may use. Check the limit for your start date; this calculator does not.",
      0,
      12,
    ),
    yrs(
      "years",
      "Years of payments",
      10,
      "How long you will take the payments. Section 72(t) sets the minimum; check it for your dates.",
      1,
      60,
    ),
    percent(
      "growth",
      "Account growth a year",
      5,
      "Before inflation, because the payment is a fixed number of dollars. Used only for the balance projection.",
      -10,
      15,
      { step: 0.1 },
    ),
  ],
};

/** Premium years with IRMAA tiers in the engine's data (a test checks them against US_IRMAA_YEARS). */
export const IRMAA_YEARS = ["2026", "2027"] as const;

export const irmaaSpec: ToolSpec = {
  id: "irmaa",
  path: "/tools/irmaa-calculator/",
  mode: "instant",
  fields: [
    money(
      "magi",
      "Modified adjusted gross income (MAGI)",
      150_000,
      "From your tax return for two years before the premium year.",
    ),
    {
      kind: "select",
      key: "status",
      label: "Filing status on that return",
      help: "Glideworth applies the single tiers to head of household and qualifying surviving spouse.",
      options: [
        { value: "single", label: "Single" },
        { value: "married-joint", label: "Married filing jointly" },
        { value: "married-separate", label: "Married filing separately" },
        { value: "head-of-household", label: "Head of household" },
        { value: "qualifying-surviving-spouse", label: "Qualifying surviving spouse" },
      ],
      default: "single",
    },
    {
      kind: "select",
      key: "year",
      label: "Premium year",
      help: "The year you pay the premiums. Only years Medicare has published are offered.",
      options: IRMAA_YEARS.map((y) => ({ value: y, label: y })),
      default: IRMAA_YEARS[IRMAA_YEARS.length - 1]!,
    },
    {
      kind: "select",
      key: "people",
      label: "Spouses on Medicare",
      help: "Each spouse on Medicare pays the surcharge.",
      options: [
        { value: "1", label: "One" },
        { value: "2", label: "Both" },
      ],
      default: "2",
      showWhen: { key: "status", values: ["married-joint"] },
    },
  ],
};

export const ukFireSpec: ToolSpec = {
  id: "uk-fire",
  path: "/tools/uk-fire-calculator/",
  mode: "instant",
  fields: [
    age(
      "age",
      "Your age now",
      35,
      "Sets your pension ages too. The calculator takes your birthday as January.",
      18,
      75,
    ),
    age(
      "retire",
      "Age you want to stop work",
      50,
      "From here your ISA pays your spending.",
      18,
      100,
    ),
    money("spend", "Yearly spending", 30_000, "In today’s money, after tax."),
    money(
      "isa",
      "ISA and other savings today",
      60_000,
      "ISAs, cash and anything else you can draw before pension age.",
    ),
    money("isaSave", "Yearly saving into ISAs", 15_000, "Added every year until you stop work."),
    money(
      "pension",
      "Pensions today",
      100_000,
      "SIPPs and defined contribution workplace pensions, added together.",
    ),
    money(
      "penSave",
      "Yearly pension contributions",
      10_000,
      "Everything going in: yours, tax relief and your employer’s.",
    ),
    percent(
      "sp",
      "State Pension",
      100,
      "Share of the full new State Pension you expect. Your gov.uk forecast says what you are on track for.",
      0,
      100,
      { step: 1 },
    ),
    realReturnField(4, "Yearly growth after inflation, for both pots."),
    age("planTo", "Plan to age", 95, "The money has to last until this birthday.", 60, 110),
    {
      kind: "select",
      key: "region",
      label: "Where you pay income tax",
      help: "Scottish income tax rates differ from the rest of the UK.",
      options: [
        { value: "ENG", label: "England, Wales or Northern Ireland" },
        { value: "SCT", label: "Scotland" },
      ],
      default: "ENG",
      advanced: true,
    },
    timingField(),
    {
      kind: "select",
      key: "cur",
      label: "Currency",
      help: "UK tax rules work in pounds.",
      options: [{ value: "GBP", label: "Pound sterling (£)" }],
      default: "GBP",
      advanced: true,
    },
  ],
  validate(v) {
    const e: Record<string, string> = {};
    if (n(v, "retire") < n(v, "age")) e.retire = "You cannot stop work before your age now.";
    if (n(v, "planTo") <= n(v, "retire")) e.planTo = "Plan to an age after you stop work.";
    else if (n(v, "planTo") - n(v, "age") > 80) e.planTo = "Keep the plan to 80 years or less.";
    return e;
  },
};

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export const ukPensionAgeSpec: ToolSpec = {
  id: "uk-pension-age",
  path: "/tools/uk-pension-age-calculator/",
  mode: "instant",
  fields: [
    {
      kind: "number",
      key: "by",
      label: "Year of birth",
      unit: "count",
      min: 1960,
      max: 2010,
      step: 1,
      default: 1980,
      help: "Covers births from 1960 to 2010.",
    },
    {
      kind: "select",
      key: "bm",
      label: "Month of birth",
      help: "Some State Pension ages change month by month.",
      options: MONTH_NAMES.map((name, i) => ({ value: String(i + 1), label: name })),
      default: "6",
    },
  ],
};

/**
 * Rule of 55 check (US). The ages and rules are in engine/rule-of-55.ts with their sources; this file
 * holds only the inputs.
 */
export const ruleOf55Spec: ToolSpec = {
  id: "rule-of-55",
  path: "/tools/rule-of-55/",
  mode: "instant",
  fields: [
    {
      kind: "number",
      key: "by",
      label: "Year of birth",
      unit: "count",
      min: 1940,
      max: 2010,
      step: 1,
      default: 1971,
      help: "The rule counts the calendar year you turn 55, not your birthday.",
    },
    {
      kind: "select",
      key: "bm",
      label: "Month of birth",
      help: "Used only for the month you reach 59½.",
      options: MONTH_NAMES.map((name, i) => ({ value: String(i + 1), label: name })),
      default: "6",
    },
    {
      kind: "number",
      key: "leave",
      label: "Year you leave your job",
      unit: "count",
      min: 1990,
      max: 2080,
      step: 1,
      default: 2026,
      help: "The year you stop work, or plan to.",
    },
    {
      kind: "select",
      key: "src",
      label: "Where the money is",
      help: "Rolling a workplace plan into an IRA gives up the rule of 55.",
      options: [
        { value: "this-plan", label: "In the plan of the employer I am leaving" },
        { value: "old-plan", label: "In the plan of an employer I left earlier" },
        { value: "ira", label: "In an IRA (including a rollover IRA)" },
      ],
      default: "this-plan",
    },
    {
      kind: "number",
      key: "oldLeave",
      label: "Year you left that employer",
      unit: "count",
      min: 1960,
      max: 2080,
      step: 1,
      default: 2015,
      help: "What counts is the year you left the employer whose plan holds the money.",
      showWhen: { key: "src", values: ["old-plan"] },
    },
    {
      kind: "select",
      key: "type",
      label: "Type of plan",
      help: "A 457(b) of a state or local government has no 10% additional tax at all.",
      options: [
        { value: "qualified", label: "401(k), 403(b) or other workplace plan" },
        { value: "gov457", label: "457(b) of a state or local government" },
      ],
      default: "qualified",
      showWhen: { key: "src", values: ["this-plan", "old-plan"] },
    },
    {
      kind: "select",
      key: "ps",
      label: "Public safety employee or firefighter?",
      help: "Police, firefighters, EMS, corrections officers and some federal roles in a government plan, or a firefighter in a private plan.",
      options: [
        { value: "no", label: "No" },
        { value: "yes", label: "Yes" },
      ],
      default: "no",
    },
    {
      kind: "number",
      key: "svc",
      label: "Years of service under the plan",
      unit: "years",
      min: 0,
      max: 50,
      step: 1,
      default: 20,
      help: "When you leave. For public safety, 25 years counts even before 50.",
      showWhen: { key: "ps", values: ["yes"] },
    },
  ],
  validate(v) {
    const e: Record<string, string> = {};
    const leaveAge = n(v, "leave") - n(v, "by");
    if (leaveAge < 16) e.leave = "That is before you turn 16.";
    else if (leaveAge > 80) e.leave = "That is after you turn 80.";
    if (v.src === "old-plan") {
      if (n(v, "oldLeave") > n(v, "leave"))
        e.oldLeave = "An earlier employer: no later than the year you leave your job.";
      else if (n(v, "oldLeave") - n(v, "by") < 16) e.oldLeave = "That is before you turn 16.";
    }
    if (v.ps === "yes") {
      const sep = v.src === "old-plan" ? n(v, "oldLeave") : n(v, "leave");
      if (n(v, "svc") > sep - n(v, "by") - 16)
        e.svc = "More years of service than you could have had by then.";
    }
    return e;
  },
};

export const uaeGratuitySpec: ToolSpec = {
  id: "uae-gratuity",
  path: "/tools/uae-gratuity-calculator/",
  mode: "instant",
  fields: [
    yrs(
      "years",
      "Years of service",
      7,
      "Continuous service. Part years count: 7 years 6 months is 7.5.",
      0,
      60,
      { step: 0.01 },
    ),
    money("wage", "Monthly basic wage", 15_000, "Your last basic wage, without allowances.", {
      max: 10_000_000,
    }),
    percent(
      "ret",
      "Savings scheme return",
      0,
      "Yearly return on the scheme fund, for the comparison only. 0% shows contributions alone.",
      -10,
      15,
      { advanced: true },
    ),
    timingField(),
    {
      ...currencyField(),
      default: "AED",
      help: "For display only. The rule is the same in any currency.",
    },
  ],
};

// ------------------------------------------------------------------------------- US tax calculators
// The tax years, filing statuses and bracket rates offered here must match the engine's US tables
// (US_FEDERAL_YEARS, US_ACA_YEARS); us-tax.test.ts checks them, so this file stays free of engine code.

const US_TAX_YEAR = (label: string, help: string): SelectField => ({
  kind: "select",
  key: "year",
  label,
  help,
  options: [
    { value: "2026", label: "2026" },
    { value: "2027", label: "2027" },
  ],
  default: "2026",
});

const FILING_STATUS: SelectField = {
  kind: "select",
  key: "status",
  label: "Filing status",
  help: "Sets the brackets and the standard deduction.",
  options: [
    { value: "married-joint", label: "Married filing jointly" },
    { value: "single", label: "Single" },
    { value: "head-of-household", label: "Head of household" },
    { value: "married-separate", label: "Married filing separately" },
    { value: "qualifying-surviving-spouse", label: "Qualifying surviving spouse" },
  ],
  default: "married-joint",
};

const SPOUSE_AGE = (def: number): NumberField => ({
  ...age(
    "age2",
    "Spouse’s age at the end of the year",
    def,
    "Both ages count for the age-related deductions on a joint return.",
    18,
    110,
  ),
  showWhen: { key: "status", values: ["married-joint"] },
});

export const retirementTaxSpec: ToolSpec = {
  id: "retirement-tax",
  path: "/tools/retirement-tax-calculator/",
  mode: "instant",
  fields: [
    US_TAX_YEAR("Tax year", "The IRS figures published for that year. Enter that year’s amounts."),
    FILING_STATUS,
    age(
      "age",
      "Your age at the end of the year",
      67,
      "Used for the age-related deductions.",
      18,
      110,
    ),
    SPOUSE_AGE(65),
    money(
      "ss",
      "Social Security benefits",
      40_000,
      "Yearly total for everyone on the return. Part of it may be taxable.",
    ),
    money(
      "ira",
      "Traditional IRA and 401(k) withdrawals",
      60_000,
      "Yearly, required minimum distributions included. Taxed as ordinary income.",
    ),
    money("pen", "Pensions and annuities", 0, "The taxable part, yearly."),
    money(
      "int",
      "Interest and other ordinary income",
      2_000,
      "Yearly: bank and bond interest, non-qualified dividends.",
    ),
    money(
      "qd",
      "Qualified dividends and long-term gains",
      6_000,
      "Taxed at the capital gains rates, stacked on top of ordinary income.",
    ),
    money(
      "roth",
      "Roth IRA withdrawals",
      10_000,
      "Treated as qualified, so tax-free. Counted in your total income only.",
    ),
  ],
};

export const rothConversionSpec: ToolSpec = {
  id: "roth-conversion",
  path: "/tools/roth-conversion-calculator/",
  mode: "instant",
  fields: [
    US_TAX_YEAR(
      "Tax year of the conversion",
      "The IRS figures published for that year. The multi-year comparison starts in it.",
    ),
    FILING_STATUS,
    {
      kind: "select",
      key: "target",
      label: "Convert up to the top of",
      help: "The federal bracket your conversions may fill, from the year’s table.",
      options: [
        { value: "10", label: "The 10% bracket" },
        { value: "12", label: "The 12% bracket" },
        { value: "22", label: "The 22% bracket" },
        { value: "24", label: "The 24% bracket" },
        { value: "32", label: "The 32% bracket" },
        { value: "35", label: "The 35% bracket" },
      ],
      default: "12",
    },
    age("age", "Your age at the end of the year", 60, "In whole years.", 18, 100),
    SPOUSE_AGE(60),
    money(
      "ss",
      "Social Security per year",
      40_000,
      "For everyone on the return, in today’s money, from the age below.",
    ),
    age(
      "ssAge",
      "Social Security starts at age",
      67,
      "Your age. If you are already this age, it counts this year.",
      18,
      110,
    ),
    money(
      "inc",
      "Pensions and other ordinary income",
      0,
      "Yearly and taxable, before any conversion: pensions, part-time pay, interest.",
    ),
    money(
      "qd",
      "Qualified dividends and long-term gains",
      0,
      "Yearly. A conversion can push these out of the 0% capital gains band.",
    ),
    money(
      "trad",
      "Traditional IRA and 401(k) balance",
      1_200_000,
      "What could be converted. Used by the multi-year comparison.",
    ),
    money(
      "taxable",
      "Taxable savings",
      250_000,
      "Pays spending and the tax on conversions first in the multi-year comparison.",
    ),
    money("rbal", "Roth IRA balance", 0, "Already in Roth accounts today.", { advanced: true }),
    money("spend", "Yearly spending", 70_000, "In today’s money, for the multi-year comparison."),
    yrs(
      "years",
      "Years of conversions",
      7,
      "How many years, starting in the tax year above.",
      1,
      40,
    ),
    realReturnField(4, "Steady yearly growth after inflation, for the multi-year comparison."),
    age("planTo", "Plan to age", 95, "The comparison runs to this birthday.", 19, 110),
    percent(
      "heir",
      "Tax rate on what is left in traditional accounts",
      25,
      "Used to value what is left at the end after tax. The default is the planner’s heir rate.",
      0,
      60,
      { step: 1, advanced: true },
    ),
  ],
  validate(v) {
    const e: Record<string, string> = {};
    if (n(v, "planTo") <= n(v, "age")) e.planTo = "Plan to an age after your age now.";
    else if (n(v, "planTo") - n(v, "age") > 80) e.planTo = "Keep the plan to 80 years or less.";
    else if (n(v, "years") > n(v, "planTo") - n(v, "age"))
      e.years = "Conversions cannot run past the end of the plan.";
    return e;
  },
};

export const acaSubsidySpec: ToolSpec = {
  id: "aca-subsidy",
  path: "/tools/aca-subsidy-calculator/",
  mode: "instant",
  fields: [
    US_TAX_YEAR(
      "Coverage year",
      "The year you buy Marketplace coverage. Its poverty line and percentages apply.",
    ),
    {
      kind: "number",
      key: "size",
      label: "People in your tax household",
      unit: "count",
      min: 1,
      max: 10,
      step: 1,
      default: 2,
      help: "You, a spouse on a joint return, and anyone you claim as a dependent.",
    },
    money(
      "magi",
      "Household income (MAGI)",
      60_000,
      "Your expected modified adjusted gross income for the coverage year.",
    ),
    money(
      "bench",
      "Benchmark silver premium, per month",
      1_500,
      "The second-lowest-cost silver plan for your household where you live.",
    ),
    money(
      "plan",
      "Premium of the plan you want, per month",
      1_200,
      "Before any credit. Use the benchmark premium if you have not chosen a plan.",
    ),
  ],
};

export const guardrailsSpec: ToolSpec = {
  id: "guardrails",
  path: "/tools/guardrails-retirement-calculator/",
  mode: "simulation",
  fields: [
    money("balance", "Portfolio today", 1_000_000, "Invested savings, in today’s money."),
    money(
      "spend",
      "Yearly spending from it",
      50_000,
      "In today’s money. Spending ÷ portfolio is the withdrawal rate the guardrails are set around.",
    ),
    yrs("years", "Years it must last", 30, "The length of the plan from today.", 5, 60),
    percent(
      "band",
      "Guyton-Klinger guardrail",
      20,
      "How far the withdrawal rate may drift from its starting rate before spending changes. The engine’s default is 20%.",
      5,
      50,
      { step: 1 },
    ),
    percent(
      "adj",
      "Cut or raise by",
      10,
      "The Guyton-Klinger change to spending when a guardrail is crossed. The engine’s default is 10%.",
      1,
      50,
      { step: 1 },
    ),
    { ...STOCKS_HISTORY, help: "Used in every simulation and historical replay." },
    percent(
      "target",
      "Risk-based: target chance of success",
      80,
      "Spending is reset to reach this when the chance leaves the band. The engine’s default is 80%.",
      50,
      99,
      { step: 1, advanced: true },
    ),
    percent(
      "lower",
      "Risk-based: lower guardrail",
      70,
      "Below this chance of success, spending is cut. The engine’s default is 70%.",
      1,
      99,
      { step: 1, advanced: true },
    ),
    percent(
      "upper",
      "Risk-based: upper guardrail",
      95,
      "Above this chance of success, spending is raised. The engine’s default is 95%.",
      1,
      100,
      { step: 1, advanced: true },
    ),
    seedField(),
    taxField("Taken out of each withdrawal before it is spent. Not a country tax estimate."),
    timingField(),
    currencyField(),
  ],
  validate(v) {
    const e: Record<string, string> = {};
    if (n(v, "lower") > n(v, "target"))
      e.lower = "The lower guardrail must be at or below the target.";
    if (n(v, "upper") < n(v, "target"))
      e.upper = "The upper guardrail must be at or above the target.";
    return e;
  },
};

export const retirementSpendingSpec: ToolSpec = {
  id: "retirement-spending",
  path: "/tools/retirement-spending-calculator/",
  mode: "simulation",
  fields: [
    money("balance", "Portfolio", 1_000_000, "Invested savings at the start, in today’s money."),
    age("age", "Your age now", 65, "Spending starts now.", 16, 100),
    age("planTo", "Plan to age", 95, "Every year up to this birthday must be paid.", 17, 110),
    percent(
      "target",
      "Chance every year is paid",
      85,
      "The share of simulations in which every year’s spending is paid in full.",
      50,
      99,
      { step: 1 },
    ),
    money(
      "inc",
      "Pension or other income",
      0,
      "Yearly, after tax, in today’s money, rising with inflation. Use 0 for none.",
    ),
    age(
      "incAge",
      "Income starts at age",
      67,
      "At or before your age now means it has started.",
      16,
      110,
    ),
    {
      kind: "select",
      key: "method",
      label: "Market model",
      help: METHOD_HELP,
      options: [
        { value: "history", label: "US history, random start years" },
        { value: "block", label: "US history, 5-year blocks" },
        { value: "parametric", label: "Random returns (log-normal)" },
      ],
      default: "history",
    },
    { ...STOCKS_HISTORY, showWhen: { key: "method", values: ["history", "block"] } },
    percent(
      "mean",
      "Average return after inflation",
      5,
      "Arithmetic mean of the yearly real return.",
      -5,
      15,
      { showWhen: { key: "method", values: ["parametric"] } },
    ),
    percent("vol", "Volatility", 12, "Standard deviation of the yearly real return.", 0, 40, {
      showWhen: { key: "method", values: ["parametric"] },
    }),
    {
      ...TRIALS("500", ["250", "500", "1000", "2000"]),
      help: "Per candidate spending level; the solver runs about 30 to 40 of them on the same simulations.",
    },
    seedField(),
    taxField("Taken off each withdrawal. Not a country tax estimate."),
    timingField(),
    currencyField(),
  ],
  validate(v) {
    const e: Record<string, string> = {};
    if (n(v, "planTo") <= n(v, "age")) e.planTo = "Plan to an age after your age now.";
    else if (n(v, "planTo") - n(v, "age") > 70) e.planTo = "Keep the plan to 70 years or less.";
    return e;
  },
};

export const historicalBacktestSpec: ToolSpec = {
  id: "historical-backtest",
  path: "/tools/historical-retirement-calculator/",
  mode: "simulation",
  fields: [
    money("balance", "Portfolio at retirement", 1_000_000, "In today’s money."),
    money(
      "spend",
      "Yearly spending",
      40_000,
      "In today’s money. For a percentage rule, spending ÷ portfolio sets the rate.",
    ),
    yrs(
      "years",
      "Years in retirement",
      30,
      "Every start year with this many years of data after it is tested.",
      5,
      70,
    ),
    STOCKS_HISTORY,
    {
      kind: "select",
      key: "rule",
      label: "Spending rule",
      help: "Constant real spending is the classic test. The others are the engine’s withdrawal rules.",
      options: [
        { value: "constant", label: "Constant real spending" },
        { value: "guardrails", label: "Guyton-Klinger guardrails" },
        { value: "percent", label: "Fixed percentage of the portfolio" },
        { value: "vpw", label: "VPW (variable percentage)" },
      ],
      default: "constant",
    },
    money(
      "inc",
      "Pension or other income",
      0,
      "Yearly, after tax, in today’s money. It reduces withdrawals.",
      { advanced: true },
    ),
    yrs(
      "incFrom",
      "Income starts after",
      10,
      "Years from the start of retirement (0 = from the start).",
      0,
      70,
      { advanced: true },
    ),
    taxField("Taken out of each withdrawal before it is spent. Not a country tax estimate."),
    timingField(),
    currencyField(),
  ],
};

// ------------------------------------------------------------------------------------- UK tools

/**
 * The tax year of the UK tools' first plan year (2026/27), from the engine's UK data. Chosen as
 * `pickYear` does, without importing it: its module pulls the account-type table into page scripts.
 */
const UK_YEAR = UK_TAX_YEARS.filter((y) => y.startYear <= 2026).reduce((a, b) =>
  b.startYear > a.startYear ? b : a,
);

const regionField = (): SelectField => ({
  kind: "select",
  key: "region",
  label: "Where you pay income tax",
  help: "Scottish income tax rates apply to pension and earned income in Scotland.",
  options: [
    { value: "ruk", label: "England, Wales or Northern Ireland" },
    { value: "sct", label: "Scotland" },
  ],
  default: "ruk",
});

const statePensionField = (): NumberField =>
  money(
    "sp",
    "State Pension a week",
    UK_YEAR.statePension.fullNewWeekly,
    `Today’s money, from State Pension age. The full new State Pension in ${UK_YEAR.label} is the default; use your forecast, or 0 to leave it out.`,
    { step: 0.01, max: 2_000 },
  );

const inflationField = (): NumberField =>
  percent(
    "infl",
    "Inflation",
    2,
    "Prices rise this much a year. Frozen tax thresholds lose value against it.",
    0,
    10,
    { advanced: true },
  );

export const ukDrawdownSpec: ToolSpec = {
  id: "uk-drawdown",
  path: "/tools/uk-pension-drawdown-calculator/",
  mode: "instant",
  currency: "GBP",
  fields: [
    money(
      "pot",
      "Pension pot",
      300_000,
      "Defined contribution pension (SIPP or workplace), today’s money.",
    ),
    money(
      "income",
      "Income you want after tax",
      25_000,
      "A year, rising with prices, including the State Pension once it starts.",
    ),
    age("age", "Your age now", 60, "Drawdown starts now. Sets your State Pension age.", 50, 99),
    statePensionField(),
    {
      kind: "select",
      key: "tfc",
      label: "Tax-free cash",
      help: "Part of each withdrawal tax-free, or the same share of the pot as a lump sum at the start.",
      options: [
        { value: "ufpls", label: "With each withdrawal (UFPLS)" },
        { value: "pcls", label: "Lump sum at the start" },
      ],
      default: "ufpls",
    },
    realReturnField(3, "Steady yearly growth of the pot after inflation and charges."),
    regionField(),
    money(
      "other",
      "Other pension a year",
      0,
      "Defined benefit or annuity, taxable, today’s money.",
      {
        advanced: true,
      },
    ),
    inflationField(),
    timingField(),
  ],
};

export const isaVsPensionSpec: ToolSpec = {
  id: "isa-vs-pension",
  path: "/tools/isa-vs-pension-calculator/",
  mode: "instant",
  currency: "GBP",
  fields: [
    money(
      "save",
      "Saved a year from take-home pay",
      3_000,
      "The same money into each: the pension adds basic-rate relief on top.",
    ),
    money(
      "salary",
      "Salary before tax",
      40_000,
      "A year, today’s money. Sets your tax band while working.",
    ),
    age("age", "Your age now", 35, "Saving starts now.", 18, 75),
    age("retire", "Retirement age", 67, "Saving stops and drawing starts.", 50, 85),
    age("planTo", "Income lasts to age", 95, "Each pot is drawn evenly until this age.", 60, 110),
    statePensionField(),
    realReturnField(4, "The same steady growth after inflation and charges for both."),
    regionField(),
    inflationField(),
    timingField(),
  ],
  validate: (v) => {
    const e: Record<string, string> = {};
    if (n(v, "retire") <= n(v, "age")) e.retire = "Retirement age must be after your age now.";
    else if (n(v, "planTo") <= n(v, "retire"))
      e.planTo = "The income must last beyond the retirement age.";
    return e;
  },
};

export const SPECS: Record<ToolId, ToolSpec> = {
  "coast-fire": coastSpec,
  fire: fireSpec,
  "fat-fire": fatFireSpec,
  "barista-fire": baristaSpec,
  "how-long": howLongSpec,
  withdrawal: withdrawalSpec,
  "monte-carlo": monteCarloSpec,
  rmd: rmdSpec,
  "sepp-72t": seppSpec,
  "rule-of-55": ruleOf55Spec,
  irmaa: irmaaSpec,
  "uk-fire": ukFireSpec,
  "uk-pension-age": ukPensionAgeSpec,
  "uae-gratuity": uaeGratuitySpec,
  "retirement-tax": retirementTaxSpec,
  "roth-conversion": rothConversionSpec,
  "aca-subsidy": acaSubsidySpec,
  guardrails: guardrailsSpec,
  "retirement-spending": retirementSpendingSpec,
  "historical-backtest": historicalBacktestSpec,
  "uk-drawdown": ukDrawdownSpec,
  "isa-vs-pension": isaVsPensionSpec,
};
