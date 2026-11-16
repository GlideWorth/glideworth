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
    note: "UK-US treaty Art. 17/18: US pension schemes are recognised in the UK (Roth growth is not taxed by the UK while in the plan; distributions follow US treatment). Basic level.",
    sources: [{ url: "https://www.gov.uk/government/publications/usa-tax-treaties", year: "2001" }],
  },
  {
    residence: "US",
    accountCountry: "GB",
    accountTypes: ["uk-sipp", "uk-pension", "uk-workplace-pension"],
    recognised: true,
    lumpSumTaxFree: false,
    note: "UK-US treaty: UK pension growth is deferred in the US. The UK tax-free lump sum is not recognised here (conservative); the treaty lump-sum article (Art. 17(2)) is applied separately as a treaty rule.",
    sources: [{ url: "https://www.gov.uk/government/publications/usa-tax-treaties", year: "2001" }],
  },
  {
    residence: "US",
    accountCountry: "GB",
    accountTypes: ["uk-isa", "uk-lisa"],
    recognised: false,
    note: "The US does not recognise ISAs: income and gains are taxable in the US (Glideworth taxes the earnings share at withdrawal).",
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
  note: "Foreign tax-free wrappers are not recognised by default: the earnings share of each withdrawal is taxed as a capital gain where you live.",
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
