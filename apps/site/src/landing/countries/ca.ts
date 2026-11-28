/**
 * The Canada version of the home page, at /ca/. Written for a Canadian reader in Canadian English.
 *
 * Every tax and benefit figure on the page is read from @glideworth/core at build time: the 2026 Canadian
 * tables (CA_2026 and CA_PROVINCES_2026, each figure cited there with its CRA or provincial source), the
 * country defaults and the written simplifications. None is typed here.
 *
 * There is no Canadian sample household in @glideworth/core/samples, so the page draws no tax-year example
 * (`working.taxYear` is left out) rather than invent one.
 *
 * Positioning (research and reasons in the pull request that introduced this copy): for the Canadian who
 * plans for themselves, often for early retirement, and wants to see and check the workings of each
 * decision (when to stop, which account to draw first, CPP and OAS timing, the OAS clawback) rather than
 * take an optimiser's answer on trust. The page says early, near the top, what a Canadian would otherwise
 * be misled about: CPP and OAS are amounts you enter, and markets are tested against US history unless you
 * set your own returns.
 */
import { CA_2026, CA_PROVINCES_2026, defaultsForCountry } from "@glideworth/core";
import { formatPrice, pricing } from "../../config/pricing";
import { facts } from "../../lib/facts";
import { sharedQuestions } from "../shared";
import { formatMoney } from "../tax-example";
import type { LandingEntry, Money } from "../types";

const money: Money = { currency: "CAD", symbol: "$", locale: "en-CA" };
const cad = (n: number) => formatMoney(n, money);
/** 0.165 -> "16.5%". */
const pct = (rate: number) => `${Number((rate * 100).toFixed(2))}%`;

const caDefaults = defaultsForCountry("CA");
const year = CA_2026.year;
const { limits, oas } = CA_2026;
const provinces = CA_PROVINCES_2026.length;
const cppStartAge = caDefaults.statePension?.startAge;
const cppDefault = cppStartAge ? ` (CPP from ${cppStartAge} unless you change it)` : "";
const simplifications =
  facts.simplificationCount("ca-federal") + facts.simplificationCount("ca-province");
const oasClawback = `${pct(oas.clawbackRate)} of net income above ${cad(oas.clawbackThreshold)} in ${year}`;

const shared = (title: string) => {
  const q = sharedQuestions.find((s) => s.title === title);
  if (!q) throw new Error(`No shared question "${title}"`);
  return q;
};

