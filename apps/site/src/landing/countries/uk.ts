/**
 * The United Kingdom version of the home page, at /uk/. Written for a UK reader in British English.
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
import { sharedQuestions } from "../shared";
import { formatMoney, richestTaxYear } from "../tax-example";
import type { LandingEntry, Money } from "../types";

const money: Money = { currency: "GBP", symbol: "£", locale: "en-GB" };
const gbp = (n: number) => formatMoney(n, money);
const gbpPence = (n: number) =>
  `£${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const gb = defaultsForCountry("GB");
/** The tax year in force as this page is written (2026/27); its figures come from the cited tables. */
const now = pickYear(UK_TAX_YEARS, 2026);
const [yearStart = gb.taxYear.label, yearEnd = ""] = gb.taxYear.label.split(" to ");
const example = richestTaxYear(createUkSampleDocument(), UK_SAMPLE_PLAN_ID);
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
      "Plan when you can retire in the UK and how much you can spend, with your ISA, SIPP, workplace pension and State Pension, and UK tax estimated every year.",
    ogTitle: "Know when you can retire in the UK",
    ogEyebrow: "UK retirement planner",
    primaryKeyword: "uk retirement planner",
  },
  money,
  hero: {
    eyebrow: "UK retirement planner",
    title: ["Know ", "when you can retire", " in the UK, and how much you can spend."],
    lede: `Glideworth maps out your money year by year, in pounds, with income tax and National Insurance estimated for each UK tax year (${gb.taxYear.label}). It tells you the most you can spend, the earliest you can stop working, and how your ISA, pensions and State Pension carry you there. You type in your numbers; it never asks for a bank login.`,
    priceNote: "Prices are in US dollars.",
    figureCaption:
      "Your plan run through thousands of possible markets, and how often it lasts. Drawn here from illustrative numbers.",
  },
  proof: [
    { value: yearStart, label: `to ${yearEnd}: each plan year follows the UK tax year` },
    {
      value: `${facts.usHistoryFirstYear}–${facts.usHistoryLastYear}`,
      label: "US market history UK plans are tested against by default (see why below)",
    },
    { value: "0", label: "bank logins needed: type in balances or import a file" },
    {
      value: formatPrice(pricing.yearly),
      label: `a year in US dollars, after a ${pricing.trialDays}-day free trial with no card`,
    },
  ],
  questions: sharedQuestions.map((q) =>
    q.title === "When can I retire?"
      ? {
          ...q,
          body: `The earliest date your plan holds up, with no pension money drawn before the minimum pension age (${UK_PENSION_ACCESS.age}, rising to ${UK_PENSION_ACCESS.laterAge} from April ${UK_PENSION_ACCESS.laterFromYear}), and the savings it takes to get there.`,
        }
      : q,
  ),
  working: {
    ticks: [
      "Ask why the plan runs short, where the money went in a given tax year, or what changed between two plans.",
      "A check of your assumptions flags what looks wrong, such as nothing set aside for care in your 80s.",
      "The UK tax estimate lists what it leaves out, next to the result.",
      "The formulas are open, so anyone can check how a number was worked out.",
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
      // Short forms of real entries in the UK simplifications (packages/core/src/tax/data/anglo.ts).
      leavesOut: [
        "Unused pension annual allowance is not carried forward from earlier years",
        "No voluntary Class 2 or Class 3, and no employer National Insurance",
        "Means-tested benefits such as Universal Credit and Pension Credit are not modelled",
      ],
      listed: facts.simplificationCount("uk"),
      caption: `One tax year of Glideworth's synthetic UK sample plan, worked out by the engine when this page was built. Amounts are illustrative, in ${example.year}'s pounds.`,
    },
  },
  taxSection: {
    eyebrow: "Tax",
    title: "UK tax, worked out for every year of your plan.",
    intro: `Glideworth estimates income tax with the personal allowance (${gbp(now.income.personalAllowance)} in ${now.label}) and its taper, the Scottish rates if you live in Scotland, National Insurance until State Pension age, and tax on savings, dividends and gains. It also estimates tax in ${facts.taxCountryCount - 1} other countries, for accounts and income you hold abroad.`,
    foot: "Each person is taxed on their own, as UK law does. These are estimates, not tax advice.",
    footLink: { label: "UK retirement tax, in detail", href: "/planning/uk/" },
  },
  local: {
    accounts: {
      eyebrow: "Your accounts",
      title: "ISA, SIPP and State Pension, by their own names.",
      intro: `You add the accounts you have, and Glideworth applies the UK rules to each. Figures are for ${now.label}, from the tables the tax estimate uses.`,
      items: [
        {
          label: "ISA and Lifetime ISA",
          href: "/tools/isa-vs-pension-calculator/",
          note: `An allowance of ${gbp(now.isa.overall)} a year, with tax-free growth and withdrawals. A Lifetime ISA takes up to ${gbp(now.isa.lisa)} of it, with the government bonus and the charge on early withdrawals.`,
        },
        {
          label: "SIPP and workplace pension",
          href: "/tools/uk-pension-drawdown-calculator/",
          note: `Relief at source, net pay and salary sacrifice; the ${gbp(now.pensions.annualAllowance)} annual allowance with its taper; tax-free cash limited by the lump sum allowance; and no withdrawals before the minimum pension age.`,
        },
        {
          label: "State Pension",
          href: "/tools/uk-pension-age-calculator/",
          note: `Starts at your State Pension age, worked out from your birth month, with deferral and a triple-lock setting. The full new State Pension is ${gbpPence(now.statePension.fullNewWeekly)} a week in ${now.label}.`,
        },
        {
          label: "General investment account",
          href: "/planning/uk/",
          note: "Dividends, interest and gains taxed each year, with the dividend allowance, the personal savings allowance and the capital gains tax annual exempt amount.",
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
          body: `The UK tax model lists ${facts.simplificationCount("uk")} simplifications next to every result. For example, unused pension annual allowance is not carried forward from earlier years, and the household is taken to live in the UK for the whole plan: the statutory residence test is not applied.`,
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
