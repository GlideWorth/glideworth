/**
 * The Australian version of the home page, at /au/. Written for an Australian reader in Australian English.
 *
 * Every tax and super figure on the page is read from @glideworth/core at build time: the 2026-27 row of the
 * Australian tables (AU_YEARS, each figure cited there with its legislation or ATO source), the minimum
 * pension drawdown rates (auMinimumDrawdownRate), the country defaults and TAX_SIMPLIFICATIONS. None is typed
 * here.
 *
 * There is no Australian sample plan in @glideworth/core/samples, so the page draws no tax-year example
 * (`working.taxYear` is left out). The Age Pension is not modelled (defaultsForCountry("AU").statePension is
 * null), so the page says so instead of describing it.
 */
import { auMinimumDrawdownRate, AU_YEARS, defaultsForCountry, pickYear } from "@glideworth/core";
import { formatPrice, pricing } from "../../config/pricing";
import { facts } from "../../lib/facts";
import { sharedQuestions } from "../shared";
import { formatMoney } from "../tax-example";
import type { LandingEntry, Money } from "../types";

const money: Money = { currency: "AUD", symbol: "A$", locale: "en-AU" };
const aud = (n: number) => formatMoney(n, money);
const pct = (r: number) => `${Math.round(r * 1000) / 10}%`;

const auDefaults = defaultsForCountry("AU");
/** The financial year in force as this page is written (2026-27); its figures come from the cited tables. */
const now = pickYear(AU_YEARS, 2026);
const S = now.super;
const [yearStart = auDefaults.taxYear.label, yearEnd = ""] = auDefaults.taxYear.label.split(" to ");

/** The minimum drawdown rate bands, read from the engine's table by age (no age or rate typed here). */
const drawdownBands: { from: number; rate: number }[] = [];
for (let age = S.preservationAge; age <= 110; age++) {
  const rate = auMinimumDrawdownRate(age);
  if (drawdownBands.at(-1)?.rate !== rate) drawdownBands.push({ from: age, rate });
}
const firstBand = drawdownBands[0]!;
const secondBand = drawdownBands[1] ?? firstBand;
const lastBand = drawdownBands.at(-1)!;

/** How many simplifications the Australian tax model lists (TAX_SIMPLIFICATIONS.au). */
const auSimplifications = facts.simplificationCount("au");

