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
 *
 * Re-baselined 2026-11-19 for the US tax check: the US-CA and US-TX hashes changed (the samples use
 * the flat plug-in and are unchanged). Every 2026 tax line is unchanged; from 2027 the federal lines
 * follow the published 2027 tables (Rev. Proc. 2026-35, SSA 2027 wage base, CMS 2027 IRMAA, Notice
 * 2026-66 limits) instead of 2026 indexed; US-CA adds California SDI at 1.4% from 2027 and the
 * senior exemption credit from 65. All four also carry the new `us.federalIncomeTax` fact and the
 * added cited sources; US-CA also carries the new state facts.
 *
 * Re-baselined 2026-11-22 for the HSA employer-contribution change (GlideWorth/glideworth#8): the four
 * US hashes changed only in the cited sources carried in `meta.taxSources` (HSA source notes now give
 * the Rev. Proc. sections and Publication 969). With the old source notes restored, all 31 hashes
 * match the previous baseline, so no number changed.
 *
 * Re-baselined 2026-11-23 for the traditional IRA deduction phase-out (IRC 219(g),
 * GlideWorth/glideworth#10): the four US hashes changed only in `meta.taxSources` (the IR-2025-111
 * and IR-2026-136 notes now name the phase-out ranges, and Publication 590-A is cited). With those
 * three source entries restored to the previous text, all 31 hashes match the previous baseline,
 * so no number changed.
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
  "sample-de:de-plan-main": "8341591519a8e312",
  "sample-nl:nl-plan-main": "b1cb8477078511c5",
  "GB-ENG-single": "ec9fe9b09b880e4c",
  "GB-ENG-couple": "6a75d2004a2e2491",
  "GB-SCT-single": "46070e0e27a76ea1",
  "GB-SCT-couple": "2059ce0c001a722e",
  "US-CA-single": "6bd35686edac7b46",
  "US-CA-couple": "d14fa959fd265c30",
  "US-TX-single": "ea9899fb1065835c",
  "US-TX-couple": "f6349a850c3f985e",
  // Re-recorded 2026-11-19 (CA/AU/NZ official-source check): Ontario surtax before the dividend
  // tax credit, base CPP 4.75% from 2027, no CPP from 70, age amount on net income after the OAS
  // repayment, and the cited sources.
  "CA-ON-single": "f5f9ac2af8ef5eab",
  "CA-ON-couple": "efbb9e31797fa564",
  // Re-recorded 2026-11-19: Medicare levy thresholds of Act No. 58 of 2026, legislated amounts kept
  // nominal through 2027-28, and the cited sources.
  // Re-recorded 2026-11-23 after merging the super caps' cited sources (ATO, ITAA 1997) with the
  // foreign-resident rates' (GlideWorth/glideworth#3): only `meta.taxSources` changes; the output with
  // that field removed is identical.
  "AU-single": "91460b4e6171ab07",
  "AU-couple": "52e77432bb6f48ad",
  // Re-recorded 2026-11-19 (DE/NL/FR official-source check): Aktivrente, care surcharge for parents
  // and pre-1940 births, NL pre-1946 first bracket and Zvw on pensions, FR CSG by income, retirement
  // age table and single-parent cap, and the cited sources.
  "DE-single": "ff29c3df434321de",
  "DE-couple": "e51daa373114a153",
  "NL-single": "fec38eccce371a62",
  "NL-couple": "276d669df09da428",
  "FR-single": "08863fa29cecad70",
  "FR-couple": "8103ae0c4b8ddc27",
  // Spain re-recorded 2026-11-19: the art. 20 work-income reduction is measured before the 2,000
  // other expenses, and the 65+ minimum applies from 65 (LIRPF; AEAT manual). Re-recorded 2026-11-22:
  // only the cited sources changed (Galicia's AEAT and BOE sources added); with those two entries
  // left out, the old hashes still match.
  "ES-MD-single": "b3f83dbbed7055e4",
  "ES-MD-couple": "05533d93dcbac628",
  // Israel re-recorded 2026-11-19: the pension credit is capped at 658 a month, the extra 2% surtax
  // applies only to capital income above the threshold, and tax amounts are frozen through 2027.
  "IL-single": "d202482725f634d3",
  "IL-couple": "0dbef6f18afcf908",
  "IE-single": "71e400d674cd0200",
  "IE-couple": "9245a0705f59a682",
  // Re-recorded 2026-11-19: ACC levy 1.83% to 160,244 for 2027-28, amounts kept nominal through
  // 2027-28, and the cited sources.
  "NZ-single": "a3aced29874e08c4",
  "NZ-couple": "89558b057a50e9a1",
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
