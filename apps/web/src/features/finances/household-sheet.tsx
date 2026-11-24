import {
  CurrentFinances,
  type Dependent,
  type Household,
  Household as HouseholdSchema,
  Milestone,
  type Person,
  type Plan,
} from "@glideworth/core";
import { Plus, Trash2, UserRound, Users } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { AppearanceDot, AppearancePicker } from "../../components/ui/appearance-picker";
import { Button } from "../../components/ui/button";
import { confirmAction } from "../../components/ui/confirm-dialog";
import { Dialog, DialogContent } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { NumberInput } from "../../components/ui/number-input";
import { Segmented } from "../../components/ui/segmented";
import { Select } from "../../components/ui/select";
import { FieldGrid, FormSection, Sheet, SheetClose, SheetContent } from "../../components/ui/sheet";
import { SwitchField } from "../../components/ui/switch";
import { toast } from "../../components/ui/toaster";
import { COUNTRY_LIST, COUNTRY_OPTIONS, CURRENCY_CODES, countryInfo } from "../../lib/countries";
import { PersonCrossBorderFields } from "../crossborder/person-fields";
import { EnumField, FormField } from "../plan-editor/components/form";
import { countryDefaults, newId } from "../plan-editor/state/defaults";
import {
  type EntityKey,
  editMany,
  type HouseholdEntity,
  planKey,
} from "../plan-editor/state/doc-store";
import { useIssues } from "../plan-editor/state/validation";
import { type CountryChange, describeCountryChange } from "./country-change";
import { linkedCosts, planMentions, planWithoutDependent } from "./dependent-costs";
import { DependentCosts } from "./dependent-costs-panel";
import { updateHouseholdOnly, useDraftDoc } from "./use-finances";

const Bundle = z.object({ household: HouseholdSchema, finances: CurrentFinances });

/** Every supported country (lib/countries). Kept as an export for older importers of this module. */
export const COUNTRIES = COUNTRY_LIST.map((c) => ({ value: c.code, label: c.label }));
const CURRENCIES = CURRENCY_CODES;
const LOCALES = [
  "en-GB",
  "en-US",
  "en-CA",
  "fr-CA",
  "en-AU",
  "en-NZ",
  "en-IE",
  "de-DE",
  "nl-NL",
  "es-ES",
  "fr-FR",
  "it-IT",
  "sv-SE",
  "ja-JP",
];

function lifeExpectancy(plan: Plan | undefined, personId: string): number | null {
  const m = plan?.milestones.find((x) => x.kind === "life-expectancy" && x.personId === personId);
  const c = m?.criteria.find((x) => x.kind === "age");
  return c && c.kind === "age" ? c.age : null;
}

function withLifeExpectancy(plan: Plan, person: Person, age: number): Plan {
  const idx = plan.milestones.findIndex(
    (x) => x.kind === "life-expectancy" && x.personId === person.id,
  );
  if (idx < 0)
    return {
      ...plan,
      milestones: [
        ...plan.milestones,
        Milestone.parse({
          id: newId("ms-le"),
          name: `${person.name} life expectancy`,
          kind: "life-expectancy",
          personId: person.id,
          builtIn: true,
          criteria: [{ kind: "age", personId: person.id, age }],
        }),
      ],
    };
  return {
    ...plan,
    milestones: plan.milestones.map((m, i) =>
      i === idx
        ? {
            ...m,
            criteria: m.criteria.map((c) =>
              c.kind === "age" && c.personId === person.id ? { ...c, age } : c,
            ),
          }
        : m,
    ),
  };
}

/** Replace every string equal to `from` with `to`, anywhere in a value. */
function replaceId<T>(v: T, from: string, to: string): T {
  if (v === from) return to as T;
  if (Array.isArray(v)) return v.map((x) => replaceId(x, from, to)) as T;
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, replaceId(x, from, to)])) as T;
  return v;
}

export function HouseholdSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      {open ? <HouseholdSheetBody /> : null}
    </Sheet>
  );
}

