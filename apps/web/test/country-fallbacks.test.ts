import { ACCOUNT_TYPE_INFO } from "@glideworth/core";
import { describe, expect, it } from "vitest";
import { applyHandoff, parseHandoff } from "../src/features/cloud/handoff";
import { countryFromLocale, createStarterDocument } from "../src/features/import/starter";
import {
  buildSetupDocument,
  defaultAnswers,
  validateAnswers,
} from "../src/features/onboarding/build-document";
import { quickAccountTypes, regionRequired } from "../src/lib/countries";

const NOW = new Date(Date.UTC(2026, 10, 15));

describe("an unknown country falls back to the US", () => {
  it("reads supported countries from the locale and uses the US for anything else", () => {
    expect(countryFromLocale("en-GB")).toBe("GB");
    expect(countryFromLocale("en-US")).toBe("US");
    expect(countryFromLocale("de-DE")).toBe("DE");
    expect(countryFromLocale("fr-CA")).toBe("CA");
    expect(countryFromLocale("en")).toBe("US");
    expect(countryFromLocale("pt-BR")).toBe("US");
    expect(countryFromLocale("")).toBe("US");
  });

  it("the import starter household follows the locale, else the US", () => {
    const br = createStarterDocument({ locale: "pt-BR", now: NOW });
    expect(br.household.location.country).toBe("US");
    expect(br.household.currency).toBe("USD");
    expect(createStarterDocument({ locale: "en-GB", now: NOW }).household.location).toEqual({
      country: "GB",
      region: "ENG",
    });
  });

  it("guided setup starts in the US, in dollars, with US accounts", () => {
    const a = defaultAnswers(undefined, NOW);
    expect(a.country).toBe("US");
    expect(a.currency).toBe("USD");
    expect(a.locale).toBe("en-US");
    expect(a.accounts.map((x) => x.type)).toEqual(["savings", "401k", "roth-ira"]);
  });

  it("a calculator hand-off without a mapped currency starts in the US", () => {
    const none = applyHandoff(parseHandoff("?from=tool&tool=fire&v=1&age=35")!, NOW).answers;
    expect(none.country).toBe("US");
    expect(none.currency).toBe("USD");
    const eur = applyHandoff(parseHandoff("?from=tool&tool=fire&v=1&cur=EUR")!, NOW).answers;
    expect(eur.country).toBe("US");
    expect(eur.currency).toBe("EUR");
    const gbp = applyHandoff(parseHandoff("?from=tool&tool=fire&v=1&cur=GBP")!, NOW).answers;
    expect(gbp.country).toBe("GB");
  });
});

describe("a US start asks for the state", () => {
  const filled = (country: string, region?: string) => ({
    ...defaultAnswers(country, NOW),
    ...(region ? { region } : {}),
    you: { name: "Robin", birthMonth: "1985-04" },
  });

  it("only the US needs a region before setup can finish", () => {
    expect(regionRequired("US")).toBe(true);
    for (const c of ["GB", "CA", "ES", "AU", "AE", "DE", "XX", "ZZ"])
      expect(regionRequired(c)).toBe(false);
  });

  it("flags a missing state, and accepts the answers once one is chosen", () => {
    expect(validateAnswers(filled("US"), NOW).region).toMatch(/Choose your state/);
    expect(validateAnswers(filled("US", "TX"), NOW)).toEqual({});
    expect(validateAnswers(filled("GB"), NOW)).toEqual({});
    expect(validateAnswers(filled("CA"), NOW)).toEqual({});
  });

  it("with a state, the plan uses the US tax estimate rather than flat rates", () => {
    const doc = buildSetupDocument(filled("US", "TX"), { now: NOW });
    expect(doc.household.location).toEqual({ country: "US", region: "TX" });
    expect(doc.plans[0]!.tax.mode).toBe("estimate");
  });
});

describe("empty accounts list: quick-add types follow the country", () => {
  it("offers each country its own typical accounts", () => {
    expect(quickAccountTypes("US")).toEqual([
      "cash",
      "savings",
      "roth-ira",
      "traditional-ira",
      "401k",
      "taxable",
    ]);
    expect(quickAccountTypes("GB")).toEqual([
      "cash",
      "savings",
      "uk-isa",
      "uk-sipp",
      "uk-workplace-pension",
      "uk-gia",
    ]);
    expect(quickAccountTypes("CA")).toEqual([
      "cash",
      "savings",
      "ca-tfsa",
      "ca-rrsp",
      "ca-non-registered",
    ]);
    expect(quickAccountTypes("DE")).toEqual(["cash", "savings", "de-ruerup", "de-bav", "taxable"]);
    expect(quickAccountTypes("XX")).toEqual([
      "cash",
      "savings",
      "generic-tax-free",
      "generic-tax-deferred",
      "taxable",
    ]);
  });

  it("never offers another country's accounts", () => {
    for (const c of ["US", "GB", "CA", "DE", "XX"])
      for (const t of quickAccountTypes(c)) {
        const owner = ACCOUNT_TYPE_INFO[t].country ?? null;
        expect(owner === null || owner === c, `${c}: ${t}`).toBe(true);
      }
  });
});
