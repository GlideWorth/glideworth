/**
 * Double taxation: per-pair treaty allocation of taxing rights, credit method by default.
 *
 * `treatyRule(residence, source, category)` answers "may the source country tax this, and must
 * the residence country exempt it?". A pair Glideworth does not know falls back to both countries
 * taxing under their domestic law with a credit in the residence country (`known: false`, shown as
 * a warning). UK-UAE is implemented from the published convention, article by article; the other
 * pairs are at a basic level (the main allocation rules, not every condition).
 */
import type { IncomeCategory, Treaty, TreatyRule } from "./types.js";

const GOV = (url: string, note: string, year: string) => ({ url, note, year });

export const TREATIES: readonly Treaty[] = [
  {
    pair: ["AE", "GB"],
    name: "UK-UAE Double Taxation Convention (2016)",
    depth: "high",
    method: "credit",
    rules: {
      employment: {
        allocation: "shared",
        note: "Art. 14: pay is taxable where the work is done (183-day exception for short visits not modelled).",
      },
      "self-employment": {
        allocation: "shared",
        note: "Business profits through a permanent establishment.",
      },
      rental: {
        allocation: "shared",
        note: "Art. 6: income from immovable property may be taxed where the property is.",
      },
      "private-pension": {
        allocation: "residence",
        note: "Art. 17: pensions paid to a resident of a Contracting State are taxable only in that State.",
      },
      "pension-lump-sum": {
        allocation: "residence",
        note: "Art. 17 covers pensions and other similar remuneration.",
      },
      "state-pension": {
        allocation: "residence",
        note: "No social security article: the State Pension falls under Art. 17 (residence only).",
      },
      "government-pension": {
        allocation: "source-unless-national-resident",
        note: "Art. 18(2): government pensions are taxable only in the paying State, unless the person is a resident and national of the other State.",
      },
      interest: {
        allocation: "residence",
        note: "Art. 11(2)-(3): interest beneficially owned by an individual resident in the other State is taxable only there.",
      },
      dividends: {
        allocation: "residence",
        note: "Art. 10(2): dividends are exempt in the paying company's State.",
      },
      "gains-property": {
        allocation: "shared",
        note: "Art. 13(1)-(2): gains on immovable property (and property-rich shares) may be taxed where the property is.",
      },
      "gains-securities": {
        allocation: "residence",
        note: "Art. 13(5): other gains are taxable only in the State of residence.",
      },
      other: {
        allocation: "residence",
        note: "Art. 20: other income is taxable only in the State of residence.",
      },
    },
    notes: [
      "Signed 12 April 2016, in force 25 December 2016; withholding taxes on amounts paid from 1 January 2017, other taxes for taxable years beginning on or after 1 January 2017 (Art. 26).",
      "UAE residence for treaty purposes: domicile, habitual abode or centre of vital interests in the UAE (Art. 4(1)(a)); a UAE Tax Residency Certificate supports a claim.",
      "Relief for UK pensions must be claimed from HMRC (form DT-Individual); until then UK tax may be deducted.",
    ],
    sources: [
      GOV(
        "https://www.gov.uk/government/publications/united-arab-emirates-tax-treaties/2016-uk-uae-double-taxation-convention",
        "Convention text: Arts 4, 6, 10, 11, 13, 14, 17, 18, 20, 21",
        "2016",
      ),
      GOV(
        "https://www.gov.uk/hmrc-internal-manuals/double-taxation-relief/dt19752",
        "HMRC DT19752: UAE treaty summary",
        "2026",
      ),
    ],
  },
  {
    pair: ["GB", "US"],
    name: "UK-US Income Tax Convention (2001)",
    depth: "basic",
    method: "credit",
    rules: {
      employment: { allocation: "shared" },
      "self-employment": { allocation: "shared" },
      rental: { allocation: "shared", note: "Art. 6." },
      "private-pension": {
        allocation: "residence",
        note: "Art. 17(1)(a): periodic pensions taxable only in the residence State.",
      },
      "pension-lump-sum": {
        allocation: "source",
        note: "Art. 17(2): a lump sum from a pension scheme is taxable only in the State where the scheme is established.",
      },
      "state-pension": {
        allocation: "source",
        note: "Art. 17(3): social security benefits are taxable only in the paying State.",
      },
      "government-pension": { allocation: "source-unless-national-resident", note: "Art. 19." },
      interest: { allocation: "residence", note: "Art. 11." },
      dividends: {
        allocation: "shared",
        maxSourceRate: 0.15,
        note: "Art. 10: portfolio dividends at most 15% at source.",
      },
      "gains-property": { allocation: "shared", note: "Art. 13." },
      "gains-securities": { allocation: "residence", note: "Art. 13." },
      other: { allocation: "residence" },
    },
    notes: [
      "Saving clause (Art. 1(4)): the US keeps taxing its citizens as if the treaty did not exist; Glideworth models this as citizenship-based taxation with a foreign tax credit.",
      "Basic level: the pension contribution relief articles and Roth/ISA recognition are not modelled article by article.",
    ],
    sources: [
      GOV(
        "https://www.gov.uk/government/publications/usa-tax-treaties",
        "UK-USA tax treaties",
        "2001",
      ),
    ],
  },
  {
    pair: ["AU", "GB"],
    name: "UK-Australia Double Taxation Convention (2003)",
    depth: "basic",
    method: "credit",
    rules: {
      employment: { allocation: "shared" },
      "self-employment": { allocation: "shared" },
      rental: { allocation: "shared" },
      "private-pension": {
        allocation: "residence",
        note: "Pensions taxable only in the residence State.",
      },
      "pension-lump-sum": { allocation: "residence" },
      "state-pension": { allocation: "residence" },
      "government-pension": {
        allocation: "shared",
        note: "Not verified article by article: credit method.",
      },
      interest: { allocation: "shared", maxSourceRate: 0.1 },
      dividends: { allocation: "shared", maxSourceRate: 0.15 },
      "gains-property": { allocation: "shared" },
      "gains-securities": { allocation: "residence" },
      other: { allocation: "residence" },
    },
    notes: ["Basic level: main allocation rules only."],
    sources: [
      GOV(
        "https://www.gov.uk/government/publications/australia-tax-treaties",
        "UK-Australia tax treaties",
        "2003",
      ),
    ],
  },
  {
    pair: ["CA", "GB"],
    name: "UK-Canada Double Taxation Convention (1978, as amended)",
    depth: "basic",
    method: "credit",
    rules: {
      employment: { allocation: "shared" },
      "self-employment": { allocation: "shared" },
      rental: { allocation: "shared" },
      "private-pension": {
        allocation: "shared",
        maxSourceRate: 0.1,
        note: "Periodic pensions may also be taxed at source, at most 10%.",
      },
      "pension-lump-sum": { allocation: "shared" },
      "state-pension": {
        allocation: "shared",
        note: "Not verified article by article: credit method.",
      },
      "government-pension": { allocation: "source-unless-national-resident" },
      interest: { allocation: "shared", maxSourceRate: 0.1 },
      dividends: { allocation: "shared", maxSourceRate: 0.15 },
      "gains-property": { allocation: "shared" },
      "gains-securities": { allocation: "residence" },
      other: { allocation: "residence" },
    },
    notes: ["Basic level: main allocation rules only."],
    sources: [
      GOV(
        "https://www.gov.uk/government/publications/canada-tax-treaties",
        "UK-Canada tax treaties",
        "1978",
      ),
    ],
  },
  {
    pair: ["ES", "GB"],
    name: "UK-Spain Double Taxation Convention (2013)",
    depth: "basic",
    method: "credit",
    rules: {
      employment: { allocation: "shared" },
      "self-employment": { allocation: "shared" },
      rental: { allocation: "shared" },
      "private-pension": {
        allocation: "residence",
        note: "Pensions taxable only in the residence State.",
      },
      "pension-lump-sum": { allocation: "residence" },
      "state-pension": { allocation: "residence" },
      "government-pension": { allocation: "source-unless-national-resident" },
      interest: { allocation: "residence" },
      dividends: { allocation: "shared", maxSourceRate: 0.15 },
      "gains-property": { allocation: "shared" },
      "gains-securities": { allocation: "residence" },
      other: { allocation: "residence" },
    },
    notes: ["Basic level: main allocation rules only."],
    sources: [
      GOV(
        "https://www.gov.uk/government/publications/spain-tax-treaties",
        "UK-Spain tax treaties",
        "2013",
      ),
    ],
  },
  {
    pair: ["FR", "GB"],
    name: "UK-France Double Taxation Convention (2008)",
    depth: "basic",
    method: "credit",
    rules: {
      employment: { allocation: "shared" },
      "self-employment": { allocation: "shared" },
      rental: { allocation: "shared" },
      "private-pension": {
        allocation: "residence",
        note: "Pensions taxable only in the residence State.",
      },
      "pension-lump-sum": { allocation: "residence" },
      "state-pension": { allocation: "residence" },
      "government-pension": { allocation: "source-unless-national-resident" },
      interest: { allocation: "residence" },
      dividends: { allocation: "shared", maxSourceRate: 0.15 },
      "gains-property": { allocation: "shared" },
      "gains-securities": { allocation: "residence" },
      other: { allocation: "residence" },
    },
    notes: ["Basic level: main allocation rules only."],
    sources: [
      GOV(
        "https://www.gov.uk/government/publications/france-tax-treaties",
        "UK-France tax treaties",
        "2008",
      ),
    ],
  },
  {
    pair: ["CA", "US"],
    name: "Canada-US Income Tax Convention (1980, as amended)",
    depth: "basic",
    method: "credit",
    rules: {
      employment: { allocation: "shared" },
      "self-employment": { allocation: "shared" },
      rental: { allocation: "shared" },
      "private-pension": {
        allocation: "shared",
        maxSourceRate: 0.15,
        note: "Art. XVIII: periodic pensions may be taxed at source at most 15%.",
      },
      "pension-lump-sum": { allocation: "shared" },
      "state-pension": {
        allocation: "residence",
        note: "Art. XVIII(5): social security benefits are taxable only in the residence State.",
      },
      "government-pension": { allocation: "shared" },
      interest: {
        allocation: "residence",
        note: "Art. XI: interest taxable only in the residence State.",
      },
      dividends: { allocation: "shared", maxSourceRate: 0.15 },
      "gains-property": { allocation: "shared" },
      "gains-securities": { allocation: "residence" },
      other: { allocation: "residence" },
    },
    notes: ["Saving clause: the US keeps taxing its citizens; basic level."],
    sources: [
      GOV(
        "https://www.irs.gov/businesses/international-businesses/canada-tax-treaty-documents",
        "Canada - Tax Treaty Documents",
        "1980",
      ),
    ],
  },
];

