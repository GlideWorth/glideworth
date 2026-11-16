/**
 * The per-country "what this estimate leaves out" lists are shown to users next to tax results.
 * These tests pin their structure, not their wording: every country keeps its list, the list has
 * the number of entries it was audited with against the plug-in (2026-11-16), each entry is a
 * sentence, and the registered jurisdiction shows the list. Changing an entry's wording is free;
 * adding or removing one means updating EXPECTED_COUNT here, deliberately.
 */
import { describe, expect, it } from "vitest";
import { TAX_SIMPLIFICATIONS } from "../src/tax/data/simplifications.js";
import { createDefaultTaxRegistry } from "../src/tax/registry.js";

const EXPECTED_COUNT: Record<string, number> = {
  uk: 14,
  "us-federal": 10,
  "us-payroll": 4,
  "us-state": 5,
  "us-local": 3,
  "ca-federal": 7,
  "ca-province": 4,
  au: 8,
  de: 11,
  nl: 7,
  fr: 8,
  es: 8,
  il: 8,
  ie: 5,
  nz: 5,
  ae: 6,
};

const reg = createDefaultTaxRegistry();

describe("tax simplification lists", () => {
  it("cover exactly the audited jurisdictions", () => {
    expect(Object.keys(TAX_SIMPLIFICATIONS).sort()).toEqual(Object.keys(EXPECTED_COUNT).sort());
  });

  for (const [id, count] of Object.entries(EXPECTED_COUNT)) {
    describe(id, () => {
      const list = TAX_SIMPLIFICATIONS[id] ?? [];

      it(`has ${count} entries, each a distinct sentence`, () => {
        expect(list).toHaveLength(count);
        expect(new Set(list).size).toBe(list.length);
        for (const s of list) {
          expect(s.trim().length, s).toBeGreaterThan(20);
          expect(s, s).toMatch(/[.)]$/);
          expect(s, s).toMatch(/^[A-Z0-9"']/);
        }
      });

      it("is the list the registered jurisdiction shows", () => {
        const shown = reg.get(id).simplifications ?? [];
        expect(shown.slice(0, list.length)).toEqual([...list]);
      });
    });
  }
});
