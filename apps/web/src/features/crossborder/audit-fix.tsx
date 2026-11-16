/**
 * Cross-border audit findings (codes XB_*) link to the place they concern: the exchange-rate table,
 * the person's state-pension record, the plan's flows or residency, or the tax explanation.
 */
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { Button } from "../../components/ui/button";
import { type Intent, setIntent } from "../plan-editor/state/intent";

const FIX: Record<string, { label: string; to: "finances" | "plan" | "taxes"; intent?: Intent }> = {
  XB_FOREIGN_ASSET_BASE_CURRENCY: { label: "Open Finances: currency", to: "finances" },
  XB_MISSING_FX: { label: "Open the exchange rates in Finances", to: "finances" },
  XB_TAX_FX_MISSING: { label: "Open the exchange rates in Finances", to: "finances" },
  XB_STATE_PENSION_GAP: {
    label: "Open the pension record",
    to: "finances",
    intent: { kind: "edit-household" },
  },
  XB_WRAPPER_NON_RESIDENT_CONTRIBUTIONS: {
    label: "Open flows",
    to: "plan",
    intent: { kind: "section", section: "flows" },
  },
  XB_UK_TEMPORARY_NON_RESIDENCE: {
    label: "Open where you live",
    to: "plan",
    intent: { kind: "section", section: "residency" },
  },
  XB_UNKNOWN_TREATY: { label: "How it is taxed", to: "taxes" },
};

export function CrossBorderFix({ code, planId }: { code: string; planId: string }) {
  const nav = useNavigate();
  const fix = FIX[code];
  if (!fix) return null;
  const go = () => {
    if (fix.intent) setIntent(fix.intent);
    if (fix.to === "finances") void nav({ to: "/finances" });
    else if (fix.to === "taxes") void nav({ to: "/taxes" });
    else void nav({ to: "/plans/$planId", params: { planId } });
  };
  return (
    <Button size="sm" variant="ghost" onClick={go}>
      {fix.label} <ArrowRight />
    </Button>
  );
}
