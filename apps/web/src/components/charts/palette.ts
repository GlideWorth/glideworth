/**
 * Glideworth's single colour-assignment system for data. Every chart asks this module for a colour;
 * no chart picks hex values itself.
 *
 * Rules
 *  - Eight categorical slots in a FIXED order, stepped separately for light and dark surfaces.
 *    The order was validated (dataviz six-checks: lightness band, chroma floor, adjacent CVD
 *    ΔE ≥ 9 for protan/deutan/tritan, normal-vision ΔE ≥ 15) against the paper (#fbfaf6) and
 *    dark (#171c19) surfaces.
 *  - Colour follows the ENTITY, never its rank: account categories, tax kinds and cash-flow
 *    roles have fixed slots, so "Tax-free" is the same spruce in every chart and every mode.
 *  - Individual accounts inherit their category's hue, stepped toward the surface for the 2nd,
 *    3rd... account in that category. Grouping stays legible and colours stay stable across
 *    charts because the step comes from the account's position in Current Finances.
 *  - Identity is never colour-alone: charts keep legends / direct labels, and the optional
 *    "patterns" preference adds ECharts decals for colour-vision deficiency, print and
 *    forced-colours.
 */
import type { DrawdownCategory, TaxTreatment } from "@glideworth/core";

export type ThemeName = "light" | "dark";

/** Slot order: spruce, ochre, slate blue, terracotta, plum, moss, sky, rose. */
export const SERIES: Record<ThemeName, readonly string[]> = {
  light: ["#0f8262", "#c98419", "#3a6fc4", "#c4512f", "#8e55a8", "#5e9a3a", "#2a9bc9", "#d76a93"],
  dark: ["#1fa07a", "#b8842c", "#5b88d6", "#d06a48", "#a273bd", "#6e9e4c", "#3c9dc6", "#cf6f93"],
};

/** Neutral used for real assets / "other" so they never compete with the categorical slots. */
export const STONE: Record<ThemeName, string> = { light: "#9a8f7d", dark: "#8f8676" };

export const Slot = {
  Spruce: 0,
  Ochre: 1,
  Slate: 2,
  Terracotta: 3,
  Plum: 4,
  Moss: 5,
  Sky: 6,
  Rose: 7,
} as const;
export type Slot = (typeof Slot)[keyof typeof Slot];

const CATEGORY_SLOT: Record<Exclude<DrawdownCategory, "real-assets">, Slot> = {
  cash: Slot.Sky,
  taxable: Slot.Slate,
  crypto: Slot.Plum,
  "tax-deferred": Slot.Ochre,
  "tax-free": Slot.Spruce,
  hsa: Slot.Moss,
  education: Slot.Rose,
};

export function slotColor(theme: ThemeName, slot: number): string {
  const s = SERIES[theme];
  return s[((slot % s.length) + s.length) % s.length]!;
}

export function categoryColor(theme: ThemeName, c: DrawdownCategory): string {
  return c === "real-assets" ? STONE[theme] : slotColor(theme, CATEGORY_SLOT[c]);
}

export function treatmentColor(theme: ThemeName, t: TaxTreatment): string {
  return categoryColor(theme, t === "cash" ? "cash" : t);
}

/** Cash-flow roles (Sankey nodes, income-vs-expense charts). */
export type FlowRole =
  | "income"
  | "withdrawal"
  | "tax"
  | "expense"
  | "savings"
  | "debt"
  | "growth"
  | "pool"
  | "shortfall";
const ROLE_SLOT: Record<Exclude<FlowRole, "pool" | "shortfall">, Slot> = {
  income: Slot.Spruce,
  withdrawal: Slot.Sky,
  tax: Slot.Plum,
  expense: Slot.Ochre,
  savings: Slot.Slate,
  debt: Slot.Rose,
  growth: Slot.Moss,
};
export function roleColor(theme: ThemeName, role: FlowRole, negative: string): string {
  if (role === "pool") return STONE[theme];
  if (role === "shortfall") return negative;
  return slotColor(theme, ROLE_SLOT[role]);
}

