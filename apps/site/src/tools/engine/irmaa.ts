/**
 * Medicare IRMAA calculator: the income-related monthly adjustment (Part B and Part D surcharges) for a
 * MAGI and filing status, in the premium years Glideworth's data holds, and the distance to the next tier.
 *
 * Every figure comes from @glideworth/core: `US_IRMAA_YEARS` (one table per premium year, each with its
 * official source: SSA POMS HI 01101.020 for 2026, the CMS fact sheet for 2027), `irmaaMonthly` (the
 * monthly surcharge; tiers are cliffs, a MAGI above a tier's lower bound pays all of it) and
 * `irmaaThresholds` (the tiers' lower bounds). The Part B and Part D split is read from the same rows.
 */
import { type FilingStatus, irmaaMonthly, irmaaThresholds, US_IRMAA_YEARS } from "@glideworth/core";
import { money } from "../format";
import { num, str } from "../state";
import type { ChartSpec, Values, ViewModel } from "../types";

const CUR = "USD";

/**
 * Years between the tax return and the premium year. This is how the engine's US tax model looks back
 * (`history[length - 2]` in core's us-federal computeYear; TAX_SIMPLIFICATIONS: "estimated from the MAGI
 * of two years earlier").
 */
export const LOOKBACK_YEARS = 2;

type IrmaaYear = (typeof US_IRMAA_YEARS)[number];

/** Dollars and cents, as premiums are published. */
export function dollars(x: number): string {
  if (!Number.isFinite(x)) return "–";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: CUR }).format(
    Math.abs(x) < 0.005 ? 0 : x,
  );
}

export function irmaaYear(year: number): IrmaaYear {
  const t = US_IRMAA_YEARS.find((y) => y.year === year);
  if (!t) throw new Error(`no IRMAA table for ${year}`);
  return t;
}

/** The rows core uses for a filing status (same choice as core's irmaaMonthly). */
export function rowsFor(status: FilingStatus, t: IrmaaYear): [number, number, number][] {
  if (status === "married-joint") return t.joint;
  if (status === "married-separate") return t.separate;
  return t.single;
}

export interface Tier {
  /** 0 is the standard premium (no surcharge). */
  tier: number;
  /** MAGI must be above this to be in the tier (exclusive); null for tier 0. */
  above: number | null;
  /** The next tier starts above this; null for the top tier. */
  upTo: number | null;
  partB: number;
  partBSurcharge: number;
  partD: number;
  /** Monthly surcharge per person (Part B above standard + Part D). */
  monthly: number;
}

export function tiers(status: FilingStatus, t: IrmaaYear): Tier[] {
  const rows = rowsFor(status, t);
  const thr = irmaaThresholds(status, 1, t);
  const out: Tier[] = [
    {
      tier: 0,
      above: null,
      upTo: thr[0] ?? null,
      partB: t.standardPartB,
      partBSurcharge: 0,
      partD: 0,
      monthly: 0,
    },
  ];
  rows.forEach(([, b, d], i) =>
    out.push({
      tier: i + 1,
      above: thr[i]!,
      upTo: thr[i + 1] ?? null,
      partB: b,
      partBSurcharge: b - t.standardPartB,
      partD: d,
      monthly: b - t.standardPartB + d,
    }),
  );
  return out;
}

/** The tier a MAGI falls in: the number of lower bounds it is above. */
export function tierOf(magi: number, status: FilingStatus, t: IrmaaYear): number {
  return irmaaThresholds(status, 1, t).filter((lo) => magi > lo).length;
}

const lower = (lo: number) =>
  Number.isInteger(lo) ? `more than ${money(lo, CUR)}` : `${money(Math.ceil(lo), CUR)} or more`;
const upper = (hi: number) =>
  Number.isInteger(hi) ? `up to ${money(hi, CUR)}` : `less than ${money(Math.ceil(hi), CUR)}`;

