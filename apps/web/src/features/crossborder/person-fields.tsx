/**
 * A person's cross-border details in the household sheet: citizenships, US green card, where they
 * lived before the plan, and state-pension records (qualifying years and planned voluntary years).
 * Collapsed behind one line unless something is set, so a single-country household is not
 * cluttered.
 */
import type { Person, StatePensionRecord } from "@glideworth/core";
import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { NumberInput } from "../../components/ui/number-input";
import { Select } from "../../components/ui/select";
import { SwitchField } from "../../components/ui/switch";
import { COUNTRY_LIST, countryLabel } from "../../lib/countries";
import { formatMonth } from "../../lib/format";
import { useFormat } from "../../lib/workspace";
import { FormField } from "../plan-editor/components/form";

const COUNTRIES = COUNTRY_LIST.filter((c) => c.code !== "XX").map((c) => ({
  value: c.code,
  label: c.label,
}));

type Patch = Partial<
  Pick<Person, "citizenships" | "usGreenCard" | "residenceHistory" | "statePensionRecords">
>;

/** Remove empty optional arrays so an untouched person stays exactly as before. */
function tidy(p: Patch): Patch {
  const out: Patch = { ...p };
  for (const k of ["citizenships", "residenceHistory", "statePensionRecords"] as const)
    if (k in out && (out[k] as unknown[] | undefined)?.length === 0) out[k] = undefined;
  if (out.usGreenCard === false) out.usGreenCard = undefined;
  return out;
}

export function summary(p: Person, home: string): string {
  const bits: string[] = [];
  const cit = p.citizenships ?? [];
  bits.push(
    cit.length
      ? `Citizen of ${cit.map(countryLabel).join(", ")}`
      : `Citizen of ${countryLabel(home)} (assumed)`,
  );
  if (p.usGreenCard) bits.push("US green card");
  if (p.residenceHistory?.length)
    bits.push(
      `${p.residenceHistory.length} past residence${p.residenceHistory.length === 1 ? "" : "s"}`,
    );
  for (const r of p.statePensionRecords ?? [])
    bits.push(`${countryLabel(r.country)}: ${r.qualifyingYears} qualifying years`);
  return bits.join(" · ");
}

