/**
 * Route entries for the workstream (h) analysis pages. Each is lazy-loaded so the page code and
 * ECharts split out of the initial bundle. (Historically this file held "planned" placeholders;
 * the router imports these names, so they stay here.)
 */
import { lazyPage } from "../components/charts/lazy-page";

export const ChancePage = lazyPage(
  () => import("./chance/chance-page"),
  "ChanceView",
  "Chance of success",
);
export const CashFlowPage = lazyPage(
  () => import("./cashflow/cashflow-page"),
  "CashFlowView",
  "Cash flow",
);
export const TaxesPage = lazyPage(() => import("./taxes/taxes-page"), "TaxesView", "Taxes");
export const ComparePage = lazyPage(() => import("./compare/compare-page"), "CompareView");
export const ProgressPage = lazyPage(() => import("./progress/progress-page"), "ProgressView");
export const EstatePage = lazyPage(
  () => import("./estate/estate-page"),
  "EstateView",
  "Estate and legacy",
);
export const BuilderPage = lazyPage(
  () => import("./builder/builder-page"),
  "BuilderView",
  "Custom charts",
);
