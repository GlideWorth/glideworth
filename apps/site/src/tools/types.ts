/**
 * Shared types of the free calculators. Nothing here imports the engine, so the page scripts that use
 * these types stay small; the engine is only loaded by the worker (src/tools/worker) and at build time.
 */

/** Every calculator has an id; it appears in the planner hand-off link (`tool=<id>`). */
export type ToolId =
  | "coast-fire"
  | "fire"
  | "barista-fire"
  | "withdrawal"
  | "how-long"
  | "monte-carlo";

/** Input values by field key. Numbers are in the field's display unit (percent fields hold 5 for 5%). */
export type Values = Record<string, number | string>;

/** A condition under which a field is shown (other fields are hidden and ignored). */
export interface ShowWhen {
  key: string;
  values: string[];
}

interface FieldBase {
  /** Key in the URL query string and in the planner hand-off link. Short, stable, documented. */
  key: string;
  label: string;
  /** One-line helper text under the input. */
  help: string;
  /** Shown under "More options" instead of with the main inputs. */
  advanced?: boolean;
  showWhen?: ShowWhen;
}

export interface NumberField extends FieldBase {
  kind: "number";
  unit: "money" | "percent" | "years" | "age" | "count" | "seed";
  min: number;
  max: number;
  /** Smallest meaningful change; whole numbers when 1. */
  step: number;
  default: number;
}

export interface SelectField extends FieldBase {
  kind: "select";
  options: { value: string; label: string }[];
  default: string;
}

export type Field = NumberField | SelectField;

export interface ToolSpec {
  id: ToolId;
  /** Site path of the calculator page. */
  path: string;
  fields: Field[];
  /** 'instant': recalculates as you type. 'simulation': Monte Carlo with progress and a cancel button. */
  mode: "instant" | "simulation";
  /** Checks between fields (retirement age after current age...). Keyed by the field to flag. */
  validate?: (values: Values) => Record<string, string>;
}

// ------------------------------------------------------------------------------- results (view model)

export interface Figure {
  label: string;
  value: string;
  detail?: string;
}

/** Tone picks one of the site's chart colours; style keeps series apart without relying on colour. */
export interface Series {
  label: string;
  values: (number | null)[];
  tone: 1 | 2 | 3 | 4;
  style: "solid" | "dashed" | "dotted";
}

export interface Band {
  label: string;
  lower: number[];
  upper: number[];
  tone: 1 | 2 | 3 | 4;
  level: "outer" | "inner";
}

export interface Table {
  caption: string;
  columns: string[];
  rows: string[][];
}

export interface ChartSpec {
  id: string;
  kind: "line" | "bar";
  title: string;
  /** Plain-language summary of what the chart shows (the text alternative). */
  summary: string;
  xLabel: string;
  yLabel: string;
  x: number[];
  series: Series[];
  bands?: Band[];
  /** Vertical marker lines (retirement age, the year the money runs out). */
  markers?: { x: number; label: string }[];
  /** Horizontal reference lines (the target). */
  hLines?: { y: number; label: string }[];
  /** Force a shared y-axis maximum (small multiples). */
  yMax?: number;
  /** ISO currency code used for axis labels. */
  currency: string;
  /** Unit of the y axis (default money). */
  yUnit?: "money" | "years" | "percent";
  table: Table;
}

export interface ComparisonRow {
  label: string;
  formula: string;
  engine: string;
  note?: string;
}

export interface Comparison {
  title: string;
  rows: ComparisonRow[];
  note: string;
}

export interface ViewModel {
  tool: ToolId;
  /** The answer in one or two plain sentences. */
  headline: string;
  /** Short text for the polite live region. */
  announce: string;
  figures: Figure[];
  charts: ChartSpec[];
  /** Grid of small charts that share a scale (withdrawal rules). */
  smallMultiples?: boolean;
  table?: Table;
  comparison?: Comparison;
  /** What this run used: method, dataset, seed, timing, tax. */
  method: string[];
  warnings: string[];
}

export type Timing = "start" | "mid" | "end";
