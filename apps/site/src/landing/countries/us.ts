/**
 * The United States version of the home page, served at `/` (src/pages/index.astro). It is the default
 * for everyone: no visitor is redirected away from it. Written for a US reader in American English: a
 * FIRE-minded saver or a near-retiree who has outgrown a spreadsheet or a 4% calculator.
 *
 * Every limit and count on the page is read from @glideworth/core at build time: the 2026 contribution
 * limits (US_LIMITS_2026, each figure cited there with its IRS source), the RMD start ages, the state and
 * city tables, the country defaults and the written simplifications. None is typed here, except the
 * illustrative tax year below (see its comment).
 */
import {
  defaultsForCountry,
  US_LIMITS_2026,
  US_LOCALS_2026,
  US_STATES_2026,
  usRmdStartAge,
} from "@glideworth/core";
import { pages } from "../../config/pages";
import { formatPrice, pricing } from "../../config/pricing";
import { facts } from "../../lib/facts";
import { sharedQuestions } from "../shared";
import { formatMoney } from "../tax-example";
import type { LandingEntry, Money } from "../types";

const home = pages["/"];
const money: Money = { currency: "USD", symbol: "$", locale: "en-US" };
const usd = (n: number) => formatMoney(n, money);

const usDefaults = defaultsForCountry("US");
const limits = US_LIMITS_2026;
/** The states in the tax tables, without DC (which the table also holds). */
const states = US_STATES_2026.filter((s) => s.code !== "DC").length;
const hasDc = US_STATES_2026.some((s) => s.code === "DC");
const cities = US_LOCALS_2026.map((l) => l.name);
const cityList = `${cities.slice(0, -1).join(", ")} and ${cities.at(-1)}`;
/** RMDs start at 73 for people born 1951-1959 and at 75 from 1960 (SECURE 2.0, in core). */
const rmdAges = `${usRmdStartAge(1955)} or ${usRmdStartAge(1965)}`;
const usSimplifications =
  facts.simplificationCount("us-federal") +
  facts.simplificationCount("us-payroll") +
  facts.simplificationCount("us-state");

const QUESTION_BODIES: Record<string, string> = {
  "When can I retire?":
    "The earliest date your plan holds up, years before 59½ included, the savings it takes to get there, and a withdrawal rate that lasts.",
  "What if we do it differently?":
    "Copy your plan into a what-if, such as retiring at 52 instead of 57 or claiming Social Security at 70 instead of 62, and compare the two side by side.",
};

