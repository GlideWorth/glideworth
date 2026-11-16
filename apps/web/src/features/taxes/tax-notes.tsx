/**
 * What a plan's tax estimate is made of, and what it leaves out: the resolved jurisdiction stack and
 * each jurisdiction's known simplifications (core `TaxJurisdiction.simplifications` /
 * `TAX_SIMPLIFICATIONS`). Shown on the Taxes page and in the plan's tax settings.
 */
import {
  createDefaultTaxRegistry,
  defaultStackIds,
  type Location,
  type TaxConfig,
  type TaxJurisdiction,
} from "@glideworth/core";
import { Info } from "lucide-react";
import { cn } from "../../lib/cn";
import { countryLabel, simplificationsFor } from "../../lib/countries";

const registry = createDefaultTaxRegistry();

/** A jurisdiction's display label ('es:MD' → its label), or undefined when unknown. */
export function jurisdictionLabel(id: string): string | undefined {
  if (id === "engine") return undefined;
  try {
    return registry.get(id).label;
  } catch {
    return undefined;
  }
}

/** The jurisdictions a plan's tax config resolves to, or why it cannot. */
export function resolveStack(
  tax: Pick<TaxConfig, "mode" | "jurisdictions">,
  location: Location,
): { ok: true; stack: TaxJurisdiction[]; ids: string[] } | { ok: false; reason: string } {
  try {
    const ids =
      tax.mode === "flat"
        ? ["flat"]
        : tax.mode === "custom"
          ? ["custom"]
          : tax.jurisdictions.length
            ? tax.jurisdictions
            : defaultStackIds(location);
    return { ok: true, ids, stack: ids.map((id) => registry.get(id)) };
  } catch {
    return {
      ok: false,
      reason:
        location.country === "XX"
          ? "No tax preset for “somewhere else”: use flat rates or your own brackets."
          : `Glideworth has no tax estimate for ${countryLabel(location.country)} yet: use flat rates or your own brackets.`,
    };
  }
}

export function TaxSimplifications({
  tax,
  location,
  className,
  compact = false,
}: {
  tax: Pick<TaxConfig, "mode" | "jurisdictions">;
  location: Location;
  className?: string;
  compact?: boolean;
}) {
  const r = resolveStack(tax, location);
  if (!r.ok)
    return (
      <p className={cn("flex gap-2 text-[12px] text-ink-2", className)}>
        <Info className="mt-0.5 size-3.5 shrink-0 text-ink-3" /> {r.reason}
      </p>
    );
  const rows = r.stack.map((j, i) => ({
    id: r.ids[i]!,
    label: j.label,
    notes: j.simplifications?.length ? j.simplifications : simplificationsFor(r.ids[i]!),
  }));
  const withNotes = rows.filter((x) => x.notes.length);
  return (
    <div className={cn("flex flex-col gap-2 text-[12.5px]", className)}>
      <div className="flex flex-wrap items-center gap-1.5 text-ink-2">
        <span>{tax.mode === "estimate" ? "Estimated with:" : "Tax rules:"}</span>
        {rows.map((x) => (
          <span
            key={x.id}
            className="rounded-full bg-surface-2 px-2 py-0.5 text-[11.5px] font-medium text-ink"
          >
            {x.label}
          </span>
        ))}
      </div>
      {withNotes.length ? (
        <details
          className="rounded-md border border-border bg-surface-2/50 px-3 py-2"
          open={!compact}
        >
          <summary className="cursor-pointer font-medium text-ink">
            Known simplifications ({withNotes.reduce((s, x) => s + x.notes.length, 0)})
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            {withNotes.map((x) => (
              <div key={x.id}>
                {withNotes.length > 1 ? <div className="eyebrow mb-0.5">{x.label}</div> : null}
                <ul className="list-disc pl-4 text-ink-2 marker:text-ink-3">
                  {x.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </details>
      ) : tax.mode === "estimate" ? (
        <p className="text-[11.5px] text-ink-3">
          This estimate models the main income taxes, social contributions and allowances; it is not
          tax advice.
        </p>
      ) : null}
    </div>
  );
}
