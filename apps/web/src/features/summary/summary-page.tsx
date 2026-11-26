/** Route entry for /summary (lazy). */
import { lazyPage } from "../../components/charts/lazy-page";

export const SummaryPage = lazyPage(
  () => import("./partner-summary-view"),
  "PartnerSummaryView",
  "Summary",
);
