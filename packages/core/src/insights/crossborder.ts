/**
 * Assumption-audit checks for a household with items in another country (part of
 * `auditAssumptions`): foreign assets without a currency or FX rate, contributions into a foreign
 * wrapper non-residents cannot fund, and country pairs with no treaty in Glideworth's tables.
 */
import type { ProjectionResult, SimulationInput } from "../engine/types.js";
import { ACCOUNT_TYPE_INFO } from "../schema/account-types.js";
import { COUNTRY_TAX_CURRENCY } from "../tax/crossborder/currency.js";
import { countryName } from "../tax/crossborder/explain.js";
import { NON_RESIDENT_RULES } from "../tax/crossborder/nonresident.js";
import { treatyBetween } from "../tax/crossborder/treaties.js";
import type { Finding } from "./contracts.js";

function finances(input: SimulationInput) {
  const sc = input.plan.startingConditions;
  return sc.kind === "snapshot" ? sc.finances : input.finances;
}

// ------------------------------------------------------------------ audit

function accountCountry(type: string, jurisdiction: string | undefined, base: string): string {
  return (
    jurisdiction ??
    (ACCOUNT_TYPE_INFO as Record<string, { country?: string }>)[type]?.country ??
    base
  );
}

/** Assumption-audit checks for plans that span countries (part of `auditAssumptions`). */
export function crossBorderFindings(input: SimulationInput, _result?: ProjectionResult): Finding[] {
  const out: Finding[] = [];
  const { household, plan } = input;
  const fin = finances(input);
  const base = household.location.country;
  const fx = [...(fin.fxRates ?? []), ...(plan.assumptions.fxRates ?? [])];
  const hasPair = (a: string, b: string) =>
    a === b || fx.some((r) => (r.from === a && r.to === b) || (r.from === b && r.to === a));
  const finding = (
    code: string,
    severity: Finding["severity"],
    title: string,
    message: string,
    refs: string[] = [],
    suggestion?: string,
  ): Finding => ({
    code,
    severity,
    title,
    message,
    periodIndex: null,
    refs,
    evidence: [{ source: "plan" }],
    ...(suggestion ? { suggestion } : {}),
  });
  const foreignItem =
    fin.accounts.some((a) => accountCountry(a.type, a.jurisdiction, base) !== base) ||
    fin.realAssets.some((r) => (r.country ?? base) !== base) ||
    plan.income.some((e) => e.country && e.country !== base);
  const usAbroad = household.people.some(
    (p) => (p.usGreenCard || p.citizenships?.includes("US")) && base !== "US",
  );
  if (!foreignItem && !usAbroad) return out;

  // 1. Assets held in another country than the residence, valued in a currency with no FX rate.
  const items: { id: string; name: string; country: string; currency: string | undefined }[] = [
    ...fin.accounts.map((a) => ({
      id: a.id,
      name: a.name,
      country: accountCountry(a.type, a.jurisdiction, base),
      currency: a.currency,
    })),
    ...fin.realAssets.map((r) => ({
      id: r.id,
      name: r.name,
      country: r.country ?? base,
      currency: r.currency,
    })),
  ];
  for (const it of items) {
    if (it.country === base) continue;
    const local = COUNTRY_TAX_CURRENCY[it.country];
    const cur = it.currency ?? household.currency;
    if (it.country !== base && local && !it.currency && local !== household.currency)
      out.push(
        finding(
          "XB_FOREIGN_ASSET_BASE_CURRENCY",
          "warning",
          `${it.name} is in ${it.country} but valued in ${household.currency}`,
          `${it.name} is held in ${it.country}, where it is normally denominated in ${local}, but has no currency set, so exchange-rate moves are ignored.`,
          [it.id],
          `Set its currency to ${local} and add a ${local}/${household.currency} rate to the FX table.`,
        ),
      );
    else if (!hasPair(cur, household.currency))
      out.push(
        finding(
          "XB_MISSING_FX",
          "critical",
          `No exchange rate for ${it.name}`,
          `${it.name} is in ${cur} but the FX table has no ${cur}/${household.currency} rate.`,
          [it.id],
        ),
      );
  }
  const taxCountries = new Set(items.map((i) => i.country));
  for (const e of plan.income) if (e.country) taxCountries.add(e.country);
  if (usAbroad) taxCountries.add("US");
  for (const c of taxCountries) {
    const cur = COUNTRY_TAX_CURRENCY[c];
    if (c !== base && NON_RESIDENT_RULES[c] && cur && !hasPair(cur, household.currency))
      out.push(
        finding(
          "XB_TAX_FX_MISSING",
          "warning",
          `No ${cur} exchange rate for ${countryName(c)} taxes`,
          `Tax in ${countryName(c)} is computed in ${cur}, but the FX table has no ${cur}/${household.currency} rate: its thresholds would be applied unconverted.`,
          [],
          `Add a ${cur}/${household.currency} rate.`,
        ),
      );
  }

  // 2. Contributions planned into a wrapper that non-residents cannot fund.
  for (const f of plan.flows) {
    if (f.kind !== "contribution" || !f.enabled) continue;
    const acc = [...fin.accounts, ...plan.plannedAccounts].find((a) => a.id === f.accountId);
    if (!acc) continue;
    const country = accountCountry(acc.type, acc.jurisdiction, base);
    const rule = NON_RESIDENT_RULES[country]?.wrappers.find((w) =>
      w.accountTypes.includes(acc.type),
    );
    if (!rule || rule.contributions === "allowed") continue;
    if (country === base) continue;
    out.push(
      finding(
        "XB_WRAPPER_NON_RESIDENT_CONTRIBUTIONS",
        "warning",
        `${acc.name} cannot be funded from abroad`,
        `${rule.note} The flow "${f.name}" puts nothing in while you live outside ${countryName(country)}; the money goes down the waterfall.`,
        [f.id, acc.id],
        "Redirect the flow to an account in the country you live in.",
      ),
    );
  }

  // 3. Country pairs without a treaty in Glideworth's tables.
  const sources = new Set(items.map((i) => i.country));
  for (const e of plan.income) if (e.country) sources.add(e.country);
  const r = base;
  for (const s of sources)
    if (r !== s && NON_RESIDENT_RULES[s] && !treatyBetween(r, s))
      out.push(
        finding(
          "XB_UNKNOWN_TREATY",
          "warning",
          r === "XX"
            ? `No treaty data for ${countryName(s)} while living somewhere else`
            : `No ${countryName(r)}-${countryName(s)} treaty in Glideworth's tables`,
          `While living ${r === "XX" ? "somewhere else (no country set)" : `in ${countryName(r)}`} with income or assets in ${countryName(s)}, Glideworth taxes under both countries' own rules and credits the ${countryName(s)} tax where you live. A real treaty may allocate taxing rights differently.`,
          [],
        ),
      );
  return out;
}
