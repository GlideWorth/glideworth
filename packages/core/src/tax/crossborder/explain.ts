/**
 * "How is this taxed and why": the decision the engine makes for one item, as data plus plain
 * sentences, from the same tables the engine uses (non-resident rules, treaties, wrappers).
 */
import type { AccountType, TaxTreatment } from "../../schema/accounts.js";
import { NON_RESIDENT_RULES } from "./nonresident.js";
import { treatyRule } from "./treaties.js";
import type { IncomeCategory, Source } from "./types.js";
import { wrapperView } from "./wrappers.js";

/** Country name for sentences ('GB' -> 'United Kingdom'), from the non-resident tables. */
export function countryName(code: string): string {
  return NON_RESIDENT_RULES[code]?.label ?? code;
}

export interface CrossBorderTreatment {
  residence: string;
  source: string;
  category: IncomeCategory;
  /** The source country taxes it (domestic rule AND the treaty lets it). */
  sourceTaxes: boolean;
  /** Rate cap set by the treaty on the source country, if any. */
  maxSourceRate?: number;
  /** The residence country taxes it (false = exempt there under the treaty). */
  residenceTaxes: boolean;
  /** How double taxation is relieved. */
  relief: "none-needed" | "credit" | "exemption";
  treaty: { name: string; depth: "high" | "basic" } | null;
  /** No treaty is known for the pair: domestic law in both countries plus a credit (warning). */
  unknownTreaty: boolean;
  wrapper?: { recognised: boolean; lumpSumTaxFree: boolean; note: string };
  steps: string[];
  sources: Source[];
}

export function explainCrossBorderTreatment(q: {
  residence: string;
  source: string;
  category: IncomeCategory;
  nationalOfResidence?: boolean;
  account?: { type: AccountType; treatment: TaxTreatment };
  wrapperOverrides?: Record<string, boolean>;
}): CrossBorderTreatment {
  const steps: string[] = [];
  const sources: Source[] = [];
  const nr = NON_RESIDENT_RULES[q.source];
  const R = countryName(q.residence);
  const S = countryName(q.source);
  if (q.residence === q.source) {
    return {
      residence: q.residence,
      source: q.source,
      category: q.category,
      sourceTaxes: false,
      residenceTaxes: true,
      relief: "none-needed",
      treaty: null,
      unknownTreaty: false,
      steps: [`Taxed in ${R} as the country where you live and where the income arises.`],
      sources,
    };
  }
  const d = treatyRule(q.residence, q.source, q.category, {
    nationalOfResidence: q.nationalOfResidence,
  });
  const domestic = nr?.rules[q.category];
  const domesticTaxes = domestic?.taxed ?? false;
  if (domestic) steps.push(`${S} rule for non-residents: ${domestic.note}`);
  else steps.push(`Glideworth has no non-resident rules for ${S}: no ${S} tax is modelled.`);
  if (d.treaty) {
    steps.push(`${d.treaty.name}: ${d.rule.note ?? d.rule.allocation}.`);
    sources.push(...d.treaty.sources);
  } else steps.push(`No treaty between ${R} and ${S} is known: both may tax, ${R} gives a credit.`);
  if (nr) sources.push(...nr.sources.slice(0, 2));
  const sourceTaxes = domesticTaxes && d.sourceMayTax;
  const residenceTaxes = d.residenceTaxes;
  let wrapper: CrossBorderTreatment["wrapper"];
  if (q.account) {
    wrapper = wrapperView(
      q.residence,
      q.source,
      q.account.type,
      q.account.treatment,
      q.wrapperOverrides,
    );
    steps.push(`How ${R} sees this ${S} account: ${wrapper.note}`);
  }
  if (residenceTaxes) steps.push(`Taxed in ${R} as part of your worldwide income.`);
  else steps.push(`Exempt in ${R} under the treaty.`);
  if (sourceTaxes && residenceTaxes)
    steps.push(`${R} credits the ${S} tax, up to its own tax on the same income.`);
  return {
    residence: q.residence,
    source: q.source,
    category: q.category,
    sourceTaxes,
    ...(d.rule.maxSourceRate !== undefined ? { maxSourceRate: d.rule.maxSourceRate } : {}),
    residenceTaxes,
    relief: sourceTaxes && residenceTaxes ? "credit" : sourceTaxes ? "exemption" : "none-needed",
    treaty: d.treaty ? { name: d.treaty.name, depth: d.treaty.depth } : null,
    unknownTreaty: !d.known,
    ...(wrapper ? { wrapper } : {}),
    steps,
    sources,
  };
}
