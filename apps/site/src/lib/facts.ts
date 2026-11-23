/**
 * Product facts the site states, in one place. Where the engine can answer, the number is read from
 * @glideworth/core at build time, so the site cannot drift from the code. The rest are copied from
 * docs/STATUS.md (with the date checked); update them when STATUS.md changes.
 */
import {
  ENGINE_VERSION,
  HISTORICAL_SERIES_DATASET,
  MARKET_DATASETS,
  NATIONAL_JURISDICTION_BY_COUNTRY,
  TAX_SIMPLIFICATIONS,
} from "@glideworth/core";
import openapiSnapshot from "../data/openapi.json?raw";

/**
 * Display names for the country codes the engine has a national tax model for. Lists on the site follow
 * the engine's order (NATIONAL_JURISDICTION_BY_COUNTRY), which puts the United States first.
 */
const COUNTRY_NAMES: Record<string, string> = {
  US: "United States",
  GB: "United Kingdom",
  CA: "Canada",
  AU: "Australia",
  DE: "Germany",
  NL: "Netherlands",
  FR: "France",
  ES: "Spain",
  IL: "Israel",
  IE: "Ireland",
  NZ: "New Zealand",
  AE: "United Arab Emirates",
};

const codes = Object.keys(NATIONAL_JURISDICTION_BY_COUNTRY);
const usHistory = MARKET_DATASETS[HISTORICAL_SERIES_DATASET];

const METHODS = ["get", "post", "put", "patch", "delete"];
/** Operations in the committed self-host OpenAPI snapshot (src/data/openapi.json). */
const selfHostOperations = Object.values(
  (JSON.parse(openapiSnapshot) as { paths: Record<string, Record<string, unknown>> }).paths,
).reduce((n, item) => n + Object.keys(item).filter((m) => METHODS.includes(m)).length, 0);

export const facts = {
  /** Countries with a national tax model in the engine (read from @glideworth/core). */
  taxCountryCount: codes.length,
  taxCountries: codes.map((code) => ({ code, name: COUNTRY_NAMES[code] ?? code })),
  /** Engine version (read from @glideworth/core). */
  engineVersion: ENGINE_VERSION,
  /** First and last year of the bundled US market history that simulations replay (read from @glideworth/core). */
  usHistoryFirstYear: usHistory.firstYear,
  usHistoryLastYear: usHistory.lastYear,
  /** Number of written simplifications per tax model id, e.g. simplificationCount('uk'). */
  simplificationCount: (jurisdictionId: string) => TAX_SIMPLIFICATIONS[jurisdictionId]?.length ?? 0,

  /**
   * apiOperations: operations in the hosted service's OpenAPI 3.1 document (app.glideworth.com/openapi.json:
   * cloud mode with "Sign in with Google" configured), which is what people who sign up on this site use.
   * Cloud mode swaps the 12 self-host user and passphrase operations for 53 account, workspace, billing and
   * email ones, plus 7 Google sign-in ones. apps/api/test/cloud-isolation.test.ts boots that configuration and
   * fails when this number differs, so update it with the API change.
   * apiOperationsSelfHost: operations in a self-hosted server's document, counted from the snapshot that
   * `pnpm --filter @glideworth/site snapshot:openapi` writes to src/data/openapi.json (the API reference page
   * lists it). apps/api/test/openapi.test.ts fails when the snapshot's count differs from the code's.
   * mcpTools: the registry as apps/api/test/tool-count.test.ts counts it (all scopes, writes on); mcpReadTools
   * are the tools marked read-only, mcpWriteTools the rest.
   */
  apiOperations: 299,
  apiOperationsSelfHost: selfHostOperations,
  mcpTools: 69,
  mcpReadTools: 50,
  mcpWriteTools: 19,

  // From docs/STATUS.md and docs/PARITY.md, checked 2026-11-23 (not used in page text).
  featuresChecked: 216,
  featuresImplemented: 173,
} as const;

/**
 * Replaces `{{name}}` tokens with a fact. Frontmatter cannot import this module, so titles and descriptions
 * in src/content use tokens (`{{mcpTools}}`, `{{taxCountryCount}}`); the content schemas call this.
 */
export function withFacts(text: string): string {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => {
    const value = (facts as Record<string, unknown>)[key];
    if (typeof value === "number") return String(value);
    throw new Error(`Unknown fact ${whole} in "${text.slice(0, 60)}"`);
  });
}
