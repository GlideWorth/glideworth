/**
 * How a residence country treats FOREIGN tax-advantaged wrappers. Conservative default: a foreign
 * tax-free account (ISA, TFSA, Roth, DEWS...) is NOT recognised, so the earnings share of each
 * withdrawal is taxed as a capital gain where you live; a foreign pension is taxed as pension
 * income but its tax-free lump sum is NOT recognised (the whole withdrawal is taxable). Rows below
 * relax the default where the rule is known; a plan can override any pair with
 * `tax.crossBorder.wrapperRecognition`.
 */
import type { AccountType, TaxTreatment } from "../../schema/accounts.js";
import type { WrapperRecognition } from "./types.js";

export const WRAPPER_RECOGNITION: readonly WrapperRecognition[] = [
  {
    residence: "AE",
    accountCountry: "*",
    recognised: true,
    lumpSumTaxFree: true,
    note: "The UAE taxes no personal income, so every foreign wrapper is effectively sheltered while you live there.",
  },
  {
    residence: "GB",
    accountCountry: "US",
    accountTypes: [
      "traditional-ira",
      "401k",
      "403b",
      "tsp",
      "roth-ira",
      "roth-401k",
      "roth-403b",
      "roth-tsp",
    ],
    recognised: true,
    lumpSumTaxFree: false,
    note: "UK-US treaty: growth inside a US plan is taxed in the UK only when paid out (Art. 18(1)); payments are UK pension income, and a Roth distribution the US would not tax is exempt in the UK (Art. 17(1)(b)). A lump sum from a US plan is taxable only in the US (Art. 17(2)), which Glideworth does not separate from regular payments.",
    sources: [
      {
        url: "https://www.gov.uk/government/publications/usa-tax-treaties/2001-uk-usa-double-taxation-convention-as-amended-by-the-2002-protocol-in-force",
        year: "2001 (read 2026-11-19)",
      },
    ],
  },
  {
    residence: "US",
    accountCountry: "GB",
    accountTypes: ["uk-sipp", "uk-pension", "uk-workplace-pension"],
    recognised: true,
    lumpSumTaxFree: false,
    note: "UK-US treaty Art. 18(1): growth inside a UK pension is taxed in the US only when paid out (kept for US citizens by Art. 1(5)(a)). Payments are US pension income. The UK tax-free lump sum is taxed in the US: Art. 17(2) gives lump sums to the UK, but the saving clause (Art. 1(4)) lets the US tax its residents and citizens anyway. Whether Art. 17(1)(b) exempts the UK tax-free part is not confirmed (no IRS guidance found); override in the plan if your adviser says it does.",
    sources: [
      {
        url: "https://www.gov.uk/government/publications/usa-tax-treaties/2001-uk-usa-double-taxation-convention-as-amended-by-the-2002-protocol-in-force",
        year: "2001 (read 2026-11-19)",
      },
    ],
  },
  {
    residence: "US",
    accountCountry: "GB",
    accountTypes: ["uk-isa", "uk-lisa"],
    recognised: false,
    note: "The US does not recognise ISAs: their income and gains are taxable in the US every year (Glideworth taxes the earnings share at withdrawal, which is later and lighter). Funds inside an ISA are usually PFICs for a US person, which is not modelled.",
  },
  {
    residence: "CA",
    accountCountry: "US",
    accountTypes: ["roth-ira"],
    recognised: true,
    lumpSumTaxFree: true,
    note: "Canada-US treaty Art. XVIII(1) and (3)(b): a Roth IRA is a pension, and a distribution the US would not tax is exempt in Canada, unless contributions were made while you lived in Canada (Glideworth does not check this).",
    sources: [
      {
        url: "https://www.canada.ca/en/department-finance/programs/tax-policy/tax-treaties/country/united-states-america-convention-consolidated-1980-1983-1984-1995-1997-2007.html",
        year: "2007 (read 2026-11-19)",
      },
    ],
  },
];

export interface WrapperView {
  recognised: boolean;
  lumpSumTaxFree: boolean;
  note: string;
}

const DEFAULT_TAX_FREE: WrapperView = {
  recognised: false,
  lumpSumTaxFree: false,
  note: "Foreign tax-free wrappers are not recognised by default. Most countries tax the income inside them every year; Glideworth instead taxes the earnings share of each withdrawal as a capital gain where you live, so the tax comes later and may be lower than in reality.",
};
const DEFAULT_PENSION: WrapperView = {
  recognised: true,
  lumpSumTaxFree: false,
  note: "Foreign pensions are taxed as pension income where you live; the tax-free lump sum of the pension's own country is not recognised by default.",
};

/**
 * How `residence` sees an account of `accountCountry`. Same country: recognised. `overrides` =
 * `tax.crossBorder.wrapperRecognition` (key `<residence>:<accountCountry>:<accountType>`).
 */
export function wrapperView(
  residence: string,
  accountCountry: string,
  accountType: AccountType,
  treatment: TaxTreatment,
  overrides?: Record<string, boolean>,
): WrapperView {
  if (residence === accountCountry)
    return { recognised: true, lumpSumTaxFree: true, note: "Domestic wrapper." };
  const o = overrides?.[`${residence}:${accountCountry}:${accountType}`];
  if (o !== undefined)
    return {
      recognised: o,
      lumpSumTaxFree: o,
      note: "Set in the plan (tax.crossBorder.wrapperRecognition).",
    };
  const row = WRAPPER_RECOGNITION.find(
    (r) =>
      r.residence === residence &&
      (r.accountCountry === "*" || r.accountCountry === accountCountry) &&
      (!r.accountTypes || r.accountTypes.includes(accountType)),
  );
  if (row)
    return {
      recognised: row.recognised,
      lumpSumTaxFree: row.lumpSumTaxFree ?? false,
      note: row.note,
    };
  return treatment === "tax-deferred" ? DEFAULT_PENSION : DEFAULT_TAX_FREE;
}
