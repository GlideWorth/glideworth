/**
 * The "partial year" controls shared by every single-year view: a toggle between the actual months
 * and an annualised view of a short first/last plan year, and a note that says which one is shown.
 */
import { CalendarRange } from "lucide-react";
import { cn } from "../../lib/cn";
import { hasPartialPeriods, partialNote } from "../../lib/period";
import { useUi } from "../../stores/ui";
import { Segmented } from "./segmented";

/** The user's choice (one setting for the whole app). */
export function useAnnualise(): boolean {
  return useUi((s) => s.annualisePartial);
}

/** Offered only when the projection has a partial year. */
export function PartialYearToggle({ periods }: { periods: readonly { months: number }[] }) {
  const on = useUi((s) => s.annualisePartial);
  const set = useUi((s) => s.setAnnualisePartial);
  if (!hasPartialPeriods(periods)) return null;
  return (
    <Segmented
      aria-label="Partial years"
      size="sm"
      value={on ? "annualised" : "actual"}
      onChange={(v) => set(v === "annualised")}
      options={[
        {
          value: "actual",
          label: "Actual months",
          title: "Show a partial first or last year as the months it covers",
        },
        {
          value: "annualised",
          label: "Annualised",
          title: "Scale a partial first or last year to a full year so it compares with the others",
        },
      ]}
    />
  );
}

/** A one-line note under a single year's figures when that year is partial. */
export function PartialYearNote({
  period,
  className,
}: {
  period: { year: number; startMonth: string; months: number };
  className?: string;
}) {
  const annualise = useAnnualise();
  const note = partialNote(period, { annualise });
  if (!note) return null;
  return (
    <p
      className={cn(
        "flex gap-2 rounded-md bg-ochre-soft/40 px-2.5 py-1.5 text-[12px] text-ink-2",
        className,
      )}
    >
      <CalendarRange className="mt-0.5 size-3.5 shrink-0 text-ochre" aria-hidden /> {note}
    </p>
  );
}
