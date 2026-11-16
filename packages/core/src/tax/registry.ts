import { NotImplementedError, ScenarioError } from "../errors.js";
import type { Location } from "../schema/household.js";
import type { TaxConfig } from "../schema/tax.js";
import { aeJurisdiction } from "./jurisdictions/ae.js";
import { auJurisdiction } from "./jurisdictions/au.js";
import { caFederalJurisdiction, caProvinceJurisdiction } from "./jurisdictions/ca.js";
import { customJurisdiction } from "./jurisdictions/custom.js";
import { deJurisdiction } from "./jurisdictions/de.js";
import { esJurisdiction } from "./jurisdictions/es.js";
import { flatJurisdiction } from "./jurisdictions/flat.js";
import { frJurisdiction } from "./jurisdictions/fr.js";
import { ieJurisdiction } from "./jurisdictions/ie.js";
import { ilJurisdiction } from "./jurisdictions/il.js";
import { nlJurisdiction } from "./jurisdictions/nl.js";
import { nzJurisdiction } from "./jurisdictions/nz.js";
import { STUB_JURISDICTIONS } from "./jurisdictions/stubs.js";
import { ukJurisdiction } from "./jurisdictions/uk.js";
import { usFederalJurisdiction } from "./jurisdictions/us-federal.js";
import { usPayrollJurisdiction } from "./jurisdictions/us-payroll.js";
import { usLocalJurisdiction, usStateJurisdiction } from "./jurisdictions/us-state.js";
import type { TaxJurisdiction } from "./types.js";

/** Every implemented jurisdiction (workstream b). Registering them replaces the stubs. */
export const IMPLEMENTED_JURISDICTIONS: TaxJurisdiction[] = [
  customJurisdiction,
  usFederalJurisdiction,
  usPayrollJurisdiction,
  usStateJurisdiction,
  usLocalJurisdiction,
  ukJurisdiction,
  caFederalJurisdiction,
  caProvinceJurisdiction,
  auJurisdiction,
  deJurisdiction,
  nlJurisdiction,
  frJurisdiction,
  esJurisdiction,
  ilJurisdiction,
  ieJurisdiction,
  nzJurisdiction,
  aeJurisdiction,
];

/** National plug-in holding each country's statutory rules (limits, access ages, home-sale relief). */
export const NATIONAL_JURISDICTION_BY_COUNTRY: Readonly<Record<string, string>> = {
  US: "us-federal",
  GB: "uk",
  CA: "ca-federal",
  AU: "au",
  DE: "de",
  NL: "nl",
  FR: "fr",
  ES: "es",
  IL: "il",
  IE: "ie",
  NZ: "nz",
  AE: "ae",
};

/**
 * Jurisdiction ids may be parameterised: 'us-state:CA' resolves to the 'us-state' plug-in, which
 * reads the region from TaxYearInput.location. Registration replaces any existing id, so a
 * workstream swaps a stub for the real implementation by registering the same id.
 */
export class TaxRegistry {
  private readonly map = new Map<string, TaxJurisdiction>();
  private readonly specialised = new Map<string, TaxJurisdiction>();

  constructor(initial: TaxJurisdiction[] = []) {
    for (const j of initial) this.register(j);
  }

  register(j: TaxJurisdiction): this {
    this.map.set(j.id, j);
    this.specialised.clear();
    return this;
  }

  get(id: string): TaxJurisdiction {
    const exact = this.map.get(id);
    if (exact) return exact;
    const cached = this.specialised.get(id);
    if (cached) return cached;
    const [base, param] = id.split(":") as [string, string | undefined];
    const j = this.map.get(base);
    if (!j) throw new ScenarioError(`unknown tax jurisdiction '${id}'`, { id });
    if (param && j.parameterize) {
      const s = j.parameterize(param);
      this.specialised.set(id, s);
      return s;
    }
    return j;
  }

  list(): TaxJurisdiction[] {
    return [...this.map.values()];
  }

  /** The ordered jurisdiction stack for a plan's tax config and household location. */
  resolveStack(config: TaxConfig, location: Location): TaxJurisdiction[] {
    if (config.mode === "flat") return [this.get("flat")];
    if (config.mode === "custom") return [this.get("custom")];
    const ids = config.jurisdictions.length > 0 ? config.jurisdictions : defaultStackIds(location);
    return ids.map((id) => this.get(id));
  }
}

export function defaultStackIds(location: Location): string[] {
  switch (location.country) {
    case "US":
      return [
        "us-federal",
        "us-payroll",
        ...(location.region ? [`us-state:${location.region}`] : []),
        ...(location.locality ? [`us-local:${location.locality}`] : []),
      ];
    case "GB":
      return ["uk"];
    case "CA":
      return ["ca-federal", ...(location.region ? [`ca-province:${location.region}`] : [])];
    case "AU":
      return ["au"];
    case "ES":
      return [location.region ? `es:${location.region}` : "es"];
    case "DE":
    case "NL":
    case "FR":
    case "IL":
    case "IE":
    case "NZ":
    case "AE":
      return [location.country.toLowerCase()];
    default:
      throw new NotImplementedError(
        `tax.estimate.${location.country}`,
        "b",
        "no estimate preset for this country; use tax.mode 'flat' or 'custom'",
      );
  }
}

/** Default registry: stubs first (so ids are always known), then every implementation over them. */
export function createDefaultTaxRegistry(): TaxRegistry {
  return new TaxRegistry([flatJurisdiction, ...STUB_JURISDICTIONS, ...IMPLEMENTED_JURISDICTIONS]);
}
