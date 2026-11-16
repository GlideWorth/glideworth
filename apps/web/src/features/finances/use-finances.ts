import type { CurrentFinances, Household, Plan } from "@glideworth/core";
import { useMemo } from "react";
import { useFormat } from "../../lib/workspace";
import { useUi } from "../../stores/ui";
import type { EditorScope } from "../plan-editor/components/form";
import { editHousehold, useEditorStore } from "../plan-editor/state/doc-store";
import { timeContext } from "../plan-editor/state/resolve";

export function useDraftDoc() {
  return useEditorStore((s) => s.draft);
}

/** The plan whose milestones date pickers on this page refer to (active, else main, else first). */
export function useReferencePlan(): Plan | undefined {
  const plans = useEditorStore((s) => s.draft?.plans);
  const active = useUi((s) => s.activePlanId);
  return plans?.find((p) => p.id === active) ?? plans?.find((p) => p.isMain) ?? plans?.[0];
}

export function useFinanceScope(): EditorScope {
  const doc = useDraftDoc();
  const plan = useReferencePlan();
  return useMemo(
    () => ({
      people: doc?.household.people ?? [],
      milestones: plan?.milestones ?? [],
      accounts: (doc?.finances.accounts ?? [])
        .filter((a) => !a.archived)
        .map((a) => ({ id: a.id, name: a.name, type: a.type })),
      tctx: doc && plan ? timeContext(doc, plan) : null,
    }),
    [doc, plan],
  );
}

export function updateFinances(
  fn: (f: CurrentFinances) => CurrentFinances,
  label: string,
  coalesce?: string,
) {
  editHousehold((h) => ({ ...h, finances: fn(h.finances) }), label, coalesce);
}

export function updateHouseholdOnly(
  fn: (h: Household) => Household,
  label: string,
  coalesce?: string,
) {
  editHousehold((h) => ({ ...h, household: fn(h.household) }), label, coalesce);
}

/** "stocks 7.0% · bonds 2.0%" for "Plan default" growth labels. */
export function useInheritLabels(assetClass: "cash" | "portfolio" | "crypto") {
  const plan = useReferencePlan();
  const f = useFormat();
  const a = plan?.assumptions;
  const rate = (s: Plan["assumptions"]["stockReturn"] | undefined) =>
    !s
      ? "—"
      : s.kind === "fixed"
        ? f.percent(s.rate, 1)
        : s.kind === "none"
          ? "0%"
          : s.kind === "historical"
            ? `historical ${s.startYear}`
            : "scheduled";
  const growth =
    assetClass === "cash"
      ? `cash ${rate(a?.cashReturn)}`
      : assetClass === "crypto"
        ? `crypto ${rate(a?.cryptoReturn)}`
        : `stocks ${rate(a?.stockReturn)} · bonds ${rate(a?.bondReturn)}`;
  return {
    growth: plan ? `${growth} (${plan.name})` : growth,
    dividend: `${rate(a?.dividendYield)} yield`,
  };
}
