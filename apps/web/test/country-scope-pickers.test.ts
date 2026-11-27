import { accountTypesForCountry } from "@glideworth/core";
import { describe, expect, it } from "vitest";
import { suggestedAccounts } from "../src/features/onboarding/build-document";
import {
  accountTypeGroups,
  accountTypeOptions,
  incomeTypeMenu,
  incomeTypeOptions,
  otherCountryAccountTypeGroups,
} from "../src/features/plan-editor/state/labels";
import { COUNTRY_LIST } from "../src/lib/countries";

const values = (opts: { value: string }[]) => opts.map((o) => o.value);
const groupTypes = (gs: { types: string[] }[]) => gs.flatMap((g) => g.types);

describe("account type pickers offer the household's country and generic types", () => {
  it("shows a US household no UK types", () => {
    const opts = values(accountTypeOptions("US"));
    expect(opts).toEqual(expect.arrayContaining(["401k", "roth-ira", "taxable", "savings"]));
    expect(opts.filter((t) => t.startsWith("uk-"))).toEqual([]);
    expect(groupTypes(accountTypeGroups("US")).filter((t) => t.startsWith("uk-"))).toEqual([]);
  });

  it("shows a UK household no 401(k) or IRA", () => {
    const opts = values(accountTypeOptions("GB"));
    expect(opts).toEqual(expect.arrayContaining(["uk-isa", "uk-sipp", "uk-gia", "savings"]));
    expect(opts).not.toContain("401k");
    expect(opts).not.toContain("roth-ira");
    expect(groupTypes(accountTypeGroups("GB"))).not.toContain("401k");
  });

  it("shows 'somewhere else' the generic types only", () => {
    expect(accountTypeGroups("XX").map((g) => g.label)).toEqual(["Any country"]);
    expect(values(accountTypeOptions("XX"))).toEqual(accountTypesForCountry("XX"));
  });

  it("keeps a foreign-typed account's own type in its select", () => {
    const opts = accountTypeOptions("US", { type: "uk-isa" });
    expect(values(opts)).toContain("uk-isa");
    expect(opts.find((o) => o.value === "uk-isa")!.group).toBe("United Kingdom");
  });

  it("offers an account abroad its country's types", () => {
    const opts = values(accountTypeOptions("US", { type: "taxable", jurisdiction: "GB" }));
    expect(opts).toEqual(expect.arrayContaining(["uk-isa", "uk-sipp", "uk-gia", "401k"]));
    expect(opts).not.toContain("ca-tfsa");
    expect(new Set(opts).size).toBe(opts.length);
  });

  it("adds nothing for a home account", () => {
    expect(accountTypeOptions("US", { type: "401k" })).toEqual(accountTypeOptions("US"));
    expect(accountTypeOptions("US", { type: "taxable", jurisdiction: "US" })).toEqual(
      accountTypeOptions("US"),
    );
  });

  it("keeps other countries' types reachable from the add-account menus", () => {
    const foreign = otherCountryAccountTypeGroups("US");
    expect(foreign.map((g) => g.label)).toContain("United Kingdom");
    expect(foreign.map((g) => g.label)).not.toContain("United States");
    expect(groupTypes(foreign)).toEqual(expect.arrayContaining(["uk-isa", "ca-tfsa"]));
    expect(groupTypes(foreign)).not.toContain("taxable");
  });

  it.each(COUNTRY_LIST.map((c) => c.code))(
    "offers every onboarding suggestion for %s in its select",
    (c) => {
      const opts = values(accountTypeOptions(c));
      for (const s of suggestedAccounts(c)) expect(opts, s.type).toContain(s.type);
    },
  );
});

describe("income type pickers", () => {
  it("adds Social Security for the US and the State Pension for the UK, not the other", () => {
    const us = values(incomeTypeMenu("US").home);
    expect(us).toContain("social-security");
    expect(us).not.toContain("state-pension");
    expect(values(incomeTypeMenu("US").other)).toContain("state-pension");
    const gb = values(incomeTypeOptions("GB"));
    expect(gb).toContain("state-pension");
    expect(gb).not.toContain("social-security");
    expect(gb).not.toContain("ca-cpp");
  });

  it("keeps an income's current type and offers its own country's types", () => {
    expect(values(incomeTypeOptions("GB", { type: "social-security" }))).toContain(
      "social-security",
    );
    const abroad = values(incomeTypeOptions("GB", { type: "pension", country: "CA" }));
    expect(abroad).toEqual(expect.arrayContaining(["ca-cpp", "ca-oas", "ca-gis", "state-pension"]));
    expect(abroad).not.toContain("social-security");
  });

  it("labels country-specific income types with their countries", () => {
    const ss = incomeTypeOptions("US").find((o) => o.value === "social-security")!;
    expect(ss.hint).toBe("US");
    expect(incomeTypeOptions("US").find((o) => o.value === "salary")!.hint).toBeUndefined();
  });
});
