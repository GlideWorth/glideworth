/**
 * Rule of 55 check: every boundary of the separation-from-service exception, against the statute and
 * IRS Publication 575 (sources and dates in engine/rule-of-55.ts).
 *
 * - 26 U.S.C. 72(t)(2)(A)(v): separation from service after attainment of age 55; Pub 575 (2025),
 *   "Separation from service": in or after the calendar year you reach 55. Its example: someone who
 *   separated at 49 does not qualify for a distribution in the year they reach 55.
 * - 72(t)(10)(A): "age 50 or 25 years of service under the plan, whichever is earlier" for qualified
 *   public safety employees (governmental plan) and private-sector firefighters.
 * - 72(t)(3)(A): the exception does not apply to distributions from an individual retirement plan.
 * - IRS exceptions table, footnote: governmental 457(b) distributions are not subject to the 10%.
 */
import { US_FIXED } from "@glideworth/core";
import { describe, expect, it } from "vitest";
import { runTool } from "./engine";
import {
  ACCESS_AGE,
  checkRuleOf55,
  monthsText,
  PENALTY_RATE,
  PUBLIC_SAFETY_AGE,
  PUBLIC_SAFETY_SERVICE,
  type Rule55Input,
  SEPARATION_AGE,
} from "./engine/rule-of-55";
import { renderResults } from "./render";
import { SPECS } from "./specs";
import { defaults, fromQuery, toQuery, validate } from "./state";
import type { Values } from "./types";

const BORN = 1971;
const base: Rule55Input = {
  birthYear: BORN,
  birthMonth: 6,
  leaveYear: BORN + 55,
  source: "this-plan",
  planType: "qualified",
  oldLeaveYear: 2015,
  publicSafety: false,
  serviceYears: 0,
};
const check = (over: Partial<Rule55Input>) => checkRuleOf55({ ...base, ...over });
const spec = SPECS["rule-of-55"];
const vals = (over: Values = {}): Values => ({ ...defaults(spec), ...over });

describe("rule of 55: figures", () => {
  it("uses the statutory ages and rate", () => {
    // 72(t)(1) 10 percent; 72(t)(2)(A)(i) age 59½, as core holds them.
    expect(PENALTY_RATE).toBe(0.1);
    expect(PENALTY_RATE).toBe(US_FIXED.earlyWithdrawalPenalty);
    expect(ACCESS_AGE).toBe(59.5);
    expect(SEPARATION_AGE).toBe(55);
    expect(PUBLIC_SAFETY_AGE).toBe(50);
    expect(PUBLIC_SAFETY_SERVICE).toBe(25);
  });
});

describe("rule of 55: the separation year", () => {
  it.each([
    [54, "does-not-apply"],
    [55, "applies"],
    [56, "applies"],
  ] as const)("leaving in the year you turn %i: %s", (age, status) => {
    const r = check({ leaveYear: BORN + age });
    expect(r.status).toBe(status);
    expect(r.separationAge).toBe(age);
  });

  it("counts the calendar year, not the birthday: born in December, leaving in January of the year you turn 55", () => {
    expect(check({ birthMonth: 12, leaveYear: BORN + 55 }).status).toBe("applies");
  });
});

describe("rule of 55: public safety", () => {
  it.each([
    [49, "does-not-apply"],
    [50, "applies"],
    [51, "applies"],
  ] as const)("age %i in the year of leaving: %s", (age, status) => {
    expect(check({ publicSafety: true, leaveYear: BORN + age, serviceYears: 10 }).status).toBe(
      status,
    );
  });

  it.each([
    [24, "does-not-apply"],
    [25, "applies"],
    [26, "applies"],
  ] as const)("%i years of service at 45: %s", (svc, status) => {
    const r = check({ publicSafety: true, leaveYear: BORN + 45, serviceYears: svc });
    expect(r.status).toBe(status);
    expect(r.byService).toBe(svc >= 25);
  });

  it("does not use the public safety age for others", () => {
    expect(check({ leaveYear: BORN + 50 }).status).toBe("does-not-apply");
    // Years of service count only for public safety employees.
    expect(check({ leaveYear: BORN + 45, serviceYears: 30 }).status).toBe("does-not-apply");
  });
});

describe("rule of 55: where the money is", () => {
  it("left in the plan versus rolled to an IRA", () => {
    expect(check({ source: "this-plan" }).status).toBe("applies");
    expect(check({ source: "ira" }).status).toBe("ira");
    // An IRA never qualifies, whatever the age or job.
    expect(check({ source: "ira", leaveYear: BORN + 58, publicSafety: true }).status).toBe("ira");
  });

  it("an old employer's plan versus the current one (Pub 575: left at 49, not at 55)", () => {
    const old = check({ source: "old-plan", oldLeaveYear: BORN + 49, leaveYear: BORN + 55 });
    expect(old.status).toBe("does-not-apply");
    expect(old.separationYear).toBe(BORN + 49);
    expect(check({ source: "this-plan", leaveYear: BORN + 55 }).status).toBe("applies");
    // An earlier employer left in the year you turned 55 does qualify.
    expect(
      check({ source: "old-plan", oldLeaveYear: BORN + 55, leaveYear: BORN + 57 }).status,
    ).toBe("applies");
    expect(
      check({ source: "old-plan", oldLeaveYear: BORN + 54, leaveYear: BORN + 57 }).status,
    ).toBe("does-not-apply");
  });

  it("a governmental 457(b) does not need the exception", () => {
    expect(check({ planType: "gov457", leaveYear: BORN + 40 }).status).toBe("not-needed");
  });
});

