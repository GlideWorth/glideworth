/**
 * The DATASET_REPLACED notice: a plan that named a removed historical dataset (`uk-1871`, `us-1871`) is read
 * as its replacement and the engine says so on every run until the person has seen it. Dismissing it calls
 * core's `acknowledgeReplacedDataset` and saves the plan (through the API, with If-Match, or in this session's
 * copy of the sample).
 */
import { acknowledgeReplacedDataset, type Plan } from "@glideworth/core";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { toast } from "../../components/ui/toaster";
import { useAccess } from "../../lib/access";
import { useWorkspace } from "../../lib/workspace";
import { applyToPlan } from "../insights/save-plan";

export const isDatasetReplaced = (w: { code: string }): boolean => w.code === "DATASET_REPLACED";

/** The plan without its replaced-dataset marker (other settings untouched). */
export const withoutDatasetNotice = (plan: Plan): Plan => ({
  ...plan,
  monteCarlo: acknowledgeReplacedDataset(plan.monteCarlo) as Plan["monteCarlo"],
});

/**
 * "Dismiss" for the notice. By default it saves the plan; the plan editor passes `save` to edit its draft
 * instead (the draft is saved by the editor's own save).
 */
export function DismissDatasetNotice({
  plan,
  save,
  className,
}: {
  plan: Plan;
  save?: (next: Plan) => void | Promise<void>;
  className?: string;
}) {
  const qc = useQueryClient();
  const { data: ws } = useWorkspace();
  const { canWrite } = useAccess();
  const [busy, setBusy] = useState(false);
  if (!canWrite || !plan.monteCarlo.replacedDataset) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      className={className}
      disabled={busy}
      aria-label="Dismiss the notice about the replaced dataset"
      onClick={async () => {
        setBusy(true);
        try {
          const next = withoutDatasetNotice(plan);
          if (save) await save(next);
          else if (ws) await applyToPlan(qc, ws, plan, next);
        } catch (e) {
          toast({
            title: "Could not dismiss the notice",
            description: e instanceof Error ? e.message : "Try again.",
            tone: "negative",
          });
        }
        setBusy(false);
      }}
    >
      Dismiss
    </Button>
  );
}
