/**
 * Statutory rules the engine needs regardless of the plan's tax mode (contribution limits, pension
 * access ages, main-home gain exclusions). They come from the jurisdiction plug-in of the account's
 * country (or the household's), so a 'flat' or 'custom' plan for a UK household still uses the UK
 * ISA allowance, annual allowance and normal minimum pension age from the UK tax data. The plan's
 * own stack (estimate mode) is consulted after the country plug-in.
 */

import { NATIONAL_JURISDICTION_BY_COUNTRY } from "../tax/registry.js";
import type { TaxJurisdiction } from "../tax/types.js";
import type { AccountState, EngineContext, PeriodState } from "./context.js";

const cache = new WeakMap<EngineContext, Map<string, TaxJurisdiction[]>>();

/** Implemented national jurisdiction(s) for a country ([] when none is registered). */
export function countryRules(ctx: EngineContext, country: string | undefined): TaxJurisdiction[] {
  if (!country) return [];
  let byCountry = cache.get(ctx);
  if (!byCountry) {
    byCountry = new Map();
    cache.set(ctx, byCountry);
  }
  const hit = byCountry.get(country);
  if (hit) return hit;
  const id = NATIONAL_JURISDICTION_BY_COUNTRY[country];
  let out: TaxJurisdiction[] = [];
  if (id) {
    try {
      const j = ctx.registry.get(id);
      if (j.status === "implemented") out = [j];
    } catch {
      out = [];
    }
  }
  byCountry.set(country, out);
  return out;
}

/**
 * Country whose rules govern an account (explicit jurisdiction, the type's country, else the
 * household's country). A UK pension keeps the UK access age wherever its owner lives.
 */
export function accountCountryOf(ctx: EngineContext, a: AccountState): string {
  return a.def.jurisdiction ?? a.info.country ?? ctx.household.location.country;
}

/** Rule sources for an account: its country's plug-in first, then the plan's own stack. */
export function rulesFor(ctx: EngineContext, a: AccountState, ps?: PeriodState): TaxJurisdiction[] {
  const out = [...countryRules(ctx, accountCountryOf(ctx, a))];
  if (ps) for (const j of ps.stack) if (j.status === "implemented" && !out.includes(j)) out.push(j);
  return out;
}

/** Rule sources for the household (home country, then the plan stack). */
export function householdRules(ctx: EngineContext, ps: PeriodState): TaxJurisdiction[] {
  const out = [...countryRules(ctx, ps.location.country)];
  for (const j of ps.stack) if (j.status === "implemented" && !out.includes(j)) out.push(j);
  return out;
}
