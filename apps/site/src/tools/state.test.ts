/** URL state, validation and the planner hand-off link. */
import { describe, expect, it } from "vitest";
import { site } from "../config/site";
import { plannerUrl } from "./carry";
import { SPECS } from "./specs";
import { defaults, fromQuery, parseNumber, STATE_VERSION, toQuery, validate } from "./state";
import type { ToolSpec, Values } from "./types";

const specs = Object.values(SPECS);

/** Values other than the defaults that are valid for the spec: middle of every numeric range, last option. */
function nonDefault(spec: ToolSpec): Values {
  const v = defaults(spec);
  for (const f of spec.fields) {
    if (f.kind === "select") v[f.key] = f.options[f.options.length - 1]!.value;
    else {
      const mid = f.min + (f.max - f.min) * 0.37;
      v[f.key] = f.step >= 1 ? Math.round(mid) : Number(mid.toFixed(2));
    }
  }
  // Keep cross-field rules satisfied.
  if (spec.id === "coast-fire") Object.assign(v, { age: 40, retire: 65 });
  if (spec.id === "barista-fire") Object.assign(v, { age: 45, ptUntil: 55, planTo: 92 });
  return v;
}

describe("parseNumber", () => {
  it.each([
    ["1,000,000", 1_000_000],
    ["$ 40 000", 40_000],
    ["£1,234.5", 1234.5],
    ["4.5%", 4.5],
    ["−3", -3],
    ["-0.5", -0.5],
    [".25", 0.25],
    ["  7 ", 7],
  ])("reads %s", (raw, n) => expect(parseNumber(raw)).toBe(n));
  it.each(["", "abc", "1.2.3", "12abc", "--4", "NaN", "Infinity"])("rejects %s", (raw) =>
    expect(parseNumber(raw)).toBeNaN(),
  );
});

describe("URL state", () => {
  it.each(specs.map((s) => [s.id, s] as const))(
    "%s: defaults round-trip through the query string",
    (_, spec) => {
      const q = toQuery(spec, defaults(spec));
      expect(q).toContain(`v=${STATE_VERSION}`);
      const back = fromQuery(spec, `?${q}`);
      expect(back.present).toBe(true);
      expect(back.invalid).toEqual([]);
      expect(back.values).toEqual(defaults(spec));
    },
  );

  it.each(specs.map((s) => [s.id, s] as const))(
    "%s: other values round-trip and validate",
    (_, spec) => {
      const v = nonDefault(spec);
      expect(validate(spec, v)).toEqual({});
      const back = fromQuery(spec, toQuery(spec, v));
      expect(back.invalid).toEqual([]);
      expect(back.values).toEqual(v);
    },
  );

  it("ignores unknown keys, reports unreadable ones and keeps their defaults", () => {
    const spec = SPECS["how-long"];
    const r = fromQuery(spec, "?balance=250000&spend=lots&ret=99&utm_source=x&cur=XYZ");
    expect(r.present).toBe(true);
    expect(r.values.balance).toBe(250_000);
    expect(r.values.spend).toBe(30_000);
    expect(r.values.ret).toBe(4);
    expect(r.values.cur).toBe("USD");
    expect(r.invalid.sort()).toEqual(["cur", "ret", "spend"]);
  });

  it("an empty query opens the defaults and says nothing was given", () => {
    const r = fromQuery(SPECS.fire, "");
    expect(r.present).toBe(false);
    expect(r.values).toEqual(defaults(SPECS.fire));
  });
});

describe("validation", () => {
  it("flags out-of-range and non-whole inputs on the field", () => {
    const spec = SPECS["coast-fire"];
    const e = validate(spec, { ...defaults(spec), age: 30.5, wr: 0, balance: -1 });
    expect(e.age).toMatch(/whole number/);
    expect(e.wr).toMatch(/at least/);
    expect(e.balance).toMatch(/at least 0/);
  });
  it("flags a retirement age that is not after the current age", () => {
    const spec = SPECS["coast-fire"];
    expect(validate(spec, { ...defaults(spec), age: 60, retire: 60 }).retire).toMatch(
      /after your age/,
    );
  });
  it("flags part-time work that ends outside the plan", () => {
    const spec = SPECS["barista-fire"];
    expect(validate(spec, { ...defaults(spec), ptUntil: 40 }).ptUntil).toMatch(/before you leave/);
    expect(validate(spec, { ...defaults(spec), ptUntil: 95 }).ptUntil).toMatch(/after the plan/);
    expect(validate(spec, { ...defaults(spec), planTo: 45 }).planTo).toBeDefined();
  });
  it("ignores fields hidden by the market model", () => {
    const spec = SPECS["monte-carlo"];
    // Volatility only applies to random returns; with history selected a bad value is not an error.
    expect(validate(spec, { ...defaults(spec), method: "history", vol: 999 })).toEqual({});
    expect(validate(spec, { ...defaults(spec), method: "parametric", vol: 999 }).vol).toBeDefined();
  });
  it("every default is valid", () => {
    for (const s of specs) expect(validate(s, defaults(s)), s.id).toEqual({});
  });
});

describe("planner hand-off link", () => {
  it("carries the tool id, the format version and every input", () => {
    const spec = SPECS["barista-fire"];
    const url = new URL(plannerUrl(spec, defaults(spec)));
    expect(`${url.origin}${url.pathname}`).toBe(site.signupUrl);
    expect(url.searchParams.get("from")).toBe("tool");
    expect(url.searchParams.get("tool")).toBe("barista-fire");
    expect(url.searchParams.get("v")).toBe("1");
    for (const f of spec.fields) expect(url.searchParams.has(f.key), f.key).toBe(true);
    expect(url.searchParams.get("pt")).toBe("15000");
    expect(url.searchParams.get("ret")).toBe("3");
  });
  it("uses exactly the page query keys, so the app can parse one format", () => {
    for (const spec of specs) {
      const url = new URL(plannerUrl(spec, defaults(spec)));
      const page = new URLSearchParams(toQuery(spec, defaults(spec)));
      for (const [k, v] of page) expect(url.searchParams.get(k)).toBe(v);
    }
  });
});
