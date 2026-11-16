/** Route entry for / (lazy, so ECharts and analysis code are split out of the main bundle). */
import { lazyPage } from "../../components/charts/lazy-page";

export const DashboardPage = lazyPage(() => import("./dashboard-view"), "DashboardView");
