/**
 * Regression guard for the cross-border model: single-country households produce
 * projections byte-identical to the engine before it existed (engine 0.3.0, commit 513d348). The
 * hashes below were computed from that engine's output (full trace, `meta.engineVersion` removed)
 * for the corpus in fixtures/single-country-corpus.ts.
 *
 * Re-baselined 2026-11-16 (engine 0.5.0) for the cash-flow timing fix (engine/accounts.ts
 * `withdrawable`): 25 of the 31 hashes changed. Each changed household had at least one year in which
 * the old engine emptied an account and clamped the timing charge at zero, and its projection first
 * differs in exactly that year; the 6 households with no such year are unchanged. The single-country
 * code paths are otherwise as before, so the guard keeps its meaning for the cross-border model.
 *
 * Re-baselined 2026-11-16 for the tax-table re-sourcing (official sources, tax/data): 14 hashes
 * changed. US-CA (California 2026 brackets, deduction and credits) and IE (CGT 31% from 7 October
 * 2026) change numbers; US-TX, CA-ON, AU, IL and NZ change only in the cited sources carried in
 * `meta.taxSources` (checked by diffing the full output with those fields removed: identical).
 *
 * 2026-11-19 (engine 0.6.0, schema 2: moving country removed): all 31 hashes unchanged once
 * `meta.schemaVersion` is set back to 1, so the removal did not change any single-country result.
 *
 * Re-baselined 2026-11-19 for the UK and Ireland tax check: the UK sample, GB-ENG, GB-SCT and IE
 * hashes changed. UK: 2027/28 savings and property rates 24/44/49 (Budget 2026), 2027/28 Child
 * Benefit and State Pension rates, the Pension Tax Allowance and the cited sources. IE: the Budget
 * 2027 table for 2027 on (bands, credits, USC; PRSI 4.3875% in 2027 and 4.5% after) with
 * thresholds nominal through 2027, and USC on retirement lump sums above €500,000.
 */
import { describe, expect, it } from "vitest";
import { simulate } from "../src/engine/simulate.js";
import { singleCountryCorpus } from "./fixtures/single-country-corpus.js";

/** 64-bit FNV-1a of a string, as 16 hex digits. */
function fnv(s: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

const BEFORE: Record<string, string> = {
  "sample-us:plan-main": "8a0c18739edb7045",
  "sample-us:plan-early": "69b4a468bfb6d7d6",
  // Re-recorded when the sample's State Pension moved from 67 to 68 (Sam is born 1978; Pensions Act 2007).
  "sample-uk:uk-plan-main": "eb8417e6a89076dc",
  "sample-de:de-plan-main": "b5b24f96cb250abb",
  "sample-nl:nl-plan-main": "33947faa14f65e50",
  "GB-ENG-single": "ec9fe9b09b880e4c",
  "GB-ENG-couple": "6a75d2004a2e2491",
  "GB-SCT-single": "46070e0e27a76ea1",
  "GB-SCT-couple": "2059ce0c001a722e",
  "US-CA-single": "5ffa0c719014e762",
  "US-CA-couple": "6b54b4d5b51c152d",
  "US-TX-single": "cc39e49f105c1dd9",
  "US-TX-couple": "0f7c151ef7cd5b76",
  "CA-ON-single": "d8b71ac87e88ebe5",
  "CA-ON-couple": "5624c8622fac1c14",
  "AU-single": "28664a204e21e404",
  "AU-couple": "f16a3bd6654dceaf",
  "DE-single": "557a6b72037213fd",
  "DE-couple": "d955b763e69d1e64",
  "NL-single": "030e373d6d593429",
  "NL-couple": "7e043b1c00356ec9",
  "FR-single": "819a0af1da1c5193",
  "FR-couple": "db1fe3de053c2fb9",
  "ES-MD-single": "fb572d114c86247d",
  "ES-MD-couple": "97f1127523875d85",
  "IL-single": "6d14b74b182f58bc",
  "IL-couple": "762a6d5a8e851e06",
  "IE-single": "71e400d674cd0200",
  "IE-couple": "9245a0705f59a682",
  "NZ-single": "bbc44208f7c312d3",
  "NZ-couple": "d0ed3366381db116",
};

describe("single-country households are unchanged by the cross-border model", () => {
  for (const { name, input } of singleCountryCorpus())
    it(name, () => {
      const r = simulate(structuredClone(input));
      expect(r.periods.every((p) => p.taxes.byCountry === undefined)).toBe(true);
      expect(r.periods.some((p) => p.taxes.lines.some((l) => l.basis !== undefined))).toBe(false);
      delete (r.meta as { engineVersion?: string }).engineVersion;
      // Results carry the document schema version (2 since moving country was removed); the
      // baseline was recorded at version 1, so hash the result as that engine wrote it.
      (r.meta as { schemaVersion?: number }).schemaVersion = 1;
      expect(fnv(JSON.stringify(r))).toBe(BEFORE[name]);
    });
});