/** "Up to $109,000", "More than $109,000 and up to $137,000", "$500,000 or more". */
export function rangeText(t: Tier): string {
  const s =
    t.above === null
      ? t.upTo === null
        ? "any MAGI"
        : upper(t.upTo)
      : t.upTo === null
        ? lower(t.above)
        : `${lower(t.above)} and ${upper(t.upTo)}`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const STATUS_TEXT: Record<FilingStatus, string> = {
  single: "a single filer",
  "married-joint": "a married couple filing jointly",
  "married-separate": "someone married filing separately",
  "head-of-household": "a head of household",
  "qualifying-surviving-spouse": "a qualifying surviving spouse",
};

export async function runIrmaa(v: Values): Promise<ViewModel> {
  const magi = num(v, "magi");
  const status = str(v, "status") as FilingStatus;
  const year = Number(str(v, "year"));
  const people = status === "married-joint" ? Number(str(v, "people")) : 1;
  const t = irmaaYear(year);
  const all = tiers(status, t);
  const k = tierOf(magi, status, t);
  const mine = all[k]!;
  const monthly = irmaaMonthly(magi, status, 1, t);
  const incomeYear = year - LOOKBACK_YEARS;
  const next = all[k + 1];
  const top = all.length - 1;
  const m = (x: number) => money(x, CUR);
  const per = people === 2 ? " each" : "";

  const headline =
    k === 0
      ? `With ${incomeYear} MAGI of ${m(magi)}, ${STATUS_TEXT[status]} pays no IRMAA in ${year}. The standard Part B premium is ${dollars(t.standardPartB)} a month.`
      : `With ${incomeYear} MAGI of ${m(magi)}, ${STATUS_TEXT[status]} pays ${dollars(monthly)} a month${per} more for Medicare in ${year}: ${dollars(mine.partBSurcharge)} on Part B and ${dollars(mine.partD)} on Part D (tier ${k} of ${top}).`;

  const nextFigure = next
    ? {
        label: "Next tier",
        value: `${m(next.above! - magi)} away`,
        detail: `MAGI ${lower(next.above!)} adds ${dollars(next.monthly - mine.monthly)} a month${per}`,
      }
    : { label: "Next tier", value: "None", detail: "You are in the top tier" };

  const chart: ChartSpec = {
    id: "irmaa-chart",
    kind: "bar",
    title: `Yearly IRMAA per person by tier, ${year} (${STATUS_TEXT[status]})`,
    summary: `The surcharge rises in steps from nothing to ${m(all[top]!.monthly * 12)} a year per person in the top tier. With MAGI of ${m(magi)} you are in ${k === 0 ? "the standard tier, with no surcharge" : `tier ${k}, at ${m(mine.monthly * 12)} a year per person`}.`,
    xLabel: "Tier (0 = standard premium)",
    yLabel: "Dollars a year",
    x: all.map((x) => x.tier),
    series: [
      {
        label: "Yearly surcharge per person",
        values: all.map((x) => x.monthly * 12),
        tone: 1,
        style: "solid",
      },
      {
        label: "Your tier",
        values: all.map((x) => (x.tier === k ? x.monthly * 12 : null)),
        tone: 2,
        style: "solid",
      },
    ],
    currency: CUR,
    table: {
      caption: `Yearly surcharge per person by tier, ${year}`,
      columns: ["Tier", `MAGI in ${incomeYear}`, "Yearly surcharge"],
      rows: all.map((x) => [
        x.tier === k ? `${x.tier} (you)` : String(x.tier),
        rangeText(x),
        m(x.monthly * 12),
      ]),
    },
  };

  const otherYears = US_IRMAA_YEARS.map((y) => {
    const kk = tierOf(magi, status, y);
    const mm = irmaaMonthly(magi, status, 1, y);
    return [
      String(y.year),
      String(y.year - LOOKBACK_YEARS),
      kk === 0 ? "Standard" : String(kk),
      dollars(mm),
      m(mm * 12 * people),
    ];
  });

  return {
    tool: "irmaa",
    headline,
    announce: k === 0 ? `No IRMAA in ${year}.` : `IRMAA tier ${k}: ${dollars(monthly)} a month.`,
    figures: [
      {
        label: `IRMAA tier, ${year}`,
        value: k === 0 ? "None" : `${k} of ${top}`,
        detail: rangeText(mine),
      },
      {
        label: "Extra a month, per person",
        value: dollars(monthly),
        detail: `Part B ${dollars(mine.partBSurcharge)} + Part D ${dollars(mine.partD)}`,
      },
      {
        label: people === 2 ? "Extra a year, both of you" : "Extra a year",
        value: m(monthly * 12 * people),
        detail: `Part B premium ${dollars(mine.partB)} a month`,
      },
      nextFigure,
    ],
    table: {
      caption: `IRMAA tiers for ${year} premiums, ${STATUS_TEXT[status]}, from ${incomeYear} MAGI (per person, per month)`,
      columns: ["Tier", "MAGI", "Part B premium", "Part B surcharge", "Part D surcharge"],
      rows: all.map((x) => [
        x.tier === k ? `${x.tier} (you)` : String(x.tier),
        rangeText(x),
        dollars(x.partB),
        dollars(x.partBSurcharge),
        dollars(x.partD),
      ]),
    },
    charts: [chart],
    extraTables: [
      {
        caption: "The same MAGI in each premium year Glideworth has",
        columns: [
          "Premium year",
          "Income year",
          "Tier",
          "Extra a month, per person",
          people === 2 ? "Extra a year, both" : "Extra a year",
        ],
        rows: otherYears,
      },
    ],
    method: [
      `Tiers and premiums: Glideworth’s US data for ${year} (${t.source}).`,
      "Surcharge: irmaaMonthly() and irmaaThresholds() from the engine’s US tax model, the same functions the planner’s tax estimate uses. Tiers are cliffs: MAGI one dollar above a tier’s lower bound pays the whole tier.",
      `Income year: premiums for ${year} use MAGI from ${incomeYear}, ${LOOKBACK_YEARS} years earlier, as the planner’s estimate does.`,
      "Part D figures are the income-related adjustment only; your drug plan’s own premium is not included.",
    ],
    warnings: [],
  };
}
