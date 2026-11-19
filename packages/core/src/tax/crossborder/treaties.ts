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
        "2016 (re-read 2026-11-19)",
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
      employment: { allocation: "shared", note: "Art. 14." },
      "self-employment": { allocation: "shared", note: "Art. 7." },
      rental: { allocation: "shared", note: "Art. 6." },
      "private-pension": {
        allocation: "residence",
        note: "Art. 17(1)(a): pensions are taxable only in the residence State; under Art. 17(1)(b) an amount the scheme's State would exempt (a Roth distribution) is exempt there too.",
      },
      "pension-lump-sum": {
        allocation: "source",
        note: "Art. 17(2): a lump sum from a pension scheme is taxable only in the State where the scheme is established (the US still taxes its own residents and citizens under the saving clause).",
      },
      "state-pension": {
        allocation: "residence",
        note: "Art. 17(3): social security paid by one State to a resident of the other is taxable only in the State of residence (kept for US citizens by Art. 1(5)(a)).",
      },
      "government-pension": {
        allocation: "source-unless-national-resident",
        note: "Art. 19(2): taxable only in the paying State, unless the person is a resident and national of the other State.",
      },
      interest: { allocation: "residence", note: "Art. 11(1)." },
      dividends: {
        allocation: "shared",
        maxSourceRate: 0.15,
        note: "Art. 10(2)(b): portfolio dividends at most 15% at source.",
      },
      "gains-property": { allocation: "shared", note: "Art. 13(1)." },
      "gains-securities": { allocation: "residence", note: "Art. 13(5)." },
      other: { allocation: "residence", note: "Art. 22(1)." },
    },
    savingClause: {
      country: "US",
      exceptions: ["state-pension"],
      exceptionsForNonCitizens: ["government-pension"],
      note: "Art. 1(4)-(5): each State may tax its residents, and the US its citizens, as if the treaty did not exist, except for the benefits listed in Art. 1(5) (here: Art. 17(1)(b), 17(3), 18(1) and (5), and Art. 19 for people who are not US citizens or green-card holders). Glideworth applies this to the US side only.",
    },
    notes: [
      "Saving clause (Art. 1(4)): the US taxes its residents and citizens as if the treaty did not exist, except for the articles in Art. 1(5). Glideworth applies it on the US side; whether the UK applies Art. 1(4) to its own residents' US lump sums is not confirmed, so UK residents keep the Art. 17(2) exemption.",
      "Art. 18(1): growth inside a pension scheme of the other State is taxed only when paid out (kept for US citizens by Art. 1(5)(a)).",
      "Basic level: pension contribution relief (Art. 18(2)-(5)) is not modelled.",
    ],
    sources: [
      GOV(
        "https://www.gov.uk/government/publications/usa-tax-treaties/2001-uk-usa-double-taxation-convention-as-amended-by-the-2002-protocol-in-force",
        "Convention text: Arts 1(4)-(5), 10, 11, 13, 17, 18, 19, 22",
        "2001 (read 2026-11-19)",
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
        note: "Art. 17(1): pensions (including government pensions) and annuities are taxable only in the residence State.",
      },
      "pension-lump-sum": {
        allocation: "residence",
        note: "Art. 17(1) (Glideworth treats a lump sum as a pension; the treaty does not mention lump sums).",
      },
      "state-pension": { allocation: "residence", note: "Art. 17(1)." },
      "government-pension": {
        allocation: "residence",
        note: "Art. 17(1): government pensions are taxable only in the residence State.",
      },
      interest: {
        allocation: "shared",
        maxSourceRate: 0.1,
        note: "Art. 11(2): at most 10% at source.",
      },
      dividends: {
        allocation: "shared",
        maxSourceRate: 0.15,
        note: "Art. 10(2)(b): portfolio dividends at most 15% at source.",
      },
      "gains-property": { allocation: "shared", note: "Art. 13(1)." },
      "gains-securities": {
        allocation: "shared",
        note: "Art. 13(6): each State applies its own law to other gains (neither taxes a non-resident on listed shares).",
      },
      other: { allocation: "residence", note: "Art. 20." },
    },
    notes: ["Basic level: main allocation rules only."],
    sources: [
      GOV(
        "https://www.gov.uk/government/publications/australia-tax-treaties/2003-australia-uk-double-taxation-convention-in-force",
        "Convention text: Arts 10, 11, 13, 17",
        "2003 (read 2026-11-19)",
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
        allocation: "residence",
        note: "Art. 17(1): pensions, including any payment under a pension or retirement plan, are taxable only in the residence State (the 10% source cap of Art. 17(2) is for annuities).",
      },
      "pension-lump-sum": {
        allocation: "residence",
        note: "Art. 17(1): any payment under a superannuation, pension or retirement plan is a pension.",
      },
      "state-pension": {
        allocation: "residence",
        note: "Art. 17(1): social security payments are pensions, taxable only in the residence State.",
      },
      "government-pension": {
        allocation: "residence",
        note: "Art. 17(1): government pensions are taxable only in the residence State (HMRC DT4610).",
      },
      interest: {
        allocation: "shared",
        maxSourceRate: 0.1,
        note: "Art. 11(2): at most 10% at source; arm's-length interest is taxable only in the residence State.",
      },
      dividends: {
        allocation: "shared",
        maxSourceRate: 0.15,
        note: "Art. 10(2): portfolio dividends at most 15% at source.",
      },
      "gains-property": { allocation: "shared", note: "Art. 13(1)." },
      "gains-securities": { allocation: "residence", note: "Art. 13(8)." },
      other: { allocation: "residence" },
    },
    notes: ["Basic level: main allocation rules only."],
    sources: [
      GOV(
        "https://www.gov.uk/hmrc-internal-manuals/double-taxation-relief/dt4604",
        "HMRC DT4604: Canada treaty summary (government and other pensions taxable only in the UK for UK residents)",
        "2026-11-19",
      ),
      GOV(
        "https://www.gov.uk/hmrc-internal-manuals/double-taxation-relief/dt4610",
        "HMRC DT4610: Art. 17 covers pensions of every kind, including social security; annuities 10% at source",
        "2026-11-19",
      ),
      GOV(
        "https://www.canada.ca/en/department-finance/programs/tax-policy/tax-treaties/country/united-kingdom-convention-consolidated-1978-1980-1985.html",
        "Convention text (consolidated 1978-1985): Arts 10, 11, 13, 17",
        "1985 (read 2026-11-19)",
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
        note: "Art. 17: pensions are taxable only in the residence State.",
      },
      "pension-lump-sum": { allocation: "residence", note: "Art. 17." },
      "state-pension": { allocation: "residence", note: "Art. 17." },
      "government-pension": {
        allocation: "source-unless-national-resident",
        note: "Art. 18(2).",
      },
      interest: { allocation: "residence", note: "Art. 11(1)." },
      dividends: {
        allocation: "shared",
        maxSourceRate: 0.1,
        note: "Art. 10(2)(a)(i): portfolio dividends at most 10% at source (15% for property-fund dividends, not separated).",
      },
      "gains-property": { allocation: "shared", note: "Art. 13(1)." },
      "gains-securities": { allocation: "residence", note: "Art. 13(6)." },
      other: { allocation: "residence", note: "Art. 20(1)." },
    },
    notes: ["Basic level: main allocation rules only."],
    sources: [
      GOV(
        "https://www.gov.uk/government/publications/spain-tax-treaties/synthesised-text-of-the-multilateral-instrument-and-the-2013-uk-spain-double-taxation-convention-in-force",
        "Convention text (synthesised with the MLI): Arts 10, 11, 13, 17, 18, 20",
        "2013 (read 2026-11-19)",
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
        note: "Art. 18: pensions paid in consideration of past employment are taxable only in the residence State.",
      },
      "pension-lump-sum": { allocation: "residence", note: "Art. 18." },
      "state-pension": {
        allocation: "residence",
        note: "Art. 18, or Art. 23 (other income): either way taxable only in the residence State.",
      },
      "government-pension": {
        allocation: "source-unless-national-resident",
        note: "Art. 19(2): taxable only in the paying State, unless the person is a resident and national of the other State and not also a national of the paying State (dual nationals are not separated).",
      },
      interest: { allocation: "residence", note: "Art. 12(1)." },
      dividends: {
        allocation: "shared",
        maxSourceRate: 0.15,
        note: "Art. 11(1)(b): at most 15% at source.",
      },
      "gains-property": { allocation: "shared", note: "Art. 14(1)." },
      "gains-securities": { allocation: "residence", note: "Art. 14(5)." },
      other: { allocation: "residence", note: "Art. 23(1)." },
    },
    notes: ["Basic level: main allocation rules only."],
    sources: [
      GOV(
        "https://www.gov.uk/government/publications/france-tax-treaties/2008-uk-and-france-double-taxation-convention-in-force",
        "Convention text: Arts 11, 12, 14, 18, 19, 23",
        "2008 (read 2026-11-19)",
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
        note: "Art. XVIII(2)(a): periodic pensions may be taxed at source at most 15%.",
      },
      "pension-lump-sum": {
        allocation: "shared",
        note: "Art. XVIII(2): lump sums are not capped (domestic rate at source).",
      },
      "state-pension": {
        allocation: "residence",
        note: "Art. XVIII(5): social security benefits are taxable only in the residence State.",
      },
      "government-pension": {
        allocation: "shared",
        maxSourceRate: 0.15,
        note: "Art. XIX covers pay other than pensions, so government pensions fall under Art. XVIII(2): at most 15% at source.",
      },
      interest: {
        allocation: "residence",
        note: "Art. XI(1): interest taxable only in the residence State.",
      },
      dividends: {
        allocation: "shared",
        maxSourceRate: 0.15,
        note: "Art. X(2)(b): portfolio dividends at most 15% at source.",
      },
      "gains-property": { allocation: "shared", note: "Art. XIII(1)." },
      "gains-securities": { allocation: "residence", note: "Art. XIII(4)." },
      other: { allocation: "residence" },
    },
    savingClause: {
      country: "US",
      exceptions: ["state-pension"],
      note: "Art. XXIX(2)-(3): the US taxes its residents and citizens as if the treaty did not exist, except for the provisions in Art. XXIX(3), which include Art. XVIII(1), (3), (5) and (7). So a US citizen living in Canada pays tax on US Social Security only in Canada.",
    },
    notes: [
      "Saving clause (Art. XXIX(2)): the US keeps taxing its citizens, except for the benefits in Art. XXIX(3).",
      "Art. XVIII(5)(a): US Social Security of a Canadian resident is taxed in Canada with 15% of it exempt (the 15% exemption is not modelled); Canadian benefits of a US resident are taxed in the US like Social Security (not modelled: taxed as a pension).",
      "Art. XVIII(1) and (3)(b): Canada exempts Roth IRA distributions that would be exempt in the US, unless contributions were made while resident in Canada.",
      "Lump sums are not capped by Art. XVIII(2), so the source country's domestic rate applies.",
    ],
    sources: [
      GOV(
        "https://www.canada.ca/en/department-finance/programs/tax-policy/tax-treaties/country/united-states-america-convention-consolidated-1980-1983-1984-1995-1997-2007.html",
        "Convention text (consolidated 1980-2007): Arts X, XI, XIII, XVIII, XIX, XXIX",
        "2007 (read 2026-11-19)",
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
 * `nationalOfResidence`: the person is a national of the residence country (government pensions;
 * for the US also a green-card holder, for the saving clause).
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
  // Saving clause: the clause's country keeps taxing its own residents unless the treaty excepts
  // the benefit (the source country's limits still apply; the residence country credits its tax).
  const sc = t?.savingClause;
  if (sc && sc.country === residence && !residenceTaxes) {
    const kept =
      sc.exceptions.includes(category) ||
      (!opts.nationalOfResidence && (sc.exceptionsForNonCitizens ?? []).includes(category));
    if (!kept) residenceTaxes = true;
  }
  return { known: !!t, ...(t ? { treaty: t } : {}), rule, sourceMayTax, residenceTaxes };
}

/**
 * Whether `citizenCountry` may tax its citizen living in `residence` on income of `category`
 * sourced in `source` (citizenship-based taxation, US). The saving clause lets it tax as if the
 * treaty did not exist, except for the benefits the treaty keeps for citizens: then, if the treaty
 * gives the income only to the country of residence, the citizen's country may not tax it (for
 * example US Social Security of a US citizen living in the UK or Canada).
 */
export function citizenshipMayTax(
  citizenCountry: string,
  residence: string,
  source: string,
  category: IncomeCategory,
): boolean {
  if (residence === citizenCountry || source !== citizenCountry) return true;
  const t = treatyBetween(citizenCountry, residence);
  const sc = t?.savingClause;
  if (!sc || sc.country !== citizenCountry || !sc.exceptions.includes(category)) return true;
  return treatyRule(residence, source, category).sourceMayTax;
}