export function PersonCrossBorderFields({
  person,
  home,
  asOf,
  onChange,
}: {
  person: Person;
  /** The household's country (the default citizenship and past residence). */
  home: string;
  asOf: string;
  onChange: (patch: Patch, label: string, coalesce?: string) => void;
}) {
  const f = useFormat();
  const set = (patch: Patch, label: string, key?: string) => onChange(tidy(patch), label, key);
  const anything =
    !!person.citizenships?.length ||
    !!person.usGreenCard ||
    !!person.residenceHistory?.length ||
    !!person.statePensionRecords?.length;
  const [open, setOpen] = useState(anything);
  const cit = person.citizenships ?? [];
  const history = person.residenceHistory ?? [];
  const records = person.statePensionRecords ?? [];
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
        <span className="font-medium">Citizenship, past residence and state pension</span>
        <span className="ml-auto truncate text-[11.5px] text-ink-3">
          {anything ? summary(person, home) : "Optional · for moves abroad"}
        </span>
      </button>
      {open ? (
        <div id={headId} className="flex flex-col gap-4 border-t border-border px-3 py-3">
          {/* Citizenships */}
          <div className="flex flex-col gap-2">
            <div className="text-[12px] font-medium text-ink-2">Citizenships</div>
            <p className="text-[11.5px] text-ink-3">
              Used for cross-border rules: the US taxes its citizens wherever they live; a UK
              non-resident keeps the Personal Allowance as a British or EEA citizen; some treaties
              depend on nationality.
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

          {/* Residence history */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[12px] font-medium text-ink-2">
                Where {person.name} lived before {formatMonth(asOf, f.locale)}
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  set(
                    {
                      residenceHistory: [
                        ...history,
                        { country: home, from: history.length ? asOf : person.birthMonth },
                      ],
                    },
                    "Add past residence",
                  )
                }
              >
                <Plus /> Add
              </Button>
            </div>
            <p className="text-[11.5px] text-ink-3">
              Oldest first. Used for look-back rules (UK temporary non-residence, UK inheritance tax
              long-term residence). Leave empty if {person.name} has always lived in{" "}
              {countryLabel(home)}. Moves after {formatMonth(asOf, f.locale)} belong in each plan's
              “Where you live”.
            </p>
            {history.map((r, i) => (
              <div
                // oxlint-disable-next-line react/no-array-index-key -- rows are positional (oldest first)
                key={i}
                className="grid items-end gap-2 sm:grid-cols-[1fr_130px_130px_auto]"
              >
                <FormField label="Country">
                  {(id) => (
                    <Select
                      id={id}
                      value={r.country}
                      onValueChange={(country) =>
                        set(
                          {
                            residenceHistory: history.map((x, j) =>
                              j === i ? { ...x, country } : x,
                            ),
                          },
                          "Edit past residence",
                        )
                      }
                      options={COUNTRIES}
                    />
                  )}
                </FormField>
                <FormField label="From">
                  {(id) => (
                    <Input
                      id={id}
                      type="month"
                      value={r.from}
                      max={asOf}
                      onChange={(e) =>
                        e.target.value &&
                        set(
                          {
                            residenceHistory: history.map((x, j) =>
                              j === i ? { ...x, from: e.target.value } : x,
                            ),
                          },
                          "Edit past residence",
                          `rh${i}from`,
                        )
                      }
                    />
                  )}
                </FormField>
                <FormField
                  label="To"
                  hint={i === history.length - 1 ? "Empty: still there" : undefined}
                >
                  {(id) => (
                    <Input
                      id={id}
                      type="month"
                      value={r.to ?? ""}
                      max={asOf}
                      onChange={(e) =>
                        set(
                          {
                            residenceHistory: history.map((x, j) =>
                              j === i ? { ...x, to: e.target.value || undefined } : x,
                            ),
                          },
                          "Edit past residence",
                          `rh${i}to`,
                        )
                      }
                    />
                  )}
                </FormField>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Remove past residence in ${countryLabel(r.country)}`}
                  onClick={() =>
                    set(
                      { residenceHistory: history.filter((_, j) => j !== i) },
                      "Remove past residence",
                    )
                  }
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>

          {/* State pension records */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[12px] font-medium text-ink-2">State pension records</div>
              <Button
                size="sm"
                variant="ghost"
                disabled={records.some((r) => r.country === home)}
                onClick={() =>
                  set(
                    {
                      statePensionRecords: [
                        ...records,
                        { country: home, qualifyingYears: 0 } as StatePensionRecord,
                      ],
                    },
                    "Add state pension record",
                  )
                }
              >
                <Plus /> Add
              </Button>
            </div>
            <p className="text-[11.5px] text-ink-3">
              Qualifying years already on the record (UK: check your forecast on gov.uk; 35 give the
              full new State Pension). Voluntary years are ones you plan to buy, for example UK
              Class 3 contributions while abroad; add their cost as an expense. Glideworth flags a
              shortfall in Insights.
            </p>
            {records.map((r, i) => (
              <div
                key={r.country}
                className="grid items-end gap-2 sm:grid-cols-[1fr_110px_110px_130px_auto]"
              >
                <FormField label="Scheme country">
                  {(id) => (
                    <Select
                      id={id}
                      value={r.country}
                      onValueChange={(country) =>
                        !records.some((x, j) => j !== i && x.country === country) &&
                        set(
                          {
                            statePensionRecords: records.map((x, j) =>
                              j === i ? { ...x, country } : x,
                            ),
                          },
                          "Edit state pension record",
                        )
                      }
                      options={COUNTRIES}
                    />
                  )}
                </FormField>
                <FormField label="Qualifying years">
                  {(id) => (
                    <NumberInput
                      id={id}
                      decimals={0}
                      value={r.qualifyingYears}
                      onValueChange={(v) =>
                        set(
                          {
                            statePensionRecords: records.map((x, j) =>
                              j === i
                                ? {
                                    ...x,
                                    qualifyingYears: Math.max(0, Math.min(60, Math.round(v ?? 0))),
                                  }
                                : x,
                            ),
                          },
                          "Edit qualifying years",
                          `sp${i}q`,
                        )
                      }
                    />
                  )}
                </FormField>
                <FormField label="Voluntary years">
                  {(id) => (
                    <NumberInput
                      id={id}
                      decimals={0}
                      value={r.voluntaryYears ?? null}
                      onValueChange={(v) =>
                        set(
                          {
                            statePensionRecords: records.map((x, j) =>
                              j === i
                                ? {
                                    ...x,
                                    voluntaryYears: v
                                      ? Math.max(0, Math.min(35, Math.round(v)))
                                      : undefined,
                                  }
                                : x,
                            ),
                          },
                          "Edit voluntary years",
                          `sp${i}v`,
                        )
                      }
                    />
                  )}
                </FormField>
                <FormField label="Checked in">
                  {(id) => (
                    <Input
                      id={id}
                      type="month"
                      value={r.asOf ?? ""}
                      onChange={(e) =>
                        set(
                          {
                            statePensionRecords: records.map((x, j) =>
                              j === i ? { ...x, asOf: e.target.value || undefined } : x,
                            ),
                          },
                          "Edit record date",
                          `sp${i}d`,
                        )
                      }
                    />
                  )}
                </FormField>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Remove ${countryLabel(r.country)} state pension record`}
                  onClick={() =>
                    set(
                      { statePensionRecords: records.filter((_, j) => j !== i) },
                      "Remove state pension record",
                    )
                  }
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
