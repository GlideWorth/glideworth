/**
 * Income across borders: where an income comes from (pay without a country is earned where the
 * household lives), government-service pensions (taxed by the paying country under most
 * treaties), and the UAE end-of-service gratuity on a salary.
 */
import { AE_GRATUITY, type IncomeEvent, JOINT } from "@glideworth/core";
import { Input } from "../../components/ui/input";
import { PercentInput } from "../../components/ui/number-input";
import { Select } from "../../components/ui/select";
import { FieldGrid, FormSection } from "../../components/ui/sheet";
import { SwitchField } from "../../components/ui/switch";
import { COUNTRY_LIST, countryLabel } from "../../lib/countries";
import { useReferencePlan } from "../finances/use-finances";
import { FormField } from "../plan-editor/components/form";
import { usePlan } from "../plan-editor/components/plan-context";
import { useEditorStore } from "../plan-editor/state/doc-store";
import { CurrencyPrompt } from "./fields";
import { isCrossBorder } from "./model";

const EARNED = new Set(["salary", "hourly", "bonus", "rsu", "self-employment"]);
const SAME = "__same";
const COUNTRIES = COUNTRY_LIST.filter((c) => c.code !== "XX").map((c) => ({
  value: c.code,
  label: c.label,
}));

/** Countries a plan touches: home and its income. */
function planCountries(home: string, plan: ReturnType<typeof usePlan>): Set<string> {
  const out = new Set([home]);
  for (const e of plan?.income ?? []) if (e.country) out.add(e.country);
  return out;
}

export function IncomeCrossBorder({
  event,
  patch,
}: {
  event: IncomeEvent;
  patch: (v: Record<string, unknown>, label: string, key?: string) => void;
}) {
  const editing = usePlan();
  const reference = useReferencePlan();
  const plan = editing ?? reference;
  const doc = useEditorStore((s) => s.draft);
  if (!doc) return null;
  const home = doc.household.location.country;
  const earned = EARNED.has(event.type);
  const relevant = isCrossBorder(doc, plan);
  const countries = planCountries(home, plan);
  const pensionLike = event.type === "pension" || event.type === "annuity";
  const gratuityRelevant =
    event.type === "salary" &&
    (countries.has("AE") || event.country === "AE" || !!event.endOfService);
  const sal = event.type === "salary" ? (event as Extract<IncomeEvent, { type: "salary" }>) : null;
  const eos = sal?.endOfService;
  const country = event.country;
  const fallback = `${countryLabel(home)} (household)`;

  return (
    <FormSection
      title="Where it comes from"
      description={
        relevant
          ? "The country an income comes from may tax it even when you live elsewhere; the country you live in taxes it too, with a credit for double tax."
          : undefined
      }
    >
      <FieldGrid>
        <FormField
          label="Country"
          help={
            earned
              ? "Pay is taxed where the work is done: leave this for work done where you live, or set it for work done in another country."
              : "The paying country: a foreign pension, rent or other income from abroad."
          }
        >
          {(id) => (
            <Select
              id={id}
              value={country ?? SAME}
              onValueChange={(v) =>
                patch({ country: v === SAME ? undefined : v }, "Change income country")
              }
              options={[{ value: SAME, label: `Not set: ${fallback}` }, ...COUNTRIES]}
            />
          )}
        </FormField>
      </FieldGrid>
      {country ? (
        <CurrencyPrompt
          what="This income"
          country={country}
          currency={event.currency}
          onUseCurrency={(currency) => patch({ currency }, "Change currency")}
        />
      ) : null}
      {pensionLike && (relevant || event.governmentService) ? (
        <SwitchField
          label="Government or public-service pension"
          hint="Civil service, armed forces, local government… Most treaties let only the paying country tax it (unless you are a citizen of, and live in, the other country)."
          checked={!!event.governmentService}
          onCheckedChange={(v) =>
            patch({ governmentService: v || undefined }, "Government pension")
          }
        />
      ) : null}
      {sal && gratuityRelevant ? (
        <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
          <SwitchField
            label="UAE end-of-service gratuity"
            hint={`Paid as a lump sum in the month after this salary ends: ${AE_GRATUITY.daysFirstFiveYears} days of basic wage a year for the first ${AE_GRATUITY.firstTierYears} years, ${AE_GRATUITY.daysAfterFiveYears} after, capped at ${AE_GRATUITY.capYearsOfWage} years' wage; nothing before ${AE_GRATUITY.minYears} year of service. Not for employers in DEWS or a savings scheme.`}
            checked={!!eos}
            onCheckedChange={(on) =>
              patch(
                { endOfService: on ? { scheme: "ae-gratuity", basicShare: 1 } : undefined },
                "End-of-service gratuity",
              )
            }
          />
          {eos ? (
            <FieldGrid>
              <FormField
                label="Service started"
                hint="First month of continuous service. Empty: when this salary starts (or the plan start)."
              >
                {(id) => (
                  <Input
                    id={id}
                    type="month"
                    value={eos.serviceStart ?? ""}
                    onChange={(e) =>
                      patch(
                        { endOfService: { ...eos, serviceStart: e.target.value || undefined } },
                        "Edit gratuity",
                        "eos-start",
                      )
                    }
                  />
                )}
              </FormField>
              <FormField
                label="Basic wage share"
                help="The gratuity is worked out on basic wage only; allowances (housing, transport) are excluded."
                hint="Share of this salary that is basic wage."
              >
                {(id) => (
                  <PercentInput
                    id={id}
                    value={eos.basicShare}
                    onValueChange={(v) =>
                      patch(
                        { endOfService: { ...eos, basicShare: Math.max(0, Math.min(1, v ?? 1)) } },
                        "Edit gratuity",
                        "eos-share",
                      )
                    }
                  />
                )}
              </FormField>
            </FieldGrid>
          ) : null}
          {eos && event.owner === JOINT ? (
            <p className="text-[11.5px] text-negative">
              A gratuity belongs to one employee: set this salary's owner to a person.
            </p>
          ) : null}
        </div>
      ) : null}
    </FormSection>
  );
}
