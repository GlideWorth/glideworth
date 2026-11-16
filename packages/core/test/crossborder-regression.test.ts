/**
 * Regression guard for the cross-border model: never-moved single-country households produce
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
  "sample-uk:uk-plan-main": "d3d3428c9fa009cf",
  "sample-de:de-plan-main": "b5b24f96cb250abb",
  "sample-nl:nl-plan-main": "33947faa14f65e50",
  "GB-ENG-single": "008b8866c5fad8fa",
  "GB-ENG-couple": "fa184c93e8a93a27",
  "GB-SCT-single": "6e026b0a291221ce",
  "GB-SCT-couple": "69ad4a4df9993ddf",
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
  "IE-single": "12191555578c1c23",
  "IE-couple": "c77700e525b80c1e",
  "NZ-single": "bbc44208f7c312d3",
  "NZ-couple": "d0ed3366381db116",
};

describe("single-country households are unchanged by the cross-border model", () => {
  for (const { name, input } of singleCountryCorpus())
    it(name, () => {
      const r = simulate(structuredClone(input));
      expect(
        r.periods.every((p) => p.taxes.residence === undefined && p.taxes.byCountry === undefined),
      ).toBe(true);
      expect(r.periods.some((p) => p.taxes.lines.some((l) => l.basis !== undefined))).toBe(false);
      delete (r.meta as { engineVersion?: string }).engineVersion;
      expect(fnv(JSON.stringify(r))).toBe(BEFORE[name]);
    });
});
