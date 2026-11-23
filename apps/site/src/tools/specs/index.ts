/**
 * Input definitions of every calculator: labels, units, ranges, defaults and helper text. No engine
 * code here, so a page script can import its spec without pulling in the engine.
 */
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

export const SPECS: Record<ToolId, ToolSpec> = {
  "coast-fire": coastSpec,
  fire: fireSpec,
  "fat-fire": fatFireSpec,
  "barista-fire": baristaSpec,
  "how-long": howLongSpec,
  withdrawal: withdrawalSpec,
  "monte-carlo": monteCarloSpec,
};
