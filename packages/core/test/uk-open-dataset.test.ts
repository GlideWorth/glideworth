/**
 * The openly licensed UK dataset `uk-1983` (data/uk-open.generated.ts), built by
 * data/scripts/build_uk_open.py to replace the non-commercial `uk-1871` (JST), and registered in
 * MARKET_DATASETS. Spot values are recomputed here from the published source cells quoted in each
 * comment.
 */
import { describe, expect, it } from "vitest";
import { DATASET_ATTRIBUTIONS, MARKET_DATASETS } from "../src/stochastic/data/index.js";
import { UK_1983_RAW } from "../src/stochastic/data/uk-open.generated.js";
import { US_1928_RAW } from "../src/stochastic/data/us.generated.js";

const ds = UK_1983_RAW;
const at = (y: number) => y - ds.firstYear;
const s = ds.series;
const value = (k: keyof typeof s, y: number) => {
  const v = s[k][at(y)];
  if (typeof v !== "number") throw new Error(`${k} ${y} missing`);
  return v;
};
const usAt = (y: number) => y - US_1928_RAW.firstYear;
const mean = (xs: readonly (number | null)[]) =>
  xs.reduce<number>((a, b) => a + (b ?? Number.NaN), 0) / xs.length;

describe("uk-1983 (open UK dataset)", () => {
  it("is registered with its coverage, limits and attribution stated where the user sees it", () => {
    const entry = MARKET_DATASETS["uk-1983"];
    expect(entry.series).toBe(UK_1983_RAW.series);
    expect(entry).toMatchObject({ region: "GB", currency: "GBP", firstYear: 1983 });
    // The label is generated from the data, so it cannot go stale after a rebuild.
    expect(entry.label).toContain(`UK 1983-${UK_1983_RAW.lastYear}`);
    expect(entry.label).toContain("US shares in sterling");
    expect(entry.limits).toMatch(/Only 43 years/);
    expect(entry.limits).toMatch(/more optimistic than long UK history/);
    // Open Government Licence attribution (a licence condition) and the Fed / Damodaran lines.
    expect(entry.attribution).toContain(
      "Contains public sector information licensed under the Open Government Licence v3.0.",
    );
    expect(entry.attribution).toContain("H.10");
    expect(entry.attribution).toContain("Damodaran");
    const ogl = DATASET_ATTRIBUTIONS.find((a) => a.id === "ogl-uk")!;
    expect(ogl.url).toBe(
      "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
    );
  });

  it("covers 1983 to the latest complete year with one value per year in every series", () => {
    expect(ds.firstYear).toBe(1983);
    expect(ds.lastYear).toBeGreaterThanOrEqual(2025);
    const n = ds.lastYear - ds.firstYear + 1;
    for (const [k, series] of Object.entries(s)) {
      expect(series, k).toHaveLength(n);
      for (const v of series) {
        expect(typeof v, k).toBe("number");
        expect(Number.isFinite(v as number), k).toBe(true);
      }
    }
  });

  it("keeps every value in a plausible range", () => {
    const within = (xs: readonly (number | null)[], lo: number, hi: number, name: string) => {
      for (const v of xs) {
        expect(v, name).toBeGreaterThanOrEqual(lo);
        expect(v, name).toBeLessThanOrEqual(hi);
      }
    };
    within(s.stocks, -0.6, 0.8, "stocks");
    within(s.dividendYield, 0, 0.1, "dividendYield");
    within(s.bondYield, 0, 0.16, "bondYield");
    within(s.bonds, -0.35, 0.35, "bonds");
    within(s.cash, 0.001, 0.16, "cash");
    within(s.inflation, -0.02, 0.12, "inflation");
    // Long-run sanity: averages near the known history of the period.
    expect(mean(s.inflation)).toBeGreaterThan(0.02);
    expect(mean(s.inflation)).toBeLessThan(0.04);
    expect(mean(s.cash)).toBeGreaterThan(0.03);
    expect(mean(s.cash)).toBeLessThan(0.06);
  });

  it("contains the 2022 UK inflation spike (ONS CPI D7BT Dec 2021 115.1, Dec 2022 127.2; D7G7 = 10.5%)", () => {
    expect(value("inflation", 2022)).toBeCloseTo(127.2 / 115.1 - 1, 6);
    expect(value("inflation", 2022)).toBeCloseTo(0.105, 3);
    expect(Math.max(...s.inflation.slice(at(1993)))).toBe(value("inflation", 2022));
  });

  it("matches ONS inflation spot values", () => {
    // CPI D7BT Dec 2024 135.6, Dec 2025 140.1 (D7G7 Dec 2025 = 3.4%).
    expect(value("inflation", 2025)).toBeCloseTo(140.1 / 135.6 - 1, 6);
    // CPI D7BT Dec 1988 50.6, Dec 1989 53.4: the first CPI year.
    expect(value("inflation", 1989)).toBeCloseTo(53.4 / 50.6 - 1, 6);
    // RPI long-run CDKO Dec 1982 325.5, Dec 1983 342.8 (before CPI exists).
    expect(value("inflation", 1983)).toBeCloseTo(342.8 / 325.5 - 1, 6);
  });

  it("matches Bank of England annual average Bank Rate (IUAABEDR)", () => {
    expect(value("cash", 1983)).toBeCloseTo(0.098571, 6);
    expect(value("cash", 2008)).toBeCloseTo(0.046821, 6);
    expect(value("cash", 2009)).toBeCloseTo(0.006423, 6);
    expect(value("cash", 2025)).toBeCloseTo(0.04252, 6);
  });

  it("prices gilts from the BoE 10-year zero-coupon yield (IUDMNZC, continuously compounded)", () => {
    const price = (c: number, y: number, n: number) =>
      (c * (1 - (1 + y) ** -n)) / y + (1 + y) ** -n;
    // 31 Dec 2021 0.9785%, 30 Dec 2022 3.7312%: the 2022 gilt sell-off.
    const c22 = Math.exp(0.009785) - 1;
    const y22 = Math.exp(0.037312) - 1;
    expect(value("bondYield", 2022)).toBeCloseTo(c22, 6);
    expect(value("bonds", 2022)).toBeCloseTo(price(c22, y22, 9) - 1, 6);
    expect(value("bonds", 2022) + value("bondYield", 2022)).toBeLessThan(-0.18);
    // 31 Dec 1982 11.3339%, 30 Dec 1983 10.7704%.
    const c83 = Math.exp(0.113339) - 1;
    expect(value("bondYield", 1983)).toBeCloseTo(c83, 6);
    expect(value("bonds", 1983)).toBeCloseTo(price(c83, Math.exp(0.107704) - 1, 9) - 1, 6);
  });

  it("converts Damodaran S&P 500 returns to sterling at Fed H.10 year-end rates", () => {
    // S&P 500 level 2007 1468.36, 2008 903.25, dividends 2008 28.39; USD per GBP 31 Dec 2007 1.9843,
    // 31 Dec 2008 1.4619.
    const conv08 = 1.9843 / 1.4619;
    expect(value("stocks", 2008)).toBeCloseTo((903.25 / 1468.36) * conv08 - 1, 6);
    expect(value("dividendYield", 2008)).toBeCloseTo((28.39 / 1468.36) * conv08, 6);
    // 2022: 4766.18 -> 3839.5, dividends 66.98; 30 Dec 2021 1.3500, 30 Dec 2022 1.2077.
    const conv22 = 1.35 / 1.2077;
    expect(value("stocks", 2022)).toBeCloseTo((3839.5 / 4766.18) * conv22 - 1, 6);
    expect(value("dividendYield", 2022)).toBeCloseTo((66.98 / 4766.18) * conv22, 6);
  });

  it("is the us-1928 equity series with one exchange-rate factor per year", () => {
    // (1 + stocksGBP) / (1 + stocksUSD) and dividendYieldGBP / dividendYieldUSD are both FX(y-1)/FX(y).
    for (let y = ds.firstYear; y <= Math.min(ds.lastYear, US_1928_RAW.lastYear); y++) {
      const fxFromPrice = (1 + value("stocks", y)) / (1 + US_1928_RAW.series.stocks[usAt(y)]!);
      const fxFromDiv = value("dividendYield", y) / US_1928_RAW.series.dividendYield[usAt(y)]!;
      expect(fxFromDiv, String(y)).toBeCloseTo(fxFromPrice, 3);
      expect(fxFromPrice).toBeGreaterThan(0.6);
      expect(fxFromPrice).toBeLessThan(1.6);
    }
  });
});
