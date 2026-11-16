/** Route entry for /insights (lazy). */
import { lazyPage } from "../../components/charts/lazy-page";

export const InsightsPage = lazyPage(() => import("./insights-view"), "InsightsView", "Insights");
