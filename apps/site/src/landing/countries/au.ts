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
 * null), so the page says so instead of describing it, and frames the page for plans that live mainly on
 * their own savings (the evidence and the positioning are in the pull request that rewrote this copy).
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
    title: "Retirement planner Australia: plan it yourself",
    description: `Plan your own retirement in Australia: when you can stop work, how savings outside super bridge the years to ${S.preservationAge}, and tax in each financial year.`,
    ogTitle: "Know when you can retire, and how you bridge the gap to super",
    ogEyebrow: "Retirement planning software for Australia",
    primaryKeyword: "retirement planner australia",
  },
  money,
  hero: {
    eyebrow: "Retirement planning software for Australia",
    title: [
      "Know ",
      "when you can retire",
      `, and how you bridge the gap to super at ${S.preservationAge}.`,
    ],
    lede: "For Australians who plan to live mainly on their own savings. Enter your super, your ETFs and shares outside super, and what you spend: Glideworth finds the earliest year you can stop work and the most you can spend, with income tax, the Medicare levy, super contributions tax and franking credits worked out for every financial year, in Australian dollars. You plan it yourself, with no bank login. It does not estimate the Age Pension.",
    priceNote: "Prices are in US dollars.",
    figureCaption: `Your plan run through a thousand possible markets (US history ${facts.usHistoryFirstYear}–${facts.usHistoryLastYear} by default, or returns you set), and how often it lasts. Illustrative numbers.`,
  },
  proof: [
    {
      value: `${S.preservationAge}`,
      label: "preservation age: the plan pays the years before it from savings outside super",
    },
    {
      value: yearStart,
      label: `to ${yearEnd}: each plan year follows the Australian financial year`,
    },
    {
      value: `${auSimplifications}`,
      label: "simplifications in the Australian tax estimate, listed next to your results",
    },
    {
      value: `US${formatPrice(pricing.yearly)}`,
      label: `a year, after a ${pricing.trialDays}-day free trial with no card`,
    },
  ],
  questions: [
    {
      glyph: "solver",
      title: "How much can I spend?",
      body: "The most you can spend each year, from super and everything outside it, and still have your plan last, at the level of confidence you choose.",
      href: "/features/solvers/",
    },
    {
      glyph: "solver",
      title: "When can I retire?",
      body: `The earliest year your plan holds up. Super stays locked until your preservation age (${S.preservationAge}), so Glideworth checks that your shares, ETFs and cash outside super pay for every year before it.`,
      href: "/features/solvers/",
    },
    {
      glyph: "branch",
      title: "Inside super or outside it?",
      body: "Copy your plan into a what-if, such as salary sacrificing more, investing the same money outside super, or paying off the home loan first, and compare the retirement date and spending each one gives.",
      href: "/features/branches-and-change-sets/",
    },
    ...sharedQuestions.filter((q) =>
      ["Why does my plan fall short?", "What do I cut if markets fall?"].includes(q.title),
    ),
    {
      glyph: "people",
      title: "What about the two of us?",
      body: "Plan as a couple, each taxed on your own income. Both of you sign in to the same household, and you can see what happens to the other if one of you dies.",
      href: "/features/sharing-and-roles/",
    },
  ],
  working: {
    ticks: [
      "A FIRE number that counts tax: withdrawals, franked dividends and capital gains outside super are taxed each year; pension-phase earnings are not.",
      "Ask why the plan runs short, where the money went in a given financial year, or what changed between two plans.",
      "A check of your assumptions flags what looks wrong, such as nothing set aside for aged care in your 80s.",
      "The Australian tax estimate lists what it leaves out next to the result, and the formulas are open, so anyone can check how a number was worked out.",
    ],
  },
  taxSection: {
    eyebrow: "Tax",
    title: "Australian tax, worked out for every year of your plan.",
    intro: `Glideworth estimates resident income tax with the tax-free threshold and the low income tax offset (up to ${aud(now.lito.max)} in ${now.label}), the Medicare levy (${pct(now.medicare.rate)}, with the low-income shade-in), franking credits on Australian dividends, and capital gains with the ${pct(now.cgtDiscount)} discount. Rates follow the legislated changes year by year. It also estimates tax in ${facts.taxCountryCount - 1} other countries, for accounts and income you hold abroad.`,
    foot: "Each person is taxed on their own, as Australian law does. These are estimates and general information, not tax or financial advice.",
    footLink: { label: "Australian retirement tax, in detail", href: "/planning/au/" },
  },
  local: {
    accounts: {
      eyebrow: "Your accounts",
      title: "Super, account-based pensions and shares, by their own names.",
      intro: `You add the accounts you have, and Glideworth applies the Australian rules to each. Take Mia and Josh, a made-up couple in Brisbane in their late forties: they each have super in accumulation, ETFs outside super paying franked dividends, and a mortgage nearly paid off. Glideworth shows whether the ETFs can carry them from the day they stop work to preservation age, and what an account-based pension pays after that. Figures are for ${now.label}, from the tables the tax estimate uses.`,
      items: [
        {
          label: "Super in accumulation",
          href: "/planning/au/",
          note: `Concessional contributions, salary sacrifice included, taxed at ${pct(S.contributionsTax)} in the fund, within the ${aud(S.concessionalCap)} concessional cap, with Division 293 tax once income and concessional contributions pass ${aud(S.div293Threshold)} and tax on excess concessional contributions. No withdrawals before preservation age (${S.preservationAge}); benefits are tax-free from ${S.taxFreeAge}.`,
        },
        {
          label: "Account-based pension",
          href: "/blog/minimum-pension-drawdown-rates-australia/",
          note: `Super in the pension phase: earnings untaxed, and at least the minimum drawn each year, from ${pct(firstBand.rate)} of the balance before ${secondBand.from} to ${pct(lastBand.rate)} from ${lastBand.from}. The transfer balance cap is not modelled.`,
        },
        {
          label: "Shares and ETFs outside super",
          href: "/planning/au/",
          note: `The money that pays for the years before preservation age. Dividends grossed up with franking credits (at the ${pct(now.franking.corporateRate)} company rate), interest taxed as income, and capital gains with the ${pct(now.cgtDiscount)} discount. Your main home is exempt when you sell it.`,
        },
        {
          label: "Age Pension",
          href: "/planning/au/",
          note: "Not estimated: Glideworth does not apply the income and assets tests. If you expect a part pension, enter the amount you expect as income from the age you qualify; it will not change as your assets do.",
        },
      ],
    },
    tools: {
      title: "Free calculators for Australian plans",
      intro:
        "Quick answers in your browser, with no sign-up. They have no Australian tax or super rules built in and work in any currency (choose Australian dollars under the advanced settings); the historical ones replay US markets. The planner applies the Australian rules.",
      ids: [
        "fire",
        "coast-fire",
        "retirement-spending",
        "how-long",
        "withdrawal",
        "guardrails",
        "monte-carlo",
        "historical-backtest",
      ],
    },
    notes: {
      title: "Before you rely on an Australian plan",
      intro: "What Glideworth itself says about Australian plans, limits first.",
      items: [
        {
          title: "No Age Pension model",
          body: "Glideworth does not estimate the Age Pension or apply its income and assets tests, so it does not raise the pension as your savings run down or cut it as they grow. It suits plans that live mainly on savings, with the pension at most a backstop late in life. If a part pension will be a large share of your income, Moneysmart's free retirement planner estimates it; you can enter the amount you expect here as income.",
        },
        {
          title: "Market history: US by default",
          body: `${auDefaults.monteCarlo.note} You can test against random returns instead, with the expected return and volatility you choose, in the chance-of-success settings.`,
        },
        {
          title: "An estimate with its limits written down",
          body: `The Australian tax model lists ${auSimplifications} simplifications next to every result. For example, SAPTO (the seniors and pensioners tax offset), HELP repayments, the Medicare levy surcharge and family Medicare thresholds are not modelled, nor carry-forward of unused concessional cap, the transfer balance cap or Division 296 tax on large super balances. The household is taken to live in Australia for the whole plan.`,
        },
        {
          title: "General information, not advice",
          body: "Glideworth works out where your own numbers and assumptions lead. It does not know your objectives or your whole situation, and it does not recommend a fund, product or strategy. For personal advice, see a licensed financial adviser.",
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
  priceNote:
    "Glideworth's prices are in US dollars; there is no price in Australian dollars yet. Boldin plans for US tax only; ProjectionLab also covers Australia.",
  closingPriceNote: "Prices are in US dollars.",
};
