/**
 * A person's citizenships and US green card in the household sheet, saved with the person. Used
 * for items taxed in another country (some non-resident allowances depend on nationality) and for
 * US citizens abroad. Collapsed behind one line unless something is set, so a single-country
 * household is not cluttered.
 */
import type { Person } from "@glideworth/core";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Select } from "../../components/ui/select";
import { SwitchField } from "../../components/ui/switch";
import { COUNTRY_LIST, countryLabel } from "../../lib/countries";

const COUNTRIES = COUNTRY_LIST.filter((c) => c.code !== "XX").map((c) => ({
  value: c.code,
  label: c.label,
}));

type Patch = Partial<Pick<Person, "citizenships" | "usGreenCard">>;

/** Remove empty optional arrays so an untouched person stays exactly as before. */
function tidy(p: Patch): Patch {
  const out: Patch = { ...p };
  if (out.citizenships?.length === 0) out.citizenships = undefined;
  if (out.usGreenCard === false) out.usGreenCard = undefined;
  return out;
}

function summary(p: Person, home: string): string {
  const bits: string[] = [];
  const cit = p.citizenships ?? [];
  bits.push(
    cit.length
      ? `Citizen of ${cit.map(countryLabel).join(", ")}`
      : `Citizen of ${countryLabel(home)} (assumed)`,
  );
  if (p.usGreenCard) bits.push("US green card");
  return bits.join(" · ");
}

export function PersonCrossBorderFields({
  person,
  home,
  onChange,
}: {
  person: Person;
  /** The household's country (the default citizenship). */
  home: string;
  onChange: (patch: Patch, label: string, coalesce?: string) => void;
}) {
  const set = (patch: Patch, label: string, key?: string) => onChange(tidy(patch), label, key);
  const anything = !!person.citizenships?.length || !!person.usGreenCard;
  const [open, setOpen] = useState(anything);
  const cit = person.citizenships ?? [];
  const headId = `xb-${person.id}`;

  return (
    <div className="rounded-lg border border-border">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={headId}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px]"
      >
        {open ? (
          <ChevronDown className="size-3.5 text-ink-3" />
        ) : (
          <ChevronRight className="size-3.5 text-ink-3" />
        )}
        <span className="font-medium">Citizenship</span>
        <span className="ml-auto truncate text-[11.5px] text-ink-3">
          {anything ? summary(person, home) : "Optional · for tax across borders"}
        </span>
      </button>
      {open ? (
        <div id={headId} className="flex flex-col gap-4 border-t border-border px-3 py-3">
          {/* Citizenships */}
          <div className="flex flex-col gap-2">
            <div className="text-[12px] font-medium text-ink-2">Citizenships</div>
            <p className="text-[11.5px] text-ink-3">
              Used when something is taxed in another country: the US taxes its citizens wherever
              they live; a UK non-resident keeps the Personal Allowance as a British or EEA citizen;
              some treaties depend on nationality.
              {cit.length === 0 ? ` Not set: ${countryLabel(home)} is assumed.` : ""}
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              {cit.map((c) => (
                <span
                  key={c}
                  className="inline-flex items-center gap-1 rounded-full bg-surface-2 py-0.5 pr-1 pl-2 text-[12px]"
                >
                  {countryLabel(c)}
                  <button
                    type="button"
                    aria-label={`Remove ${countryLabel(c)} citizenship`}
                    className="rounded-full px-1 text-ink-3 hover:text-negative"
                    onClick={() =>
                      set({ citizenships: cit.filter((x) => x !== c) }, "Remove citizenship")
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
              <Select
                aria-label="Add a citizenship"
                className="w-[200px]"
                value=""
                placeholder="Add a citizenship…"
                onValueChange={(c) =>
                  !cit.includes(c) &&
                  set(
                    { citizenships: [...(cit.length ? cit : []), c].slice(0, 5) },
                    "Add citizenship",
                  )
                }
                options={COUNTRIES.filter((c) => !cit.includes(c.value))}
              />
            </div>
            <SwitchField
              label="Holds a US green card"
              hint="Green-card holders are taxed by the US like citizens while they keep it, wherever they live."
              checked={!!person.usGreenCard}
              onCheckedChange={(v) => set({ usGreenCard: v }, "Edit US green card")}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