export const au: LandingEntry = {
  code: "AU",
  slug: "au",
  hreflang: "en-AU",
  countryName: "Australia",
  label: "Australia",
  lang: "en-AU",
  ogLocale: "en_AU",
  seo: {
    title: "Retirement planner Australia: super, tax, FIRE",
    description:
      "Plan when you can retire in Australia and how much you can spend, with super, an account-based pension, franked dividends and tax for each financial year.",
    ogTitle: "Know when you can retire in Australia",
    ogEyebrow: "Retirement planner for Australia",
    primaryKeyword: "retirement planner australia",
  },
  money,
  hero: {
    eyebrow: "Retirement planner for Australia",
    title: ["Know ", "when you can retire", " in Australia, and how much you can spend."],
    lede: `Glideworth maps out your money year by year, in Australian dollars, with income tax, the Medicare levy and super tax estimated for each financial year (${auDefaults.taxYear.label}). It tells you the most you can spend, the earliest you can stop working, and how your super, your account-based pension and your investments outside super carry you there. You type in your numbers; it never asks for a bank login.`,
    priceNote: "Prices are in US dollars.",
    figureCaption:
      "Your plan run through thousands of possible markets, and how often it lasts. Drawn here from illustrative numbers.",
  },
  proof: [
    {
      value: yearStart,
      label: `to ${yearEnd}: each plan year follows the Australian financial year`,
    },
    {
      value: `${facts.usHistoryFirstYear}–${facts.usHistoryLastYear}`,
      label: "US market history Australian plans are tested against (see why below)",
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
          body: `The earliest date your plan holds up, with no super drawn before your preservation age (${S.preservationAge}), so the years before it are paid from savings and investments outside super, and the savings it takes to get there.`,
        }
      : q,
  ),
  working: {
    ticks: [
      "Ask why the plan runs short, where the money went in a given financial year, or what changed between two plans.",
      "A check of your assumptions flags what looks wrong, such as nothing set aside for aged care in your 80s.",
      "The Australian tax estimate lists what it leaves out, next to the result.",
      "The formulas are open, so anyone can check how a number was worked out.",
    ],
  },
  taxSection: {
    eyebrow: "Tax",
    title: "Australian tax, worked out for every year of your plan.",
    intro: `Glideworth estimates resident income tax with the tax-free threshold and the low income tax offset (up to ${aud(now.lito.max)} in ${now.label}), the Medicare levy (${pct(now.medicare.rate)}, with the low-income shade-in), franking credits on Australian dividends, and capital gains with the ${pct(now.cgtDiscount)} discount. Rates follow the legislated changes year by year. It also estimates tax in ${facts.taxCountryCount - 1} other countries, for accounts and income you hold abroad.`,
    foot: "Each person is taxed on their own, as Australian law does. These are estimates, not tax advice.",
    footLink: { label: "Australian retirement tax, in detail", href: "/planning/au/" },
  },
  local: {
    accounts: {
      eyebrow: "Your accounts",
      title: "Super, account-based pensions and shares, by their own names.",
      intro: `You add the accounts you have, and Glideworth applies the Australian rules to each. Take Mia and Josh, a made-up couple in Brisbane in their late forties: they each have super in accumulation, a share portfolio paying franked dividends, and a mortgage nearly paid off. Glideworth shows whether the shares can carry them from the day they stop work to preservation age, and what an account-based pension pays after that. Figures are for ${now.label}, from the tables the tax estimate uses.`,
      items: [
        {
          label: "Super in accumulation",
          href: "/planning/au/",
          note: `Concessional contributions taxed at ${pct(S.contributionsTax)} in the fund, within the ${aud(S.concessionalCap)} concessional cap, with Division 293 tax once income and concessional contributions pass ${aud(S.div293Threshold)} and tax on excess concessional contributions. No withdrawals before preservation age (${S.preservationAge}); benefits are tax-free from ${S.taxFreeAge}.`,
        },
        {
          label: "Account-based pension",
          href: "/blog/minimum-pension-drawdown-rates-australia/",
          note: `Super in the pension phase: earnings untaxed, and at least the minimum drawn each year, from ${pct(firstBand.rate)} of the balance before ${secondBand.from} to ${pct(lastBand.rate)} from ${lastBand.from}. The transfer balance cap is not modelled.`,
        },
        {
          label: "Shares and investments outside super",
          href: "/planning/au/",
          note: `Dividends grossed up with franking credits (at the ${pct(now.franking.corporateRate)} company rate), interest taxed as income, and capital gains with the ${pct(now.cgtDiscount)} discount. Your main home is exempt when you sell it.`,
        },
        {
          label: "Age Pension",
          href: "/blog/sapto-how-much-can-a-pensioner-earn-tax-free/",
          note: "Not worked out for you: Glideworth does not apply the Age Pension's income and assets tests. If you expect it, enter it as income from the age and at the amount you expect.",
        },
      ],
    },
    tools: {
      title: "Free calculators for Australian plans",
      intro:
        "Quick answers in your browser, with no sign-up. None of them has Australian tax or super rules built in; they work in any currency (choose Australian dollars under the advanced settings). The planner applies the Australian rules.",
      ids: [
        "fire",
        "coast-fire",
        "barista-fire",
        "how-long",
        "withdrawal",
        "guardrails",
        "monte-carlo",
        "historical-backtest",
      ],
    },
    notes: {
      title: "Before you rely on an Australian plan",
      intro: "What Glideworth itself says about Australian plans, limits included.",
      items: [
        {
          title: "Market history: US by default",
          body: auDefaults.monteCarlo.note,
        },
        {
          title: "No Age Pension model",
          body: "Glideworth does not estimate the Age Pension or apply its income and assets tests, so it does not cut the pension as your super grows. Enter the amount you expect as income, and check it against Services Australia's rules.",
        },
        {
          title: "An estimate with its limits written down",
          body: `The Australian tax model lists ${auSimplifications} simplifications next to every result. For example, SAPTO (the seniors and pensioners tax offset), HELP repayments, the Medicare levy surcharge and family Medicare thresholds are not modelled, nor carry-forward of unused concessional cap, the transfer balance cap or Division 296 tax on large super balances. The household is taken to live in Australia for the whole plan.`,
        },
      ],
    },
    reading: {
      title: "Read more about Australian plans",
      links: [
        {
          label: "Retirement tax in Australia",
          href: "/planning/au/",
          note: "How Glideworth models income tax, the Medicare levy, franking, capital gains and super, with the official sources.",
        },
        {
          label: "Minimum pension drawdown rates in Australia",
          href: "/blog/minimum-pension-drawdown-rates-australia/",
        },
        {
          label: "SAPTO: how much can a pensioner earn tax-free?",
          href: "/blog/sapto-how-much-can-a-pensioner-earn-tax-free/",
        },
        {
          label: "FIRE number: the 25x rule and its limits",
          href: "/blog/what-is-your-fire-number/",
        },
      ],
    },
  },
  priceNote: "Prices are in US dollars; there are no prices in Australian dollars.",
  closingPriceNote: "Prices are in US dollars.",
};
