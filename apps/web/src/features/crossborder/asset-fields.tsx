/**
 * Property details that only matter across borders: when it was bought and its value at past
 * dates. A country's non-resident rules may tax only the gain since a rebasing date (the UK: April
 * 2015 for homes, April 2019 for commercial property), so the editor offers that date.
 */
import { NON_RESIDENT_RULES, type RealAsset } from "@glideworth/core";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { CurrencyInput } from "../../components/ui/number-input";
import { countryLabel } from "../../lib/countries";
import { FormField } from "../plan-editor/components/form";

type Patch = Partial<Pick<RealAsset, "acquiredOn" | "valuations">>;

export function AcquisitionFields({
  acquiredOn,
  valuations,
  currency,
  country,
  onChange,
}: {
  acquiredOn: string | undefined;
  valuations: NonNullable<RealAsset["valuations"]>;
  currency: string | undefined;
  country: string;
  onChange: (patch: Patch, label: string, coalesce?: string) => void;
}) {
  const rules = NON_RESIDENT_RULES[country]?.propertyGains;
  const rebase = rules?.rebasing.residential.slice(0, 7) ?? null;
  const setVals = (v: Patch["valuations"], label: string, key?: string) =>
    onChange({ valuations: v?.length ? v : undefined }, label, key);
  return (
    <div className="mt-1 flex flex-col gap-3 rounded-lg border border-border p-3">
      <div>
        <div className="text-[12.5px] font-semibold">Bought, and past values</div>
        <p className="mt-0.5 text-[11.5px] text-ink-3">
          Used when a country taxes non-residents on the gain: {countryLabel(country)}
          {rules
            ? ` taxes only the gain since ${rules.rebasing.residential.slice(0, 7)} (homes) or ${rules.rebasing.commercial.slice(0, 7)} (commercial) when you give the value then; otherwise the gain is split by time owned.`
            : " has no rebasing rule in Glideworth: the whole gain counts."}
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Bought in" hint="Month of purchase.">
          {(id) => (
            <Input
              id={id}
              type="month"
              value={acquiredOn ?? ""}
              onChange={(e) =>
                onChange({ acquiredOn: e.target.value || undefined }, "Edit purchase month", "acq")
              }
            />
          )}
        </FormField>
      </div>
      {valuations.map((v, i) => (
        <div
          // oxlint-disable-next-line react/no-array-index-key -- positional rows
          key={i}
          className="grid items-end gap-2 sm:grid-cols-[140px_1fr_auto]"
        >
          <FormField label="Valued in">
            {(id) => (
              <Input
                id={id}
                type="month"
                value={v.month}
                onChange={(e) =>
                  e.target.value &&
                  setVals(
                    valuations.map((x, j) => (j === i ? { ...x, month: e.target.value } : x)),
                    "Edit valuation",
                    `val${i}m`,
                  )
                }
              />
            )}
          </FormField>
          <FormField label="Value then">
            {(id) => (
              <CurrencyInput
                id={id}
                currency={currency}
                value={v.value}
                onValueChange={(n) =>
                  setVals(
                    valuations.map((x, j) => (j === i ? { ...x, value: Math.max(0, n ?? 0) } : x)),
                    "Edit valuation",
                    `val${i}v`,
                  )
                }
              />
            )}
          </FormField>
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Remove the ${v.month} valuation`}
            onClick={() =>
              setVals(
                valuations.filter((_, j) => j !== i),
                "Remove valuation",
              )
            }
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        {rebase && !valuations.some((v) => v.month === rebase) ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setVals([...valuations, { month: rebase, value: 0 }], "Add valuation")}
          >
            <Plus /> Value in {rebase}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            setVals(
              [
                ...valuations,
                { month: acquiredOn ?? new Date().toISOString().slice(0, 7), value: 0 },
              ],
              "Add valuation",
            )
          }
        >
          <Plus /> Another valuation
        </Button>
      </div>
    </div>
  );
}