function key(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

const BY_PAIR = new Map<string, Treaty>(TREATIES.map((t) => [key(t.pair[0], t.pair[1]), t]));

/** The treaty between two countries (any order), or undefined. */
export function treatyBetween(a: string, b: string): Treaty | undefined {
  return BY_PAIR.get(key(a, b));
}

export interface TreatyDecision {
  /** Whether a treaty is known for the pair (false = domestic law + credit, with a warning). */
  known: boolean;
  treaty?: Treaty;
  rule: TreatyRule;
  /** Source country may tax (subject to its own law and `maxSourceRate`). */
  sourceMayTax: boolean;
  /** Residence country taxes it (and credits any source tax); false = exempt in residence. */
  residenceTaxes: boolean;
}

/**
 * Allocation for income of `category` sourced in `source` received by a resident of `residence`.
 * `nationalOfResidence`: the person is a national of the residence country (government pensions).
 */
export function treatyRule(
  residence: string,
  source: string,
  category: IncomeCategory,
  opts: { nationalOfResidence?: boolean } = {},
): TreatyDecision {
  if (residence === source)
    return {
      known: true,
      rule: { allocation: "residence" },
      sourceMayTax: false,
      residenceTaxes: true,
    };
  const t = treatyBetween(residence, source);
  const rule: TreatyRule = t?.rules[category] ?? { allocation: "shared" };
  let sourceMayTax = true;
  let residenceTaxes = true;
  switch (rule.allocation) {
    case "residence":
      sourceMayTax = false;
      break;
    case "source":
      residenceTaxes = false;
      break;
    case "source-unless-national-resident":
      if (opts.nationalOfResidence) sourceMayTax = false;
      else residenceTaxes = false;
      break;
    case "shared":
      break;
  }
  return { known: !!t, ...(t ? { treaty: t } : {}), rule, sourceMayTax, residenceTaxes };
}