export const us: LandingEntry = {
  code: "US",
  slug: "",
  hreflang: "en-US",
  countryName: "United States",
  label: "US",
  ogLocale: "en_US",
  seo: {
    title: home.title,
    description: home.description,
    ogTitle: home.ogTitle,
    ogEyebrow: home.ogEyebrow,
    primaryKeyword: "retirement and fire planner",
  },
  money,
  hero: {
    eyebrow: "Retirement and FIRE planner",
    title: ["Know ", "when you can retire", ", and how much you can spend."],
    lede: "Glideworth maps out your money year by year, with federal, state and payroll tax in every year. It finds the most you can spend and the earliest you can stop working, plans your 401(k), IRAs and brokerage account through 59½, Social Security and Medicare, and shows why a plan falls short. You type in your numbers; it never asks for a bank login.",
    figureCaption:
      "Your plan run through thousands of possible markets, and how often it lasts. Drawn here from illustrative numbers.",
  },
  proof: [
    {
      value: hasDc ? `${states} + DC` : String(states),
      label: "state tax tables, each worked out on top of federal and payroll tax",
    },
    {
      value: `${facts.usHistoryFirstYear}–${facts.usHistoryLastYear}`,
      label: "US market history your plan is tested against",
    },
    { value: "0", label: "bank logins needed: type in balances or import a file" },
    {
      value: formatPrice(pricing.yearly),
      label: `a year, after a ${pricing.trialDays}-day free trial with no card`,
    },
  ],
  questions: sharedQuestions.map((q) =>
    QUESTION_BODIES[q.title] ? { ...q, body: QUESTION_BODIES[q.title]! } : q,
  ),
  working: {
    ticks: [
      "Ask why the plan runs short, where the money went in a given year, or what changed between two plans.",
      "A Roth conversion plan picks an amount for each year that fills the tax bracket you choose while staying under the IRMAA tier you pick and, with marketplace cover, the ACA subsidy cliff, and says why.",
      "A check of your assumptions flags what looks wrong, such as nothing set aside for care in your 80s.",
      "The tax estimate lists what it leaves out, next to the result, and the formulas are open, so anyone can check how a number was worked out.",
    ],
    /**
     * The 2034 year (future dollars) of the synthetic US sample household (createSampleDocument in
     * packages/core: a married couple filing jointly in Colorado) with its tax switched from flat rates to
     * the full estimate, rounded to the dollar. They move when the engine or the tax tables change, so the
     * visual calls them illustrative. The "leaves out" lines are real entries from the US simplifications
     * (packages/core/src/tax/data/anglo.ts).
     */
    taxYear: {
      title: "Tax in 2034",
      subtitle: "United States, married filing jointly in Colorado",
      levelHeading: "Level",
      lines: [
        { label: "Federal income tax", level: "Federal", amount: 24_539 },
        { label: "Qualified dividends tax", level: "Federal", amount: 740 },
        { label: "Child tax credit", level: "Federal", amount: -2_734 },
        { label: "Social Security tax", level: "Payroll", amount: 14_433 },
        { label: "Medicare tax", level: "Payroll", amount: 3_376 },
        { label: "Colorado income tax", level: "State", amount: 7_720 },
      ],
      leavesOut: [
        "The SALT cap and limits on itemized deductions are not applied automatically",
        "No earned income, education or child and dependent care credits",
        "Employer payroll taxes are not modeled",
      ],
      listed: usSimplifications,
      caption: "One plan year's tax, as Glideworth lays it out. Amounts are illustrative.",
    },
  },
  taxSection: {
    eyebrow: "Tax",
    title: "Federal, state and payroll tax, worked out for every year of your plan.",
    intro: `Glideworth estimates federal income tax with the taxable part of Social Security, long-term gains and qualified dividends, and the net investment income tax; payroll tax while you work; the 10% early-withdrawal penalty on accounts you set it for, with 72(t) payments exempt; Medicare IRMAA surcharges from your income two years earlier; the ACA premium tax credit; and state income tax for all ${states} states${hasDc ? " and DC" : ""}, plus ${cityList}. It also estimates tax in ${facts.taxCountryCount - 1} other countries, for accounts and income you hold abroad.`,
    foot: `Tax years ${limits.year} and ${limits.year + 1} use the IRS's published figures; later years index the thresholds the law indexes, IRMAA tiers included, rather than freezing them. These are estimates, not tax advice.`,
    footLink: { label: "US retirement tax, in detail", href: "/planning/us/" },
  },
  local: {
    accounts: {
      eyebrow: "Your accounts",
      title: "401(k), IRA, HSA and Social Security, by their own names.",
      intro: `You add the accounts you have, and Glideworth applies the US rules to each. Limits are for ${limits.year}, from the IRS figures the tax estimate uses.`,
      items: [
        {
          label: "401(k), 403(b) and 457(b)",
          href: "/tools/rule-of-55/",
          note: `Traditional and Roth, with the ${usd(limits.electiveDeferral)} employee limit and catch-up contributions from 50. Required minimum distributions start at ${rmdAges}, depending on your birth year, and 72(t) payments can bridge the years before 59½.`,
        },
        {
          label: "Traditional and Roth IRA",
          href: "/tools/roth-conversion-calculator/",
          note: `Up to ${usd(limits.ira)} a year, with the traditional IRA deduction phase-out and the Roth five-year rule. Roth conversions are taxed in the year you make them, and the planner can suggest how much to convert each year.`,
        },
        {
          label: "HSA",
          href: "/planning/us/",
          note: `Up to ${usd(limits.hsa.self)} with self-only cover or ${usd(limits.hsa.family)} with family cover, plus ${usd(limits.hsa.catchUp55)} from 55. Withdrawals for healthcare and long-term care costs come out tax-free.`,
        },
        {
          label: "Social Security",
          href: "/tools/social-security-break-even-calculator/",
          note: "Enter the benefit at full retirement age and the age you claim, from 62 to 70. Glideworth applies the early-claiming reduction or the delayed credits, a spouse's benefit, and the tax on benefits.",
        },
      ],
    },
    tools: {
      title: "Free calculators for US plans",
      intro:
        "Quick answers in your browser, with no sign-up. The US calculators use the same tax tables as the planner.",
      ids: [
        "roth-conversion",
        "aca-subsidy",
        "rule-of-55",
        "sepp-72t",
        "social-security",
        "irmaa",
        "rmd",
        "fire",
      ],
    },
    notes: {
      title: "Before you rely on a US plan",
      intro: "What Glideworth itself says about US plans, limits included.",
      items: [
        {
          title: "Set your state",
          body: `${usDefaults.tax.note} Each state has its own brackets, deductions and treatment of Social Security, pensions and IRA withdrawals.`,
        },
        {
          title: "An estimate with its limits written down",
          body: `The US tax model lists ${usSimplifications} simplifications next to every result. For example, the SALT cap and limits on itemized deductions are not applied automatically, there is no earned income or education credit, and for the ACA credit you enter the benchmark silver premium yourself.`,
        },
        {
          title: "Roth conversions: a good plan, not a proven best",
          body: "The Roth conversion plan chooses a bracket for each block of years by trying alternatives and keeping what improves the result. It is not a search of every possible schedule, so treat it as a starting point to compare against.",
        },
        {
          title: "Market history",
          body: `${usDefaults.monteCarlo.note} Monte Carlo draws from it by default; other methods are under the advanced settings.`,
        },
      ],
    },
    reading: {
      title: "Read more about US plans",
      links: [
        {
          label: "US retirement tax",
          href: "/planning/us/",
          note: "How Glideworth models federal, payroll, state and city tax, account limits and access ages, and Social Security, with the official sources.",
        },
        {
          label: "FIRE number: the 25x rule and its limits",
          href: "/blog/what-is-your-fire-number/",
        },
        {
          label: "Withdrawal strategies: four rules compared",
          href: "/blog/withdrawal-strategies-compared/",
        },
        {
          label: "Glideworth and ProjectionLab compared",
          href: "/compare/projectionlab/",
        },
        {
          label: "Glideworth and Boldin compared",
          href: "/compare/boldin/",
        },
      ],
    },
  },
};
