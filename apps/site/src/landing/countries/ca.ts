/**
 * The Canada version of the home page, at /ca/. Written for a Canadian reader in Canadian English.
 *
 * Every tax and benefit figure on the page is read from @glideworth/core at build time: the 2026 Canadian
 * tables (CA_2026 and CA_PROVINCES_2026, each figure cited there with its CRA or provincial source), the
 * country defaults and the written simplifications. None is typed here.
 *
 * There is no Canadian sample household in @glideworth/core/samples, so the page draws no tax-year example
 * (`working.taxYear` is left out) rather than invent one.
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

const QUESTION_BODIES: Record<string, string> = {
  "When can I retire?":
    "The earliest date your plan holds up, drawing your RRSP, TFSA and non-registered savings in the order you choose, and the savings it takes to get there.",
  "What if we do it differently?":
    "Copy your plan into a what-if, such as retiring at 58 instead of 62 or drawing your RRSP down before your TFSA, and compare the two side by side.",
  "What about the two of us?":
    "Plan as a couple: each of you signs in to the same household, pension income splitting is chosen each year to lower your combined tax, and you can see what happens to the other if one of you dies.",
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
    title: "Canada retirement planner: RRSP, TFSA and tax",
    description:
      "Plan when you can retire in Canada and how much you can spend, with your RRSP, TFSA, CPP and OAS, and federal and provincial tax estimated every year.",
    ogTitle: "Know when you can retire in Canada",
    ogEyebrow: "Canada retirement planner",
    primaryKeyword: "canada retirement planner",
  },
  money,
  hero: {
    eyebrow: "Canada retirement planner",
    title: ["Know ", "when you can retire", " in Canada, and how much you can spend."],
    lede: "Glideworth maps out your money year by year, in Canadian dollars, with federal and provincial tax estimated for each calendar year. It tells you the most you can spend, the earliest you can stop working, and how your RRSP, TFSA, CPP and OAS carry you there. You type in your numbers; it never asks for a bank login.",
    priceNote: "Prices are in US dollars.",
    figureCaption:
      "Your plan run through thousands of possible markets, and how often it lasts. Drawn here from illustrative numbers.",
  },
  proof: [
    { value: String(provinces), label: "provinces and territories, each with its own tax tables" },
    {
      value: `${facts.usHistoryFirstYear}–${facts.usHistoryLastYear}`,
      label: "US market history Canadian plans are tested against by default (see why below)",
    },
    { value: "0", label: "bank logins needed: type in balances or import a file" },
    {
      value: formatPrice(pricing.yearly),
      label: `a year in US dollars, after a ${pricing.trialDays}-day free trial with no card`,
    },
  ],
  questions: sharedQuestions.map((q) =>
    QUESTION_BODIES[q.title] ? { ...q, body: QUESTION_BODIES[q.title]! } : q,
  ),
  working: {
    ticks: [
      "Ask why the plan runs short, where the money went in a given year, or what changed between two plans.",
      "A check of your assumptions flags what looks wrong, such as someone in the plan with no CPP or OAS.",
      "The Canadian tax estimate lists what it leaves out, next to the result.",
      "The formulas are open, so anyone can check how a number was worked out.",
    ],
  },
  taxSection: {
    eyebrow: "Tax",
    title: "Federal and provincial tax, worked out for every year of your plan.",
    intro: `Glideworth estimates federal tax and, once you set your province or territory, provincial tax for each person: the basic personal, age and pension income amounts, CPP or QPP contributions and EI premiums while you work, the OAS recovery tax (${pct(oas.clawbackRate)} of net income above ${cad(oas.clawbackThreshold)} in ${year}), dividends with their gross-up and tax credit, and capital gains at a ${pct(CA_2026.capitalGainsInclusion)} inclusion rate. It also estimates tax in ${facts.taxCountryCount - 1} other countries, for accounts and income you hold abroad.`,
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
          label: "CPP, OAS and GIS",
          href: "/blog/oas-clawback-2026/",
          note: `Each is an amount you enter with the age it starts${cppDefault}. OAS is reduced by the recovery tax; GIS is tax-free, and its clawback is not modelled. Starting later adds nothing for you: enter the amount you expect at the age you choose.`,
        },
        {
          label: "LIRA, RESP and non-registered",
          href: "/planning/ca/",
          note: "Non-registered accounts track their cost basis, with eligible and non-eligible dividends, interest and gains taxed each year. There is no LIF account type and no LIF maximum: give a locked-in account the RRIF minimum and check its withdrawals against your province's LIF table.",
        },
      ],
    },
    tools: {
      title: "Free calculators for Canadian plans",
      intro:
        "Quick answers in your browser, with no sign-up. None of them is specific to Canada yet; they work in any currency, so choose the Canadian dollar under the advanced settings. For CPP, OAS and Canadian tax, use the planner.",
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
      title: "Before you rely on a Canadian plan",
      intro: "What Glideworth itself says about Canadian plans, limits included.",
      items: [
        {
          title: "Market history: US by default",
          body: `${caDefaults.monteCarlo.note} Its returns and inflation are American, in US dollars. Canadian history is on the list of data sets to add.`,
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
  priceNote: "Prices are in US dollars; there are no prices in Canadian dollars.",
  closingPriceNote: "Prices are in US dollars.",
};
