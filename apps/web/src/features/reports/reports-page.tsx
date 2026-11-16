/** Route entry for /reports (lazy). */
import { lazyPage } from "../../components/charts/lazy-page";

export const ReportsPage = lazyPage(() => import("./report-view"), "ReportView", "Report");
