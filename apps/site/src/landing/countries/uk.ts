/**
 * The United Kingdom version of the home page, at /uk/. Written for a UK reader in British English.
 *
 * Who it is for: people in the UK who want to know when they can stop working, often before State Pension
 * age, and who hold more than one pot (workplace pensions, a SIPP, ISAs, perhaps a final salary pension).
 * The copy follows the questions they ask on UK forums, in their words: can I retire at 55, will my ISA
 * bridge me to my pension, which pot do I draw first, am I in the 60% trap, what about the two of us.
 *
 * Every tax and pension figure on the page is read from @glideworth/core at build time: the 2026/27 row of
 * the UK tax tables (UK_TAX_YEARS, each figure cited there with its gov.uk source), the pension access ages,
 * the country defaults, and a tax year of the synthetic UK sample plan run through the engine. None is
 * typed here.
 */
import { defaultsForCountry, pickYear, UK_PENSION_ACCESS, UK_TAX_YEARS } from "@glideworth/core";
import { createUkSampleDocument, UK_SAMPLE_PLAN_ID } from "@glideworth/core/samples";
import { formatPrice, pricing } from "../../config/pricing";
import { facts } from "../../lib/facts";
import { formatMoney, richestTaxYear } from "../tax-example";
import type { LandingEntry, Money } from "../types";

