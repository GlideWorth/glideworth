/**
 * Product facts the site states, in one place. Where the engine can answer, the number is read from
 * @glideworth/core at build time, so the site cannot drift from the code. The rest are copied from
 * docs/STATUS.md (with the date checked); update them when STATUS.md changes.
 */
import {
  ENGINE_VERSION,
  NATIONAL_JURISDICTION_BY_COUNTRY,
  TAX_SIMPLIFICATIONS,
} from "@glideworth/core";

/** Display names for the country codes the engine has a national tax model for. */
const COUNTRY_NAMES: Record<string, string> = {
  GB: "United Kingdom",
  US: "United States",
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

export const facts = {
  /** Countries with a national tax model in the engine (read from @glideworth/core). */
  taxCountryCount: codes.length,
  taxCountries: codes.map((code) => ({ code, name: COUNTRY_NAMES[code] ?? code })),
  /** Engine version (read from @glideworth/core). */
  engineVersion: ENGINE_VERSION,
  /** Number of written simplifications per tax model id, e.g. simplificationCount('uk'). */
  simplificationCount: (jurisdictionId: string) => TAX_SIMPLIFICATIONS[jurisdictionId]?.length ?? 0,

  /**
   * Counted from the code on 2026-11-16 (README, docs/API.md, docs/STATUS.md, docs/MCP.md and docs/PARITY.md agree). The hosted service's own OpenAPI document has 302 operations (cloud mode swaps 12 self-host sign-in operations for 49 account, workspace, billing and email ones); the site states the self-host figure.
   * apiOperations: operations in the generated OpenAPI 3.1 document, which is exactly what
   * `pnpm --filter @glideworth/site snapshot:openapi` writes to src/data/openapi.json (257 carry a required
   * scope; 8 are browser sign-in and share-link routes). The site's API reference page asserts this number
   * against the snapshot at build time. mcpTools: the registry as apps/api/test/tool-count.test.ts counts it
   * (all scopes, writes on); mcpReadTools are the tools marked read-only, mcpWriteTools the rest.
   */
  apiOperations: 265,
  mcpTools: 75,
  mcpReadTools: 54,
  mcpWriteTools: 21,

  // From docs/STATUS.md and docs/PARITY.md, checked 2026-11-16 (not used in page text).
  featuresChecked: 210,
  featuresImplemented: 171,
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