function HouseholdSheetBody() {
  const doc = useDraftDoc();
  const issues = useIssues(
    Bundle,
    doc ? { household: doc.household, finances: doc.finances } : undefined,
  );
  const [pending, setPending] = useState<CountryChange | null>(null);
  const [regionChoice, setRegionChoice] = useState("");
  const [takeCurrency, setTakeCurrency] = useState(true);
  const [takeLocale, setTakeLocale] = useState(true);
  if (!doc) return null;
  const h = doc.household;
  const plans = doc.plans;
  const refPlan = plans.find((p) => p.isMain) ?? plans[0];
  const update = (fn: (x: Household) => Household, label: string, key?: string) =>
    updateHouseholdOnly(fn, label, key);
  const setPerson = (id: string, patch: Partial<Person>, label: string, key?: string) =>
    update(
      (x) => ({ ...x, people: x.people.map((p) => (p.id === id ? { ...p, ...patch } : p)) }),
      label,
      key ? `${id}:${key}` : undefined,
    );

  const setMode = async (mode: "individual" | "couple") => {
    if (mode === h.planningMode) return;
    if (mode === "couple") {
      const me = h.people.find((p) => p.role === "primary")!;
      const partner: Person = {
        id: newId("p"),
        name: "Partner",
        role: "partner",
        birthMonth: me.birthMonth,
        sex: "unspecified",
        appearance: { color: "ochre" },
      };
      editMany(
        [
          {
            key: "household",
            update: (v) => ({
              ...(v as HouseholdEntity),
              household: {
                ...(v as HouseholdEntity).household,
                planningMode: "couple",
                people: [...h.people, partner],
              },
            }),
          },
          ...plans.map((p) => ({
            key: planKey(p.id) as EntityKey,
            update: (v: unknown) =>
              withLifeExpectancy(v as Plan, partner, lifeExpectancy(v as Plan, me.id) ?? 92),
          })),
        ],
        "Plan as a couple",
      );
      return;
    }
    const partner = h.people.find((p) => p.role === "partner");
    const me = h.people.find((p) => p.role === "primary")!;
    if (!partner) return;
    const ok = await confirmAction({
      title: `Plan for ${me.name} only?`,
      description: `${partner.name} is removed. Accounts, income and events they own move to ${me.name}; their life-expectancy milestones are removed. You can undo this.`,
      confirmLabel: "Switch to individual",
    });
    if (!ok) return;
    editMany(
      [
        {
          key: "household",
          update: (v) => {
            const e = v as HouseholdEntity;
            return {
              household: {
                ...e.household,
                planningMode: "individual",
                people: e.household.people.filter((p) => p.id !== partner.id),
              },
              finances: replaceId(e.finances, partner.id, me.id),
            };
          },
        },
        ...plans.map((p) => ({
          key: planKey(p.id) as EntityKey,
          update: (v: unknown) => {
            const plan = v as Plan;
            const pruned = {
              ...plan,
              milestones: plan.milestones.filter(
                (m) => !(m.kind === "life-expectancy" && m.personId === partner.id),
              ),
            };
            return replaceId(pruned, partner.id, me.id);
          },
        })),
      ],
      "Plan as an individual",
    );
  };

  const applyCountry = (
    change: CountryChange,
    choices: { currency: boolean; locale: boolean; region: string | undefined },
  ) => {
    const after = countryDefaults(change.country);
    update(
      (x) => ({
        ...x,
        location: {
          country: change.country,
          region: choices.region,
          locality: undefined,
        },
        currency: choices.currency ? after.currency : x.currency,
        locale: choices.locale ? after.locale : x.locale,
      }),
      "Change tax residence",
    );
    const regionName = change.regions.find((r) => r.value === choices.region)?.label;
    const bits = [`Tax residence is now ${change.countryName}.`];
    if (choices.currency && change.currencyTo) bits.push(`Currency is ${change.currencyTo}.`);
    else if (change.currencyFrom) bits.push(`Currency stays ${h.currency}.`);
    if (regionName && change.regionLabel) bits.push(`${change.regionLabel} is ${regionName}.`);
    toast({ title: "Country updated", description: bits.join(" ") });
  };

  const setCountry = (country: string) => {
    if (country === h.location.country) return;
    const change = describeCountryChange(h, country);
    if (!change.needsConfirm) {
      applyCountry(change, { currency: false, locale: false, region: change.region });
      return;
    }
    setPending(change);
    setRegionChoice("");
    setTakeCurrency(change.currencyTo !== null);
    setTakeLocale(change.localeTo !== null);
  };

  const confirmCountry = () => {
    if (!pending) return;
    if (pending.regions.length > 0 && !regionChoice) return;
    applyCountry(pending, {
      currency: takeCurrency && pending.currencyTo !== null,
      locale: takeLocale && pending.localeTo !== null,
      region: pending.regions.length > 0 ? regionChoice : pending.region,
    });
    setPending(null);
  };

  const removeDependent = async (d: Dependent) => {
    const touched = plans.filter((p) => planMentions(p, d.id));
    const costs = linkedCosts(plans, d.id).length;
    if (touched.length) {
      const ok = await confirmAction({
        title: `Remove ${d.name}?`,
        description: `${
          costs
            ? `${costs} linked ${costs === 1 ? "cost is" : "costs are"} removed${touched.length > 1 ? ` from ${touched.length} plans` : ""}. `
            : ""
        }Any other date that followed ${d.name}’s age keeps its current month. You can undo this.`,
        confirmLabel: "Remove",
        tone: "danger",
      });
      if (!ok) return;
    }
    editMany(
      [
        {
          key: "household",
          update: (v) => {
            const e = v as HouseholdEntity;
            return {
              ...e,
              household: {
                ...e.household,
                dependents: e.household.dependents.filter((y) => y.id !== d.id),
              },
            };
          },
        },
        ...touched.map((p) => ({
          key: planKey(p.id) as EntityKey,
          update: (v: unknown) => planWithoutDependent(v as Plan, d),
        })),
      ],
      "Remove dependant",
    );
  };

  return (
    <SheetContent
      eyebrow="Household"
      title="About you"
      description="Who the plan is for, where you pay tax, and how money is shown."
      width={620}
      footer={
        <SheetClose asChild>
          <Button variant="primary" className="ml-auto">
            Done
          </Button>
        </SheetClose>
      }
    >
      <FormSection title="Household">
        <FieldGrid>
          <FormField label="Household name" error={issues.get("household.name")}>
            {(id) => (
              <Input
                id={id}
                value={h.name}
                onChange={(e) =>
                  update((x) => ({ ...x, name: e.target.value }), "Rename household", "name")
                }
              />
            )}
          </FormField>
          <FormField label="Planning for">
            {() => (
              <Segmented<"individual" | "couple">
                aria-label="Planning for"
                value={h.planningMode}
                onChange={setMode}
                options={[
                  { value: "individual", label: "Just me" },
                  { value: "couple", label: "A couple" },
                ]}
              />
            )}
          </FormField>
        </FieldGrid>
        {issues.under("household.people") && !issues.get("household.people.0.name") ? (
          <p className="text-[11.5px] text-negative">{issues.under("household.people")}</p>
        ) : null}
      </FormSection>

      {h.people.map((p, i) => {
        const le = lifeExpectancy(refPlan, p.id);
        return (
          <FormSection
            key={p.id}
            title={
              <span className="inline-flex items-center gap-2">
                <AppearanceDot
                  appearance={p.appearance}
                  fallbackIndex={i}
                  fallbackIcon={UserRound}
                  size={20}
                />
                {p.role === "primary" ? "You" : "Partner"}
              </span>
            }
          >
            <FieldGrid>
              <FormField label="Name" error={issues.get(`household.people.${i}.name`)}>
                {(id) => (
                  <Input
                    id={id}
                    value={p.name}
                    onChange={(e) =>
                      setPerson(p.id, { name: e.target.value }, "Rename person", "name")
                    }
                  />
                )}
              </FormField>
              <FormField
                label="Born"
                hint="Month and year are enough."
                error={issues.get(`household.people.${i}.birthMonth`)}
              >
                {(id) => (
                  <Input
                    id={id}
                    type="month"
                    value={p.birthMonth}
                    onChange={(e) =>
                      setPerson(p.id, { birthMonth: e.target.value }, "Edit birth month", "birth")
                    }
                  />
                )}
              </FormField>
              <FormField
                label="Life expectancy"
                help="Sets the life-expectancy milestone in every plan. Plans can still override it in their Milestones."
                hint={
                  plans.length
                    ? `Applies to ${plans.length} ${plans.length === 1 ? "plan" : "plans"}`
                    : "Applies to new plans"
                }
              >
                {(id) => (
                  <NumberInput
                    id={id}
                    decimals={0}
                    suffix="yrs"
                    value={le}
                    onValueChange={(age) => {
                      if (age === null || age < 1 || age > 120) return;
                      editMany(
                        plans.map((pl) => ({
                          key: planKey(pl.id) as EntityKey,
                          update: (v: unknown) => withLifeExpectancy(v as Plan, p, age),
                        })),
                        "Edit life expectancy",
                      );
                    }}
                  />
                )}
              </FormField>
              <EnumField<Person["sex"]>
                label="Sex"
                help="Optional. Used only for survivor benefits and life-table models."
                value={p.sex}
                onChange={(sex) => setPerson(p.id, { sex }, "Edit sex")}
                options={[
                  { value: "unspecified", label: "Prefer not to say" },
                  { value: "female", label: "Female" },
                  { value: "male", label: "Male" },
                ]}
              />
            </FieldGrid>
            <AppearancePicker
              value={p.appearance}
              fallbackIndex={i}
              onChange={(appearance) => setPerson(p.id, { appearance }, "Change appearance")}
            />
            <PersonCrossBorderFields
              person={p}
              home={h.location.country}
              onChange={(patch, label, key) => setPerson(p.id, patch, label, key)}
            />
          </FormSection>
        );
      })}

      <FormSection
        title="Dependants"
        description="Children or others you support. Costs added here follow their age; tax credits and the ACA household size count them until their “independent at” age."
        aside={
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              update(
                (x) => ({
                  ...x,
                  dependents: [
                    ...x.dependents,
                    {
                      id: newId("dep"),
                      name: "Child",
                      birthMonth: doc.finances.asOf,
                      independentAtAge: 18,
                    },
                  ],
                }),
                "Add dependant",
              )
            }
          >
            <Plus /> Add
          </Button>
        }
      >
        {h.dependents.length === 0 ? (
          <p className="text-[12px] text-ink-3">No dependants.</p>
        ) : null}
        {h.dependents.map((d, i) => (
          <div key={d.id} className="flex flex-col gap-2.5 rounded-lg border border-border p-3">
            <div className="grid items-end gap-2 sm:grid-cols-[1fr_150px_110px_auto]">
              <FormField label="Name" error={issues.get(`household.dependents.${i}.name`)}>
                {(id) => (
                  <Input
                    id={id}
                    value={d.name}
                    onChange={(e) =>
                      update(
                        (x) => ({
                          ...x,
                          dependents: x.dependents.map((y) =>
                            y.id === d.id ? { ...y, name: e.target.value } : y,
                          ),
                        }),
                        "Edit dependant",
                        `${d.id}:name`,
                      )
                    }
                  />
                )}
              </FormField>
              <FormField label="Born" error={issues.get(`household.dependents.${i}.birthMonth`)}>
                {(id) => (
                  <Input
                    id={id}
                    type="month"
                    value={d.birthMonth}
                    onChange={(e) =>
                      update(
                        (x) => ({
                          ...x,
                          dependents: x.dependents.map((y) =>
                            y.id === d.id ? { ...y, birthMonth: e.target.value } : y,
                          ),
                        }),
                        "Edit dependant",
                        `${d.id}:birth`,
                      )
                    }
                  />
                )}
              </FormField>
              <FormField label="Independent at">
                {(id) => (
                  <NumberInput
                    id={id}
                    decimals={0}
                    suffix="yrs"
                    value={d.independentAtAge}
                    onValueChange={(v) =>
                      update(
                        (x) => ({
                          ...x,
                          dependents: x.dependents.map((y) =>
                            y.id === d.id ? { ...y, independentAtAge: Math.round(v ?? 18) } : y,
                          ),
                        }),
                        "Edit dependant",
                        `${d.id}:ind`,
                      )
                    }
                  />
                )}
              </FormField>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Remove ${d.name}`}
                onClick={() => removeDependent(d)}
              >
                <Trash2 />
              </Button>
            </div>
            <DependentCosts dependent={d} doc={doc} refPlan={refPlan} />
          </div>
        ))}
      </FormSection>

      <FormSection
        title="Tax residence"
        description="Where you live, for the whole plan; it decides which tax rules apply when a plan estimates taxes. Accounts, property and income in another country can be taxed there too, with credit here for that tax."
      >
        <FieldGrid>
          <EnumField
            label="Country"
            value={h.location.country}
            onChange={setCountry}
            options={COUNTRY_OPTIONS}
          />
          {countryInfo(h.location.country)?.regions ? (
            <EnumField
              label={countryInfo(h.location.country)?.regionLabel ?? "Region"}
              value={h.location.region ?? ""}
              onChange={(region) =>
                update((x) => ({ ...x, location: { ...x.location, region } }), "Edit region")
              }
              options={countryInfo(h.location.country)!.regions!}
            />
          ) : (
            <FormField label="Region" hint="Optional; this country's estimate does not use it.">
              {(id) => (
                <Input
                  id={id}
                  value={h.location.region ?? ""}
                  maxLength={10}
                  onChange={(e) =>
                    update(
                      (x) => ({
                        ...x,
                        location: {
                          ...x.location,
                          region: e.target.value.toUpperCase() || undefined,
                        },
                      }),
                      "Edit region",
                      "region",
                    )
                  }
                />
              )}
            </FormField>
          )}
          {h.location.country === "US" ? (
            <FormField label="City tax" hint="e.g. nyc, philadelphia (optional)">
              {(id) => (
                <Input
                  id={id}
                  value={h.location.locality ?? ""}
                  onChange={(e) =>
                    update(
                      (x) => ({
                        ...x,
                        location: { ...x.location, locality: e.target.value || undefined },
                      }),
                      "Edit locality",
                      "locality",
                    )
                  }
                />
              )}
            </FormField>
          ) : null}
        </FieldGrid>
      </FormSection>

      <FormSection
        title="Money format"
        description="All amounts are in one currency. Formatting follows the number style below."
      >
        <FieldGrid>
          <FormField label="Currency">
            {(id) => (
              <Select
                id={id}
                value={h.currency}
                onValueChange={(currency) => update((x) => ({ ...x, currency }), "Change currency")}
                options={CURRENCIES.map((c) => ({ value: c, label: c }))}
              />
            )}
          </FormField>
          <FormField
            label="Number & date style"
            hint={new Intl.NumberFormat(h.locale, {
              style: "currency",
              currency: h.currency,
            }).format(1234567.89)}
          >
            {(id) => (
              <Select
                id={id}
                value={h.locale}
                onValueChange={(locale) => update((x) => ({ ...x, locale }), "Change locale")}
                options={LOCALES.map((l) => ({ value: l, label: l }))}
              />
            )}
          </FormField>
        </FieldGrid>
      </FormSection>
      <p className="flex items-center gap-1.5 pt-1 text-[11.5px] text-ink-3">
        <Users className="size-3.5" /> Changes save automatically.
      </p>
      <Dialog open={pending !== null} onOpenChange={(o) => !o && setPending(null)}>
        {pending ? (
          <DialogContent
            title={`Change country to ${pending.countryName}?`}
            description="Tax rules follow the country. Amounts are not converted."
            className="w-[min(92vw,440px)]"
          >
            <div className="flex flex-col gap-4">
              {pending.currencyFrom && pending.currencyTo ? (
                <SwitchField
                  label={`Change currency from ${pending.currencyFrom} to ${pending.currencyTo}`}
                  hint="The numbers stay as entered. A salary of 45,000 is still 45,000 in the new currency."
                  checked={takeCurrency}
                  onCheckedChange={setTakeCurrency}
                />
              ) : null}
              {pending.localeFrom && pending.localeTo ? (
                <SwitchField
                  label={`Change number format from ${pending.localeFrom} to ${pending.localeTo}`}
                  checked={takeLocale}
                  onCheckedChange={setTakeLocale}
                />
              ) : null}
              {pending.regions.length > 0 && pending.regionLabel ? (
                <FormField
                  label={pending.regionLabel}
                  hint={
                    pending.regionAffectsTax
                      ? `${pending.regionLabel} was left blank. The tax estimate uses it, so choose one before changing country.`
                      : `Choose a ${pending.regionLabel.toLowerCase()} to continue.`
                  }
                >
                  {(id) => (
                    <Select
                      id={id}
                      value={regionChoice}
                      placeholder={`Choose a ${pending.regionLabel?.toLowerCase()}`}
                      onValueChange={setRegionChoice}
                      options={pending.regions}
                    />
                  )}
                </FormField>
              ) : null}
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="ghost" onClick={() => setPending(null)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  disabled={pending.regions.length > 0 && !regionChoice}
                  onClick={confirmCountry}
                >
                  Change country
                </Button>
              </div>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </SheetContent>
  );
}
