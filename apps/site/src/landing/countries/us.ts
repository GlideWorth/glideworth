/**
 * The United States version of the home page, served at `/` (src/pages/index.astro). It is the default
 * for everyone: no visitor is redirected away from it.
 */
import { pages } from "../../config/pages";
import { formatPrice, pricing } from "../../config/pricing";
import { facts } from "../../lib/facts";
import type { LandingEntry } from "../types";
import { sharedQuestions } from "../shared";

const home = pages["/"];
const n = facts.taxCountryCount;

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
  money: { currency: "USD", symbol: "$", locale: "en-US" },
  hero: {
    eyebrow: "Retirement and FIRE planner",
    title: ["Know ", "when you can retire", ", and how much you can spend."],
    lede: "Glideworth maps out your money year by year, with tax estimated in every year. It tells you the most you can spend, the earliest you can stop working, and why your plan falls short if it does. You type in your numbers; it never asks for a bank login.",
    figureCaption:
      "Your plan run through thousands of possible markets, and how often it lasts. Drawn here from illustrative numbers.",
  },
  proof: [
    { value: String(n), label: "countries with tax estimates built in" },
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
  questions: sharedQuestions,
  working: {
    ticks: [
      "Ask why the plan runs short, where the money went in a given year, or what changed between two plans.",
      "A check of your assumptions flags what looks wrong, such as nothing set aside for care in your 80s.",
      "Each country's tax estimate lists what it leaves out, next to the result.",
      "The formulas are open, so anyone can check how a number was worked out.",
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
        "The SALT cap and limits on itemised deductions are not applied automatically",
        "No earned income, education or child and dependent care credits",
        "Employer payroll taxes are not modelled",
      ],
      listed:
        facts.simplificationCount("us-federal") +
        facts.simplificationCount("us-payroll") +
        facts.simplificationCount("us-state"),
      caption: "One plan year's tax, as Glideworth lays it out. Amounts are illustrative.",
    },
  },
  taxSection: {
    eyebrow: "Tax",
    title: "Tax estimates for your country.",
    intro: `Tax can decide whether a plan works. Glideworth estimates the tax in every year of your plan for ${n} countries, each for stated tax years and with a written list of what it leaves out.`,
    foot: "Flat or custom rates cover anywhere else. The United States includes federal tax, payroll tax, every state and DC, and some cities. These are estimates, not tax advice.",
    footLink: { label: "How each country is modelled", href: "/planning/" },
  },
};