const money: Money = { currency: "GBP", symbol: "£", locale: "en-GB" };
const gbp = (n: number) => formatMoney(n, money);
const gbpPence = (n: number) =>
  `£${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const gb = defaultsForCountry("GB");
/** The tax year in force as this page is written (2026/27); its figures come from the cited tables. */
const now = pickYear(UK_TAX_YEARS, 2026);
const example = richestTaxYear(createUkSampleDocument(), UK_SAMPLE_PLAN_ID);
const access = UK_PENSION_ACCESS;
const ukLimits = facts.simplificationCount("uk");

/**
 * The personal allowance taper: £1 of allowance is withdrawn for every £2 of adjusted net income above the
 * threshold (the rule the engine applies in packages/core/src/tax/jurisdictions/uk.ts), so the allowance is
 * gone at the threshold plus twice the allowance, and income in that band is taxed at the higher rate plus
 * half of it again. Both numbers follow from the cited 2026/27 row.
 */
const taperStart = now.income.paTaperThreshold;
const taperEnd = now.income.paTaperThreshold + 2 * now.income.personalAllowance;
const taperRate = `${Math.round(now.income.rates.higher * 1.5 * 100)}%`;
/** Income tax thresholds stay frozen through the tax year starting in `frozenThrough`, so to the April after. */
const frozenUntil = now.income.frozenThrough + 1;

/** What each engine tax line is charged on, in HMRC's terms. */
function chargedOn(kind: string, label: string): string {
  if (kind === "income") return /savings/i.test(label) ? "Savings income" : "Non-savings income";
  if (kind === "dividends") return "Dividends";
  if (kind === "payroll") return "Earnings";
  if (kind === "capital-gains") return "Gains";
  return "Other";
}

export const uk: LandingEntry = {
  code: "GB",
  slug: "uk",
  hreflang: "en-GB",
  countryName: "United Kingdom",
  label: "UK",
  lang: "en-GB",
  ogLocale: "en_GB",
  seo: {
    title: "UK retirement planner: pensions, ISAs and tax",
    description:
      "A UK retirement planner for every pension, ISA and the State Pension: see when you can retire and what you can spend, with UK tax worked out for each tax year.",
    ogTitle: "Know when you can retire, with every pension and ISA in one plan",
    ogEyebrow: "UK retirement planner",
    primaryKeyword: "uk retirement planner",
  },
  money,
  hero: {
    eyebrow: "UK retirement planner",
    title: ["Know ", "when you can retire", ", with every pension and ISA in one plan."],
    lede: `Your workplace pensions, SIPP, ISAs, any final salary pension and your State Pension, for you or the two of you, mapped out year by year in pounds with UK tax. Glideworth finds the earliest date you can stop working, the most you can spend, and whether your ISA bridges the years until your pension opens at ${access.age} (${access.laterAge} from April ${access.laterFromYear}). You type in your numbers; it never asks for a bank login.`,
    priceNote:
      "Prices are in US dollars. The demo is a US household; the trial offers a UK sample.",
    figureCaption: `Your plan run through thousands of possible markets, and how often the money lasts. UK plans are tested against US market history by default (see why below). Drawn here from illustrative numbers.`,
  },
  proof: [
    {
      value: `${access.age}→${access.laterAge}`,
      label: `the minimum pension age, applied from your birth date, so no pension is drawn too early`,
    },
    {
      value: String(ukLimits),
      label: "things the UK tax estimate leaves out, listed next to every result",
    },
    { value: "0", label: "bank logins needed: type in balances or import a file" },
    {
      value: formatPrice(pricing.yearly),
      label: `a year in US dollars, after a ${pricing.trialDays}-day free trial with no card`,
    },
  ],
  questions: [
    {
      glyph: "solver",
      title: "When can I retire?",
      body: `The earliest date your plan holds up, and whether your ISA and other savings bridge the years until your pension opens at ${access.age} (${access.laterAge} from April ${access.laterFromYear}) and your State Pension starts.`,
      href: "/features/solvers/",
    },
    {
      glyph: "fan",
      title: "How much can I spend?",
      body: "The most you can spend each year after tax and still have the plan last, at the level of confidence you choose, instead of a rule of thumb like 4%.",
      href: "/features/solvers/",
    },
    {
      glyph: "ledger",
      title: "Which pot do I draw first?",
      body: `Set the order of cash, investments, ISA and pension, and take tax-free cash up front or with each withdrawal. See what each order costs in income tax, and in inheritance tax now that unused pensions count in the estate from April ${now.iht.pensionsInEstateFrom}.`,
      href: "/features/withdrawal-strategies/",
    },
    {
      glyph: "ledger",
      title: `Am I in the ${taperRate} trap?`,
      body: `Each year's tax shows when income between ${gbp(taperStart)} and ${gbp(taperEnd)} is losing the personal allowance. Try a what-if with more paid into your pension, by salary sacrifice or otherwise, and compare the tax.`,
      href: "/features/tax-estimates/",
    },
    {
      glyph: "people",
      title: "What about the two of us?",
      body: "Plan as a couple: each of you is taxed on your own, with your own pension age and State Pension, and you can see what happens to the other if one of you dies.",
      href: "/features/sharing-and-roles/",
    },
    {
      glyph: "branch",
      title: "Am I still on track?",
      body: "Update your balances now and then to see actual against plan, and check-ins tell you when your chance of success or a milestone moves.",
      href: "/features/progress-and-check-ins/",
    },
  ],
  working: {
    ticks: [
      "Find the tax year and the line behind any surprise: why the money runs short in 2041, or what changed between two plans.",
      "A check of your assumptions flags what looks wrong, such as nothing set aside for care in your 80s.",
      "The UK tax estimate lists what it leaves out, next to the result.",
      "The formulas are open, so you can check a number the way you would check your own spreadsheet.",
    ],
    taxYear: {
      title: `Tax in ${example.label}`,
      subtitle: "United Kingdom, one person working in England",
      levelHeading: "Charged on",
      lines: example.lines.map((l) => ({
        label: l.label,
        level: chargedOn(l.kind, l.label),
        amount: l.amount,
      })),
      leavesOut: [
        "Unused pension annual allowance is not carried forward from earlier years",
        "No voluntary Class 2 or Class 3, and no employer National Insurance",
        "Means-tested benefits such as Universal Credit and Pension Credit are not modelled",
      ],
      listed: ukLimits,
      caption: `One tax year of Glideworth's synthetic UK sample plan, worked out by the engine when this page was built. Amounts are illustrative, in ${example.year}'s pounds.`,
    },
  },
  taxSection: {
    eyebrow: "Tax",
    title: "UK tax, worked out for every year of your plan.",
    intro: `Income tax with the personal allowance (${gbp(now.income.personalAllowance)} in ${now.label}) and its withdrawal above ${gbp(taperStart)}, thresholds frozen until April ${frozenUntil} and indexed after that, the Scottish rates if you live in Scotland, National Insurance until State Pension age, and tax on savings, dividends and gains. Pension withdrawals are taxed as income after the tax-free share. Glideworth also estimates tax in ${facts.taxCountryCount - 1} other countries, for accounts and income you hold abroad.`,
    foot: "Each person is taxed on their own, as UK law does. These are estimates from planning software, not tax or financial advice, and Glideworth sells no financial products.",
    footLink: { label: "UK retirement tax, in detail", href: "/planning/uk/" },
  },
  local: {
    accounts: {
      eyebrow: "Your pots",
      title: "ISAs, pensions and the State Pension, by their own names.",
      intro: `You add the pots you have, and Glideworth applies the UK rules to each. Figures are for ${now.label}, from the tables the tax estimate uses.`,
      items: [
        {
          label: "ISA and Lifetime ISA",
          href: "/tools/isa-vs-pension-calculator/",
          note: `An allowance of ${gbp(now.isa.overall)} a year, with tax-free growth and withdrawals at any age, so it can pay the years before your pension opens. A Lifetime ISA takes up to ${gbp(now.isa.lisa)} of it, with the government bonus and the charge on early withdrawals.`,
        },
        {
          label: "SIPP and workplace pension",
          href: "/tools/uk-pension-drawdown-calculator/",
          note: `Relief at source, net pay and salary sacrifice; the ${gbp(now.pensions.annualAllowance)} annual allowance with its taper; tax-free cash up to the ${gbp(now.pensions.lumpSumAllowance)} lump sum allowance; and no withdrawals before the minimum pension age.`,
        },
        {
          label: "State Pension",
          href: "/tools/uk-pension-age-calculator/",
          note: `Starts at your State Pension age, worked out from your birth month, with deferral and a triple-lock setting. The full new State Pension is ${gbpPence(now.statePension.fullNewWeekly)} a week in ${now.label}; enter your own forecast if it differs.`,
        },
        {
          label: "Final salary pension and annuities",
          href: "/features/plan-modelling/",
          note: "A defined benefit pension as a final salary or career average income from the age it starts, rising with inflation or a rate you set, with a share for a surviving partner. An annuity is an income you add from the date it starts.",
        },
        {
          label: "General investment account",
          href: "/planning/uk/",
          note: "For money beyond your ISA allowance: dividends, interest and gains taxed each year, with the dividend allowance, the personal savings allowance and the capital gains tax annual exempt amount.",
        },
        {
          label: "Your estate",
          href: "/planning/uk/",
          note: `An inheritance tax estimate with the nil-rate and residence nil-rate bands, transfers between spouses, and unused pensions counted in the estate from April ${now.iht.pensionsInEstateFrom}.`,
        },
      ],
    },
    tools: {
      title: "Free calculators for UK plans",
      intro:
        "Quick answers in your browser, with no sign-up. The UK calculators use the same tax tables as the planner; the others work in any currency (choose pounds under the advanced settings).",
      ids: [
        "uk-fire",
        "isa-vs-pension",
        "uk-drawdown",
        "uk-pension-age",
        "fire",
        "coast-fire",
        "how-long",
        "monte-carlo",
      ],
    },
    notes: {
      title: "Before you rely on a UK plan",
      intro: "What Glideworth itself says about UK plans, limits included.",
      items: [
        {
          title: "Market history: US by default",
          body: gb.monteCarlo.note,
        },
        {
          title: "An estimate with its limits written down",
          body: `The UK tax model lists ${ukLimits} simplifications next to every result. For example, unused pension annual allowance is not carried forward from earlier years, and the household is taken to live in the UK for the whole plan: the statutory residence test is not applied.`,
        },
        {
          title: "Guidance software, not advice",
          body: "Glideworth shows what your own numbers and assumptions lead to. It is not regulated financial advice and does not recommend products. For free, impartial guidance on your pension options, the government's MoneyHelper service runs Pension Wise; for a personal recommendation, see a regulated financial adviser.",
        },
      ],
    },
    reading: {
      title: "Read more about UK plans",
      links: [
        {
          label: "UK retirement tax",
          href: "/planning/uk/",
          note: "How Glideworth models income tax, National Insurance, pensions, ISAs, the State Pension and inheritance tax, with the official sources.",
        },
        {
          label: "Do you pay tax on the State Pension?",
          href: "/blog/do-you-pay-tax-on-the-state-pension/",
        },
        {
          label: "FIRE number: the 25x rule and its limits",
          href: "/blog/what-is-your-fire-number/",
        },
      ],
    },
  },
  priceNote: "Prices are in US dollars; there are no prices in pounds.",
};