describe("rule of 55: the bridge to 59½", () => {
  it("counts months from the end of the year you leave to the month you reach 59½", () => {
    // Born June 1971: 59½ in December 2030. Leaving in 2026: January 2027 to December 2030.
    const r = check({});
    expect(r.accessMonth).toBe(2030 * 12 + 11);
    expect(r.bridgeMonths).toBe(3 * 12 + 11);
    expect(monthsText(r.bridgeMonths)).toBe("3 years 11 months");
    // Born July: 59½ in January of the year after 59.
    expect(check({ birthMonth: 7 }).accessMonth).toBe(2031 * 12);
    expect(check({ leaveYear: BORN + 60 }).bridgeMonths).toBe(0);
  });

  it("72(t) payments run to the later of five years and 59½; the ladder's first rung is five years on", () => {
    const r = check({});
    expect(r.seppUntilMonth).toBe(2032 * 12); // January 2027 + 5 years, after December 2030
    expect(check({ leaveYear: BORN + 50 }).seppUntilMonth).toBe(2030 * 12 + 11); // 59½ is later
    expect(r.ladderFirstYear).toBe(BORN + 55 + 5);
  });

  it("formats months", () => {
    expect(monthsText(0)).toBe("0 months");
    expect(monthsText(1)).toBe("1 month");
    expect(monthsText(12)).toBe("1 year");
    expect(monthsText(25)).toBe("2 years 1 month");
  });
});

describe("rule of 55: the calculator", () => {
  it("default inputs: leaving the year you turn 55 applies", async () => {
    const vm = await runTool("rule-of-55", vals());
    expect(vm.figures[0]!.value).toBe("Applies");
    expect(vm.headline).toMatch(/lets you take money/);
    expect(vm.headline).toMatch(/Income tax still applies/);
    expect(vm.table!.rows.map((r) => r[0])).toEqual([
      "Rule of 55",
      "72(t) payments",
      "Roth IRA contributions",
      "Roth conversion ladder",
      "Taxable savings",
    ]);
    const html = renderResults(vm);
    expect(html).not.toMatch(/NaN|undefined|Infinity/);
  });

  it.each([
    [{ leave: 2025 }, "Does not apply"],
    [{ leave: 2026 }, "Applies"],
    [{ leave: 2027 }, "Applies"],
    [{ src: "ira" }, "Does not apply"],
    [{ src: "old-plan", oldLeave: 2020 }, "Does not apply"],
    [{ src: "old-plan", oldLeave: 2026, leave: 2028 }, "Applies"],
    [{ ps: "yes", leave: 2020, svc: 10 }, "Does not apply"],
    [{ ps: "yes", leave: 2021, svc: 10 }, "Applies"],
    [{ ps: "yes", leave: 2016, svc: 25 }, "Applies"],
    [{ type: "gov457", leave: 2016 }, "Not needed"],
  ] as const)("%o: %s", async (over, status) => {
    const v = vals(over as Values);
    expect(validate(spec, v)).toEqual({});
    const vm = await runTool("rule-of-55", v);
    expect(vm.figures[0]!.value).toBe(status);
    expect(renderResults(vm)).not.toMatch(/NaN|undefined|Infinity/);
  });

  it("past 59½ there is nothing to bridge", async () => {
    const vm = await runTool("rule-of-55", vals({ leave: 2032 }));
    expect(vm.figures[2]!.value).toBe("None");
    expect(vm.table!.rows.map((r) => r[0])).toEqual(["Rule of 55", "Any account after 59½"]);
  });

  it("a ladder that would finish after 59½ is too late to help", async () => {
    const vm = await runTool("rule-of-55", vals({ leave: 2028 }));
    expect(vm.table!.rows.find((r) => r[0] === "Roth conversion ladder")![1]).toBe(
      "Too late to help",
    );
  });

  it("validates the years", () => {
    expect(validate(spec, vals({ by: 2005, leave: 2015 })).leave).toBeDefined();
    expect(validate(spec, vals({ src: "old-plan", oldLeave: 2030 })).oldLeave).toBeDefined();
    expect(validate(spec, vals({ ps: "yes", svc: 45 })).svc).toBeDefined();
    // A hidden field is not checked.
    expect(validate(spec, vals({ src: "this-plan", oldLeave: 2030 }))).toEqual({});
  });

  it("round-trips through the page address", () => {
    const v = vals({ src: "old-plan", oldLeave: 2010, ps: "yes", svc: 22, bm: "11" });
    const back = fromQuery(spec, `?${toQuery(spec, v)}`);
    expect(back.invalid).toEqual([]);
    expect(back.values).toEqual(v);
  });
});
