/**
 * The shape of `catalog.generated.ts`: what the server knows about each free calculator on the marketing site.
 * Generated from the site's calculator specs and engine (apps/site/src/tools/email-catalog.test.ts), never edited
 * by hand.
 */
interface FieldBase {
  key: string;
  label: string;
  default: number | string;
  showWhen?: { key: string; values: string[] };
}
export interface NumberCatalogField extends FieldBase {
  kind: "number";
  unit: "money" | "percent" | "years" | "age" | "count" | "seed";
  min: number;
  max: number;
  step: number;
  default: number;
}
export interface SelectCatalogField extends FieldBase {
  kind: "select";
  options: { value: string; label: string }[];
  default: string;
}
export type CatalogField = NumberCatalogField | SelectCatalogField;

export interface CalculatorEntry {
  /** "Coast FIRE calculator". */
  name: string;
  /** Site path of the page, "/tools/coast-fire-calculator/". */
  path: string;
  /** Display currency when the calculator has no `cur` field. */
  currency?: string;
  fields: CatalogField[];
  /** `shapeOf` every result-figure label this calculator was seen to produce, sorted. */
  labelShapes: string[];
}

export interface Catalog {
  calculators: Record<string, CalculatorEntry>;
  /** `shapeOf` every result-figure value any calculator was seen to produce, sorted. */
  valueShapes: string[];
  /** Locale used to format each display currency. */
  currencyLocales: Record<string, string>;
}