export const ca: LandingEntry = {
  code: "CA",
  slug: "ca",
  hreflang: "en-CA",
  countryName: "Canada",
  label: "Canada",
  lang: "en-CA",
  ogLocale: "en_CA",
  seo: {
    title: "Canada retirement planner: RRSP, TFSA, CPP, OAS",
    description:
      "A Canada retirement planner for early and DIY retirees: RRSP, TFSA, CPP and OAS, drawdown order and the OAS clawback, with federal and provincial tax shown.",
    ogTitle: "Your Canadian retirement, year by year, with the tax shown",
    ogEyebrow: "Canada retirement planner",
    primaryKeyword: "canada retirement planner",
  },
  money,
  hero: {
    eyebrow: "Canada retirement planner",
    title: ["Know when you can stop working, and ", "which account to draw from first", "."],
    lede: "Glideworth lays out your retirement year by year, in Canadian dollars: what you draw from your RRSP, TFSA and non-registered accounts, your CPP and OAS, and the federal and provincial tax and OAS clawback that follow. Try retiring at 55 instead of 60, or CPP at 70 instead of 65, and see what changes. You enter CPP and OAS from your Service Canada statement; no bank login.",
    priceNote: "Prices are in US dollars.",
    figureCaption:
      "Your plan run through a thousand possible markets, and how often the money lasts. Drawn here from illustrative numbers.",
  },
  proof: [
    { value: String(provinces), label: "provinces and territories, each with its own tax tables" },
    {
      value: String(simplifications),
      label: "things the Canadian tax estimate leaves out, listed next to every result",
    },
    { value: "0", label: "bank logins: you type in balances or import a file" },
    {
      value: formatPrice(pricing.yearly),
      label: `a year in US dollars, after a ${pricing.trialDays}-day free trial with no card`,
    },
  ],
  questions: [
    {
      glyph: "solver",
      title: "When can I retire?",
      body: "The earliest year your plan holds up, with your RRSP, TFSA, non-registered savings and any workplace pension, and how much more you would need to save to go sooner.",
      href: "/features/solvers/",
    },
    {
      ...shared("How much can I spend?"),
      body: "The most you can spend each year, in today's dollars, and still have the money last to the age you choose, at the level of confidence you choose.",
    },
    {
      glyph: "ledger",
      title: "Which account do I draw from first?",
      body: "Glideworth runs your plan with every order of drawing your RRSP or RRIF, TFSA and non-registered accounts and ranks them by lifetime tax, money left or chance of success. You can also draw your RRSP each year only up to a tax bracket you choose, before CPP and OAS start.",
      href: "/features/withdrawal-strategies/",
    },
    {
      glyph: "branch",
      title: "Should I take CPP at 60, 65 or 70?",
      body: "Copy your plan, enter the CPP and OAS your Service Canada statement shows for each age, and compare the two side by side: tax, OAS clawback and how long the money lasts.",
      href: "/features/branches-and-change-sets/",
    },
    {
      glyph: "fan",
      title: "Will the OAS clawback hit us?",
      body: `The OAS recovery tax (${oasClawback}) is worked out each year, so you can see which years and which withdrawals push you over, and try another drawdown order to stay under.`,
      href: "/blog/oas-clawback-2026/",
    },
    {
      ...shared("What about the two of us?"),
      body: "Plan as a couple: each of you signs in to the same household, pension income splitting is chosen each year to lower your combined tax, and you can see what happens to the other if one of you dies.",
    },
  ],
  working: {
    ticks: [
      "Each year shows what you take from your RRSP or RRIF, TFSA and non-registered accounts, the RRIF minimum, and the federal and provincial tax that follows.",
      "The plan itself uses the steady returns you set. The chance of success is a second view, and you can also replay your plan through every start year of US market history.",
      "Ask why the plan runs short, where the money went in a given year, or what changed between two plans.",
      "A check of your assumptions flags what looks wrong, such as someone in the plan with no CPP or OAS.",
      "The formulas are open, and the Canadian tax estimate lists what it leaves out next to the result.",
    ],
  },
  taxSection: {
    eyebrow: "Tax",
    title: "Federal and provincial tax, worked out for every year of your plan.",
    intro: `Glideworth estimates federal tax and, once you set your province or territory, provincial tax for each person: the basic personal, age and pension income amounts, CPP or QPP contributions and EI premiums while you work, the OAS recovery tax (${oasClawback}), dividends with their gross-up and tax credit, and capital gains at a ${pct(CA_2026.capitalGainsInclusion)} inclusion rate. If you also hold accounts or income abroad, it estimates tax in ${facts.taxCountryCount - 1} other countries, the United States and the UK among them.`,
    foot: "Each spouse is taxed on their own income, as in Canada, with pension income splitting between you. These are estimates, not tax advice.",
    footLink: { label: "Canada retirement tax, in detail", href: "/planning/ca/" },
  },
  local: {
    accounts: {
      eyebrow: "Your accounts",
      title: "RRSP, TFSA, CPP and OAS, by their own names.",
      intro: `You add the accounts and benefits you have, and Glideworth applies the Canadian rules to each. Amounts are in Canadian dollars for ${year}, from the tables the tax estimate uses.`,
      items: [
        {
          label: "RRSP and RRIF",
          href: "/blog/rrif-and-lif-withdrawal-rates-2026/",
          note: `Contributions up to the RRSP deduction limit (${pct(limits.rrspRate)} of earned income, at most ${cad(limits.rrspMax)} in ${year}), growth tax-deferred, withdrawals taxed as income. RRIF minimum withdrawals are taken every year from CRA's prescribed factors.`,
        },
        {
          label: "TFSA and FHSA",
          href: "/planning/ca/",
          note: `A TFSA limit of ${cad(limits.tfsa)} and an FHSA limit of ${cad(limits.fhsa)} for ${year}, with tax-free growth and withdrawals. TFSA room restored after a withdrawal and the FHSA home-purchase rules are not tracked.`,
        },
        {
          label: "CPP, OAS, GIS and workplace pensions",
          href: "/blog/oas-clawback-2026/",
          note: `CPP, OAS and GIS are amounts you enter, with the age each starts${cppDefault}; Glideworth does not estimate them from your contributions, and starting later does not raise them by itself, so enter the amount for the age you choose. OAS is reduced by the recovery tax; GIS is tax-free, and its clawback is not modelled. A defined benefit pension is an income with its start age, indexing and survivor share, and a bridge benefit that stops at 65 is a second income that ends then.`,
        },
        {
          label: "LIRA, RESP and non-registered",
          href: "/planning/ca/",
          note: "Non-registered accounts track their cost basis, with eligible and non-eligible dividends, interest and gains taxed each year. There is no LIF account type and no LIF maximum: give a locked-in account the RRIF minimum and check its withdrawals against your province's LIF table.",
        },
      ],
    },
    tools: {
      title: "Free calculators to start with",
      intro:
        "Quick answers in your browser, with no sign-up. They are not specific to Canada: they work in any currency (choose the Canadian dollar under the advanced settings) and leave out tax, CPP and OAS. For those, use the planner.",
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
      title: "What to know before you rely on a Canadian plan",
      intro: "The limits a Canadian should know about, in Glideworth's own words.",
      items: [
        {
          title: "CPP and OAS: you enter the amounts",
          body: "Glideworth does not estimate CPP or OAS from your contribution or residence history. Take the figures for each start age from your My Service Canada Account, or from the Government of Canada's Canadian Retirement Income Calculator, and enter them. CPP depends on how long and how much you contribute, so if you will stop working years before you take it, check that the figure you enter reflects the years you will actually contribute.",
        },
        {
          title: "Markets: US history, or your own returns",
          body: `${caDefaults.monteCarlo.note} Its returns and inflation are American, in US dollars. If you would rather use your own assumptions, switch the simulation to random returns and set the average and volatility of stock returns, bond returns and inflation yourself. Canadian history is on the list of data sets to add.`,
        },
        {
          title: "Set your province",
          body: `${caDefaults.tax.note} All ${provinces} provinces and territories have their own brackets, basic amounts and dividend tax credits, including the legislated pauses in indexation in Manitoba and British Columbia.`,
        },
        {
          title: "Quebec: partly modelled",
          body: `For a household in Quebec, the federal abatement (${pct(CA_2026.federal.quebecAbatement)}) and QPP contributions are applied and Quebec tax is estimated from Quebec's ${year} brackets. The separate Quebec return's age and pension amounts, QPIP premiums and the work premium are not modelled, and Quebec's three lower rates and its dividend tax credits are not yet confirmed from an official source.`,
        },
        {
          title: "An estimate with its limits written down",
          body: `The Canadian tax model lists ${simplifications} simplifications next to every result. For example, the GIS and its clawback, the alternative minimum tax and the Canada Workers Benefit are not modelled, and the OAS recovery tax is charged in the same year as the income, not with the one-year lag of real instalments.`,
        },
      ],
    },
    reading: {
      title: "Read more about Canadian plans",
      links: [
        {
          label: "Canada retirement tax",
          href: "/planning/ca/",
          note: "How Glideworth models federal and provincial tax, CPP, OAS, EI, the RRSP, RRIF and TFSA, with the official sources.",
        },
        {
          label: "OAS clawback 2026: threshold and how it works",
          href: "/blog/oas-clawback-2026/",
        },
        {
          label: "RRIF minimum and LIF maximum tables for 2026",
          href: "/blog/rrif-and-lif-withdrawal-rates-2026/",
        },
        {
          label: "FIRE number: the 25x rule and its limits",
          href: "/blog/what-is-your-fire-number/",
        },
      ],
    },
  },
  priceNote: "Prices are in US dollars; there is no price in Canadian dollars yet.",
  closingPriceNote: "Prices are in US dollars.",
};
