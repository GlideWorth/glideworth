import { describe, expect, it } from "vitest";
import {
  ACCOUNT_TYPES,
  accountTypeCountry,
  accountTypesForCountry,
  defaultsForCountry,
  IncomeEvent,
  incomeTypeCountries,
  incomeTypesForCountry,
  isAccountTypeForCountry,
  isIncomeTypeForCountry,
} from "../src/index.js";

const SUPPORTED = ["US", "GB", "CA", "AU", "DE", "NL", "FR", "ES", "IL", "IE", "NZ", "AE"];
const generic = ACCOUNT_TYPES.filter((t) => accountTypeCountry(t) === null);

describe("account types by country", () => {
  it("places every account type in exactly one country or in none (generic)", () => {
    for (const t of ACCOUNT_TYPES) {
      const owners = SUPPORTED.filter(
        (c) => accountTypesForCountry(c).includes(t) && accountTypeCountry(t) !== null,
      );
      if (accountTypeCountry(t) === null) {
        expect(owners, t).toEqual([]);
        for (const c of [...SUPPORTED, "XX"]) expect(accountTypesForCountry(c), t).toContain(t);
      } else {
        expect(owners, t).toEqual([accountTypeCountry(t)]);
      }
    }
  });

  it("gives a US household 401(k)s and Roth IRAs, not ISAs", () => {
    const us = accountTypesForCountry("US");
    expect(us).toEqual(expect.arrayContaining(["401k", "roth-ira", "traditional-ira", "hsa"]));
    expect(us.filter((t) => t.startsWith("uk-"))).toEqual([]);
    expect(isAccountTypeForCountry("uk-isa", "US")).toBe(false);
    expect(isAccountTypeForCountry("roth-ira", "US")).toBe(true);
  });

  it("gives a UK household ISAs and SIPPs, not 401(k)s", () => {
    const gb = accountTypesForCountry("GB");
    expect(gb).toEqual(expect.arrayContaining(["uk-isa", "uk-sipp", "uk-gia"]));
    expect(gb).not.toContain("401k");
    expect(gb).not.toContain("roth-ira");
    expect(isAccountTypeForCountry("401k", "GB")).toBe(false);
  });

  it("gives 'XX' and countries without types of their own the generic types only", () => {
    expect(accountTypesForCountry("XX")).toEqual(generic);
    expect(accountTypesForCountry("IT")).toEqual(generic);
    expect(generic).toEqual(
      expect.arrayContaining(["cash", "savings", "taxable", "generic-tax-free", "other"]),
    );
  });

  it("keeps ACCOUNT_TYPES order and accepts lower-case country codes", () => {
    const fr = accountTypesForCountry("FR");
    expect(fr).toEqual(ACCOUNT_TYPES.filter((t) => fr.includes(t)));
    expect(accountTypesForCountry("fr")).toEqual(fr);
  });

  it.each([...SUPPORTED, "XX"])("offers every default account type for %s", (c) => {
    const offered = accountTypesForCountry(c);
    for (const t of Object.values(defaultsForCountry(c).accountTypes))
      if (t !== null) expect(offered, `${c} default ${t}`).toContain(t);
  });
});

describe("income types by country", () => {
  const allIncomeTypes = IncomeEvent.options.map((o) => o.shape.type.value);

  it("lists every income type in schema order", () => {
    const offered = new Set([...SUPPORTED, "XX"].flatMap((c) => incomeTypesForCountry(c)));
    expect(offered).toEqual(new Set(allIncomeTypes));
    for (const t of allIncomeTypes) expect(incomeTypeCountries(t), t).not.toBeUndefined();
    const generic = allIncomeTypes.filter((t) => incomeTypeCountries(t) === null);
    expect(incomeTypesForCountry("IT")).toEqual(generic);
  });

  it("keeps Social Security in the US and CPP, OAS and GIS in Canada", () => {
    expect(incomeTypesForCountry("US")).toContain("social-security");
    expect(incomeTypesForCountry("US")).not.toContain("state-pension");
    expect(incomeTypesForCountry("US")).not.toContain("ca-cpp");
    expect(incomeTypesForCountry("CA")).toEqual(
      expect.arrayContaining(["ca-cpp", "ca-oas", "ca-gis"]),
    );
    expect(incomeTypesForCountry("CA")).not.toContain("social-security");
    expect(isIncomeTypeForCountry("state-pension", "GB")).toBe(true);
    expect(isIncomeTypeForCountry("social-security", "GB")).toBe(false);
    expect(isIncomeTypeForCountry("salary", "XX")).toBe(true);
  });

  it.each([...SUPPORTED, "XX"])("offers the default government pension type for %s", (c) => {
    const sp = defaultsForCountry(c).statePension;
    if (sp) expect(incomeTypesForCountry(c), c).toContain(sp.incomeType);
  });
});