/** Tax kinds (TaxLine.kind) — UK names map onto the same kinds (NI = payroll). */
const TAX_SLOT: Record<string, Slot> = {
  income: Slot.Slate,
  payroll: Slot.Plum,
  "self-employment": Slot.Plum,
  dividends: Slot.Ochre,
  "capital-gains": Slot.Moss,
  local: Slot.Sky,
  property: Slot.Sky,
  penalty: Slot.Terracotta,
  niit: Slot.Rose,
  amt: Slot.Rose,
  irmaa: Slot.Rose,
  wealth: Slot.Spruce,
};
export function taxKindColor(theme: ThemeName, kind: string): string {
  const s = TAX_SLOT[kind];
  return s === undefined ? STONE[theme] : slotColor(theme, s);
}

/** Outcome categories run along a diverging scale: deep spruce (surplus) → ochre → terracotta. */
const OUTCOME_COLOR: Record<ThemeName, Record<string, string>> = {
  light: {
    "large-surplus": "#0b5e47",
    comfortable: "#3f9a73",
    barely: "#c98419",
    almost: "#d9875f",
    "failed-mid": "#c4512f",
    "failed-early": "#8f2f1c",
  },
  dark: {
    "large-surplus": "#2fb489",
    comfortable: "#6fae8a",
    barely: "#c99a45",
    almost: "#d99070",
    "failed-mid": "#d06a48",
    "failed-early": "#b2442b",
  },
};
export function outcomeColor(
  theme: ThemeName,
  id: string,
  kind: "success" | "failure",
  i: number,
): string {
  const known = OUTCOME_COLOR[theme][id];
  if (known) return known;
  const ramp = Object.values(OUTCOME_COLOR[theme]);
  return kind === "success" ? ramp[Math.min(i, 2)]! : ramp[Math.min(3 + i, 5)]!;
}

/** Mix a hex colour toward another (used to step accounts within a category). */
export function mix(a: string, b: string, t: number): string {
  const pa = hex(a);
  const pb = hex(b);
  const c = pa.map((v, i) => Math.round(v + (pb[i]! - v) * t));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
function hex(h: string): number[] {
  const s = h.replace("#", "");
  return [0, 2, 4].map((i) => Number.parseInt(s.slice(i, i + 2), 16));
}

/** Steps used for the n-th account within a category (0 = the category colour itself). */
const STEPS = [0, 0.32, 0.55, -0.25, 0.7, -0.4];

export interface AccountColorInput {
  id: string;
  category: DrawdownCategory;
}

/**
 * Stable colour per account: category hue, stepped by the account's position among accounts of
 * the same category (positive steps lighten toward the surface, negative darken toward ink).
 */
export function accountColors(
  theme: ThemeName,
  accounts: AccountColorInput[],
  surface: string,
  ink: string,
): Record<string, string> {
  const seen = new Map<DrawdownCategory, number>();
  const out: Record<string, string> = {};
  for (const a of accounts) {
    const n = seen.get(a.category) ?? 0;
    seen.set(a.category, n + 1);
    const base = categoryColor(theme, a.category);
    const step = STEPS[n % STEPS.length]!;
    out[a.id] = step === 0 ? base : step > 0 ? mix(base, surface, step) : mix(base, ink, -step);
  }
  return out;
}

/** ECharts decal patterns (diagonal hatch at 45°/135°, dots) for the patterns preference. */
export function decalFor(i: number, color = "rgba(255,255,255,0.45)") {
  const kinds = [
    {
      symbol: "rect",
      rotation: Math.PI / 4,
      symbolSize: 1,
      dashArrayX: [1, 0],
      dashArrayY: [2, 4],
    },
    {
      symbol: "rect",
      rotation: -Math.PI / 4,
      symbolSize: 1,
      dashArrayX: [1, 0],
      dashArrayY: [2, 4],
    },
    { symbol: "circle", symbolSize: 0.6, dashArrayX: [[1, 5]], dashArrayY: [1, 5] },
    { symbol: "rect", rotation: 0, symbolSize: 1, dashArrayX: [1, 0], dashArrayY: [1, 5] },
    {
      symbol: "rect",
      rotation: Math.PI / 2,
      symbolSize: 1,
      dashArrayX: [1, 0],
      dashArrayY: [1, 5],
    },
  ];
  return { color, ...kinds[i % kinds.length]! };
}
