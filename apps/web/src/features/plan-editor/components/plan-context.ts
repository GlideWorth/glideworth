import type { Plan } from "@glideworth/core";
import { createContext, useContext } from "react";
import { editPlan, useEditorStore } from "../state/doc-store";

export const PlanIdContext = createContext<string>("");

export function usePlanId() {
  return useContext(PlanIdContext);
}

/** The plan being edited (draft). */
export function usePlan(): Plan | undefined {
  const id = usePlanId();
  return useEditorStore((s) => s.draft?.plans.find((p) => p.id === id));
}

export function useUpdatePlan() {
  const id = usePlanId();
  return (fn: (p: Plan) => Plan, label: string, coalesce?: string) =>
    editPlan(id, fn, label, coalesce);
}

/** Replace one item (by id) in an array-valued plan field. */
export function replaceById<T extends { id: string }>(xs: T[], id: string, fn: (x: T) => T): T[] {
  return xs.map((x) => (x.id === id ? fn(x) : x));
}
