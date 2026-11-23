/**
 * Mounted once for the whole demo, so the automatic chance-of-success run keeps going when the
 * visitor leaves the dashboard for /demo/chance.
 */
import { useAnalysis } from "../results/use-analysis";
import { useDemoChanceOfSuccess } from "./demo-chance";

export function DemoChanceHost() {
  const { input, plan } = useAnalysis();
  useDemoChanceOfSuccess(input, plan);
  return null;
}
