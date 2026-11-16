/** Route entry for /results: lazy so ECharts and the analysis code split out of the main bundle. */
import { lazyPage } from "../../components/charts/lazy-page";

export const ResultsPage = lazyPage(() => import("./results-view"), "ResultsView");
