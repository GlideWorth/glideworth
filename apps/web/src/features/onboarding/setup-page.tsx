/**
 * Guided setup: six short steps to a sensible first plan in about two minutes. Everything is a
 * starting point; the summary on the right updates as you type.
 */

import { ACCOUNT_TYPE_INFO, type AccountType } from "@glideworth/core";
import { usePostHog } from "@posthog/react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, Check, Loader2, Plus, Trash2, X } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useMemo, useState } from "react";
import { Wordmark } from "../../components/layout/logo";
import { Button } from "../../components/ui/button";
import { confirmAction } from "../../components/ui/confirm-dialog";
import { Field, Input } from "../../components/ui/input";
import { NumberInput } from "../../components/ui/number-input";
import { Segmented } from "../../components/ui/segmented";
import { Select } from "../../components/ui/select";
import { SwitchField } from "../../components/ui/switch";
import { toast } from "../../components/ui/toaster";
import { isExplainedProblem } from "../../lib/api-problems";
import { useMode } from "../../lib/auth";
import { cn } from "../../lib/cn";
import { COUNTRY_OPTIONS, countryDefaultsFor } from "../../lib/countries";
import { currencySymbol, formatMoney } from "../../lib/format";
import { useWorkspace } from "../../lib/workspace";
import { usePrefs } from "../../stores/prefs";
import { clearHandoff, applyHandoff, readHandoff } from "../cloud/handoff";
import { HandoffApplied } from "../cloud/handoff-notice";
import { persistWorkspace } from "../import/persist";
import { countryFromLocale } from "../import/starter";
import { countryDefaults } from "../plan-editor/state/defaults";
import { accountTypeOptions } from "../plan-editor/state/labels";
import {
  buildSetupDocument,
  COUNTRIES,
  CURRENCIES,
  defaultAnswers,
  type OwnerChoice,
  type SetupAnswers,
  suggestedAccounts,
  validateAnswers,
} from "./build-document";

const STEPS = [
  { id: "place", title: "Where you live", hint: "Sets currency, tax year and account types." },
  { id: "people", title: "Who is in the plan", hint: "Ages drive retirement and pension dates." },
  { id: "accounts", title: "What you have", hint: "A few balances are enough to start." },
  { id: "income", title: "What you earn", hint: "Gross pay before tax, per year." },
  { id: "spending", title: "What you spend", hint: "A rough figure is fine." },
  { id: "goal", title: "Your retirement goal", hint: "When you would like to stop working." },
] as const;

const LOCALES = [
  "en-GB",
  "en-US",
  "en-CA",
  "en-AU",
  "en-IE",
  "en-NZ",
  "de-DE",
  "fr-FR",
  "nl-NL",
  "es-ES",
  "de-CH",
  "sv-SE",
];

const MONTHS = Array.from({ length: 12 }, (_, i) => ({
  value: String(i + 1).padStart(2, "0"),
  label: new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" }).format(
    Date.UTC(2000, i, 1),
  ),
}));

export function SetupPage() {
  const now = useMemo(() => new Date(), []);
  // Hosted mode: inputs carried over from a free calculator (features/cloud/handoff.ts).
  const cloud = useMode() === "cloud";
  const [handoff, setHandoff] = useState(() => (cloud ? readHandoff() : null));
  const [a, setA] = useState<SetupAnswers>(() =>
    handoff
      ? applyHandoff(handoff, now).answers
      : defaultAnswers(countryFromLocale(navigator.language), now),
  );
  const [step, setStep] = useState(0);
  const [touched, setTouched] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const posthog = usePostHog();
  const { data: ws } = useWorkspace();
  const prefs = usePrefs();
  const errors = validateAnswers(a, now);
  const fmt = { locale: a.locale, currency: a.currency };
  const money = (v: number) => formatMoney(v, fmt);
  const sym = currencySymbol(fmt);
  const couple = !!a.partner;
  const update = (patch: Partial<SetupAnswers>) => setA((x) => ({ ...x, ...patch }));

  const stepErrors = (i: number): string[] => {
    const keys: Record<number, string[]> = {
      0: ["region"],
      1: ["you.name", "you.birthMonth", "partner.name", "partner.birthMonth"],
      2: ["accounts"],
      5: ["lifeExpectancy", "planName"],
    };
    return (keys[i] ?? []).filter((k) => errors[k]);
  };
  const err = (k: string, i: number) => (touched[i] ? errors[k] : undefined);

  const next = () => {
    setTouched((t) => ({ ...t, [step]: true }));
    if (stepErrors(step).length) return;
    if (step < STEPS.length - 1) setStep(step + 1);
    else void finish();
  };

  const finish = async () => {
    const allBad = STEPS.map((_, i) => i).filter((i) => stepErrors(i).length);
    if (allBad.length) {
      setTouched(Object.fromEntries(STEPS.map((_, i) => [i, true])));
      setStep(allBad[0]!);
      return;
    }
    if (
      ws?.source === "api" &&
      !(await confirmAction({
        title: "Replace your current data?",
        description:
          "Setting up again replaces your household, plans and history with this new plan. Download a backup first if you might want them back.",
        confirmLabel: "Replace and create",
      }))
    )
      return;
    setBusy(true);
    try {
      const pd = prefs.planDefaults;
      const doc = buildSetupDocument(
        {
          ...a,
          assumptions: {
            inflation: pd.inflation,
            stockReturn: pd.stockReturn,
            bondReturn: pd.bondReturn,
          },
          monteCarloTrials: prefs.monteCarlo.trials,
        },
        { now },
      );
      const out = await persistWorkspace(qc, doc);
      clearHandoff();
      posthog?.capture("onboarding_plan_created");
      prefs.set({ tour: "welcome" });
      toast({
        title: `“${doc.plans[0]!.name}” is ready`,
        description:
          out.where === "server"
            ? "Every figure is a starting point: refine it in Current finances and the plan editor."
            : "The server is offline, so this lives in this browser for now.",
        tone: "positive",
      });
      await navigate({ to: "/" });
    } catch (e) {
      // A read-only workspace or a used-up limit is already explained by the shell.
      if (!isExplainedProblem(e))
        toast({
          title: "Could not create your plan",
          description: e instanceof Error ? e.message : String(e),
          tone: "negative",
        });
      setBusy(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    next();
  };

  const age = now.getUTCFullYear() - Number(a.you.birthMonth.slice(0, 4));
  const retireYear = now.getUTCFullYear() + Math.max(0, a.retirementAge - age);
  const netWorth = a.accounts.reduce((s, x) => s + (x.balance || 0), 0);
  const yearlySpend =
    (a.spending.essential + a.spending.discretionary) *
    (a.spending.frequency === "monthly" ? 12 : 1);
  const yearlyIncome = a.salary.me + (couple ? a.salary.partner : 0);
  const current = STEPS[step]!;

  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex w-full max-w-[1080px] items-center justify-between px-4 pt-5 sm:px-8">
        <Wordmark />
        <Button variant="ghost" size="sm" asChild>
          <Link to="/welcome">
            <X /> Leave setup
          </Link>
        </Button>
      </header>
      <div className="mx-auto grid w-full max-w-[1080px] gap-8 px-4 pt-8 pb-16 sm:px-8 lg:grid-cols-[220px_minmax(0,1fr)_260px]">
        {/* Step list */}
        <nav aria-label="Setup steps" className="hidden lg:block">
          <ol className="flex flex-col gap-1">
            {STEPS.map((s, i) => {
              const state = i < step ? "done" : i === step ? "current" : "todo";
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => i <= step && setStep(i)}
                    disabled={i > step}
                    aria-current={state === "current" ? "step" : undefined}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors",
                      state === "current"
                        ? "bg-surface font-semibold text-ink shadow-card"
                        : "text-ink-2",
                      state === "done" && "hover:bg-surface-2",
                      state === "todo" && "text-ink-3",
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-5 shrink-0 items-center justify-center rounded-full border text-[10.5px] font-semibold",
                        state === "done" && "border-accent bg-accent text-accent-ink",
                        state === "current" && "border-accent text-accent",
                        state === "todo" && "border-border-strong",
                      )}
                    >
                      {state === "done" ? <Check className="size-3" /> : i + 1}
                    </span>
                    {s.title}
                  </button>
                </li>
              );
            })}
          </ol>
          <p className="mt-4 px-2 text-[11.5px] text-ink-3">
            About two minutes. Nothing is saved until the last step.
          </p>
        </nav>

        {/* Step body */}
        <form onSubmit={onSubmit} className="min-w-0" noValidate>
          <div className="mb-5">
            <div className="mb-3 flex items-center gap-2 lg:hidden" aria-hidden>
              {STEPS.map((s, i) => (
                <span
                  key={s.id}
                  className={cn(
                    "h-1 flex-1 rounded-full",
                    i <= step ? "bg-accent" : "bg-surface-3",
                  )}
                />
              ))}
            </div>
            <p className="eyebrow">
              Step {step + 1} of {STEPS.length}
            </p>
            <h1
              className="display mt-1 text-[28px] leading-tight font-semibold outline-none"
              tabIndex={-1}
            >
              {current.title}
            </h1>
            <p className="mt-1 text-ink-2">{current.hint}</p>
          </div>

          {handoff && step === 0 ? (
            <HandoffApplied
              handoff={handoff}
              onReset={() => {
                clearHandoff();
                setHandoff(null);
                setA(defaultAnswers(countryFromLocale(navigator.language), now));
              }}
            />
          ) : null}
          <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-5 shadow-card">
            {current.id === "place" ? (
              <>
                <Field label="Country of tax residence">
                  {(id) => (
                    <Select
                      id={id}
                      value={a.country}
                      onValueChange={(country) => {
                        const cd = countryDefaults(country);
                        update({
                          country,
                          region: countryDefaultsFor(country).defaultRegion ?? undefined,
                          currency: cd.currency,
                          locale: cd.locale,
                          retirementAge: cd.retirementAge,
                          accounts: suggestedAccounts(country)
                            .slice(0, 3)
                            .map((x, i) => ({
                              key: `a${i}-${country}`,
                              ...x,
                              balance: 0,
                              owner: "me" as OwnerChoice,
                            })),
                        });
                      }}
                      options={COUNTRY_OPTIONS}
                    />
                  )}
                </Field>
                {COUNTRIES.find((c) => c.code === a.country)?.regions ? (
                  <Field
                    label={COUNTRIES.find((c) => c.code === a.country)?.regionLabel ?? "Region"}
                    error={err("region", 0)}
                    hint={
                      a.country === "GB"
                        ? "Scotland has its own income-tax bands."
                        : COUNTRIES.find((c) => c.code === a.country)?.regionAffectsTax
                          ? "Regional tax applies, so this changes your tax estimate."
                          : undefined
                    }
                  >
                    {(id) => (
                      <Select
                        id={id}
                        value={a.region ?? ""}
                        placeholder="Choose…"
                        onValueChange={(region) => update({ region })}
                        options={COUNTRIES.find((c) => c.code === a.country)!.regions!.map((r) => ({
                          value: r.code,
                          label: r.label,
                        }))}
                      />
                    )}
                  </Field>
                ) : null}
                {countryDefaultsFor(a.country).notes?.length ? (
                  <ul className="flex flex-col gap-1 rounded-lg border border-border bg-surface-2 px-3 py-2 text-[12px] text-ink-2">
                    {countryDefaultsFor(a.country).notes!.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                ) : null}
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Currency">
                    {(id) => (
                      <Select
                        id={id}
                        value={a.currency}
                        onValueChange={(currency) => update({ currency })}
                        options={[...new Set([a.currency, ...CURRENCIES])].map((c) => ({
                          value: c,
                          label: `${c} · ${currencySymbol({ locale: a.locale, currency: c })}`,
                        }))}
                      />
                    )}
                  </Field>
                  <Field label="Number and date format" hint={`For example ${money(1234567.89)}`}>
                    {(id) => (
                      <Select
                        id={id}
                        value={a.locale}
                        onValueChange={(locale) => update({ locale })}
                        options={[...new Set([a.locale, ...LOCALES])].map((l) => ({
                          value: l,
                          label: `${l} · ${new Intl.NumberFormat(l).format(1234.5)}`,
                        }))}
                      />
                    )}
                  </Field>
                </div>
              </>
            ) : null}

            {current.id === "people" ? (
              <>
                <PersonFields
                  label="You"
                  person={a.you}
                  onChange={(you) => update({ you })}
                  errors={{ name: err("you.name", 1), birth: err("you.birthMonth", 1) }}
                />
                <div className="border-t border-border pt-4">
                  <SwitchField
                    label="I am planning with a partner"
                    hint="Shared finances, two incomes, survivor scenarios."
                    checked={couple}
                    onCheckedChange={(on) =>
                      update({ partner: on ? { name: "", birthMonth: a.you.birthMonth } : null })
                    }
                  />
                </div>
                {a.partner ? (
                  <PersonFields
                    label="Your partner"
                    person={a.partner}
                    onChange={(partner) => update({ partner })}
                    errors={{ name: err("partner.name", 1), birth: err("partner.birthMonth", 1) }}
                  />
                ) : null}
              </>
            ) : null}

            {current.id === "accounts" ? (
              <>
                <p className="text-[12.5px] text-ink-2">
                  Today’s balances. Leave anything you do not have at zero; you can add property,
                  debts and more accounts later in Current finances.
                </p>
                <ul className="flex flex-col gap-3">
                  {a.accounts.map((acc, i) => (
                    <li
                      key={acc.key}
                      className="grid grid-cols-[1fr_auto] gap-2 rounded-lg border border-border p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_140px_auto] sm:items-end sm:border-0 sm:p-0"
                    >
                      <Field label={i === 0 ? "Type" : ""} className="col-span-2 sm:col-span-1">
                        {(id) => (
                          <Select
                            id={id}
                            aria-label={`Account ${i + 1} type`}
                            value={acc.type}
                            onValueChange={(type) =>
                              update({
                                accounts: a.accounts.map((x) =>
                                  x.key === acc.key
                                    ? {
                                        ...x,
                                        type: type as AccountType,
                                        name:
                                          x.name === ACCOUNT_TYPE_INFO[x.type].label || !x.name
                                            ? ACCOUNT_TYPE_INFO[type as AccountType].label
                                            : x.name,
                                      }
                                    : x,
                                ),
                              })
                            }
                            options={accountTypeOptions(a.country)}
                          />
                        )}
                      </Field>
                      <Field label={i === 0 ? "Name" : ""} className="col-span-2 sm:col-span-1">
                        {(id) => (
                          <Input
                            id={id}
                            aria-label={`Account ${i + 1} name`}
                            value={acc.name}
                            onChange={(e) =>
                              update({
                                accounts: a.accounts.map((x) =>
                                  x.key === acc.key ? { ...x, name: e.target.value } : x,
                                ),
                              })
                            }
                          />
                        )}
                      </Field>
                      <Field label={i === 0 ? "Balance" : ""}>
                        {(id) => (
                          <NumberInput
                            id={id}
                            aria-label={`${acc.name || "Account"} balance`}
                            locale={a.locale}
                            prefix={sym}
                            sensitive
                            decimals={0}
                            value={acc.balance}
                            onValueChange={(v) =>
                              update({
                                accounts: a.accounts.map((x) =>
                                  x.key === acc.key ? { ...x, balance: v ?? 0 } : x,
                                ),
                              })
                            }
                          />
                        )}
                      </Field>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="self-end"
                        aria-label={`Remove ${acc.name || "account"}`}
                        onClick={() =>
                          update({ accounts: a.accounts.filter((x) => x.key !== acc.key) })
                        }
                      >
                        <Trash2 />
                      </Button>
                      {couple ? (
                        <div className="col-span-2 sm:col-span-4 sm:-mt-1">
                          <Segmented
                            size="sm"
                            aria-label={`Who owns ${acc.name || "this account"}`}
                            value={acc.owner}
                            onChange={(owner) =>
                              update({
                                accounts: a.accounts.map((x) =>
                                  x.key === acc.key ? { ...x, owner } : x,
                                ),
                              })
                            }
                            options={[
                              { value: "me", label: a.you.name || "You" },
                              { value: "partner", label: a.partner?.name || "Partner" },
                              { value: "joint", label: "Joint" },
                            ]}
                          />
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {err("accounts", 2) ? (
                  <p className="text-[12px] text-negative">{errors.accounts}</p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {suggestedAccounts(a.country)
                    .filter((s) => !a.accounts.some((x) => x.type === s.type))
                    .slice(0, 3)
                    .map((s) => (
                      <Button
                        key={s.type}
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          update({
                            accounts: [
                              ...a.accounts,
                              { key: `k${Date.now()}`, ...s, balance: 0, owner: "me" },
                            ],
                          })
                        }
                      >
                        <Plus /> {s.name}
                      </Button>
                    ))}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      update({
                        accounts: [
                          ...a.accounts,
                          {
                            key: `k${Date.now()}`,
                            type: "savings",
                            name: "Savings",
                            balance: 0,
                            owner: "me",
                          },
                        ],
                      })
                    }
                  >
                    <Plus /> Another account
                  </Button>
                </div>
              </>
            ) : null}

            {current.id === "income" ? (
              <>
                <Field
                  label={`${a.you.name || "Your"}${a.you.name ? "’s" : ""} salary per year`}
                  hint="Before tax. Grows with inflation until retirement."
                >
                  {(id) => (
                    <NumberInput
                      id={id}
                      locale={a.locale}
                      prefix={sym}
                      sensitive
                      decimals={0}
                      value={a.salary.me}
                      onValueChange={(v) => update({ salary: { ...a.salary, me: v ?? 0 } })}
                    />
                  )}
                </Field>
                {couple ? (
                  <Field label={`${a.partner?.name || "Partner"}’s salary per year`}>
                    {(id) => (
                      <NumberInput
                        id={id}
                        locale={a.locale}
                        prefix={sym}
                        sensitive
                        decimals={0}
                        value={a.salary.partner}
                        onValueChange={(v) => update({ salary: { ...a.salary, partner: v ?? 0 } })}
                      />
                    )}
                  </Field>
                ) : null}
                <p className="text-[12px] text-ink-3">
                  A{" "}
                  {a.country === "US"
                    ? "Social Security"
                    : a.country === "CA"
                      ? "CPP"
                      : "state pension"}{" "}
                  estimate is added automatically from pension age. Bonuses, rental income and side
                  work can be added in the plan editor.
                </p>
              </>
            ) : null}

            {current.id === "spending" ? (
              <>
                <Segmented
                  aria-label="Enter spending per"
                  value={a.spending.frequency}
                  onChange={(frequency) => update({ spending: { ...a.spending, frequency } })}
                  options={[
                    { value: "monthly", label: "Per month" },
                    { value: "yearly", label: "Per year" },
                  ]}
                />
                <Field
                  label="Everyday essentials"
                  hint="Housing, food, bills, transport: what you would still pay in a lean year."
                >
                  {(id) => (
                    <NumberInput
                      id={id}
                      locale={a.locale}
                      prefix={sym}
                      sensitive
                      decimals={0}
                      value={a.spending.essential}
                      onValueChange={(v) =>
                        update({ spending: { ...a.spending, essential: v ?? 0 } })
                      }
                    />
                  )}
                </Field>
                <Field
                  label="Travel and fun"
                  hint="Discretionary spending you could trim if markets fall."
                >
                  {(id) => (
                    <NumberInput
                      id={id}
                      locale={a.locale}
                      prefix={sym}
                      sensitive
                      decimals={0}
                      value={a.spending.discretionary}
                      onValueChange={(v) =>
                        update({ spending: { ...a.spending, discretionary: v ?? 0 } })
                      }
                    />
                  )}
                </Field>
                {yearlyIncome > 0 && yearlySpend > 0 ? (
                  <p className="text-[12px] text-ink-3">
                    That is {money(yearlySpend)} a year, about{" "}
                    {Math.round((yearlySpend / yearlyIncome) * 100)}% of gross pay.
                  </p>
                ) : null}
              </>
            ) : null}

            {current.id === "goal" ? (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label="Retire at age"
                    hint={
                      a.retirementAge > age
                        ? `In ${retireYear}, ${a.retirementAge - age} years from now.`
                        : "Already retired."
                    }
                  >
                    {(id) => (
                      <NumberInput
                        id={id}
                        locale={a.locale}
                        decimals={0}
                        suffix="years"
                        value={a.retirementAge}
                        onValueChange={(v) =>
                          update({ retirementAge: Math.round(v ?? a.retirementAge) })
                        }
                      />
                    )}
                  </Field>
                  <Field
                    label="Plan until age"
                    hint="Planning for a long life is the cautious choice."
                    error={err("lifeExpectancy", 5)}
                  >
                    {(id) => (
                      <NumberInput
                        id={id}
                        locale={a.locale}
                        decimals={0}
                        suffix="years"
                        value={a.lifeExpectancy}
                        onValueChange={(v) =>
                          update({ lifeExpectancy: Math.round(v ?? a.lifeExpectancy) })
                        }
                      />
                    )}
                  </Field>
                </div>
                <Field label="Name this plan" error={err("planName", 5)}>
                  {(id) => (
                    <Input
                      id={id}
                      value={a.planName}
                      onChange={(e) => update({ planName: e.target.value })}
                    />
                  )}
                </Field>
                <p className="text-[12px] text-ink-3">
                  Glideworth will add a savings waterfall into your accounts and today’s inflation
                  and return assumptions (from Settings → Planning defaults). You can change all of
                  it in the plan editor.
                </p>
              </>
            ) : null}
          </div>

          <div className="mt-5 flex items-center gap-2">
            {step > 0 ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setStep(step - 1)}
                disabled={busy}
              >
                <ArrowLeft /> Back
              </Button>
            ) : null}
            <Button type="submit" variant="primary" size="lg" className="ml-auto" disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              {step === STEPS.length - 1 ? "Create my plan" : "Continue"}
              {!busy && step < STEPS.length - 1 ? <ArrowRight /> : null}
            </Button>
          </div>
        </form>

        {/* Live summary */}
        <aside className="hidden lg:block" aria-label="Summary so far">
          <div className="sticky top-6 flex flex-col gap-4 rounded-xl border border-border bg-surface/70 p-4">
            <div className="eyebrow">So far</div>
            <Summary
              label="Household"
              value={
                couple
                  ? `${a.you.name || "You"} & ${a.partner?.name || "partner"}`
                  : a.you.name || "You"
              }
            />
            <Summary label="Net worth today" value={money(netWorth)} num />
            <Summary
              label="Income"
              value={yearlyIncome ? `${money(yearlyIncome)} / yr` : "—"}
              num
            />
            <Summary
              label="Spending"
              value={yearlySpend ? `${money(yearlySpend)} / yr` : "—"}
              num
            />
            <Summary
              label="Retirement"
              value={a.retirementAge > age ? `${retireYear} · age ${a.retirementAge}` : "Now"}
              num
            />
          </div>
        </aside>
      </div>
    </div>
  );
}

function Summary({ label, value, num }: { label: string; value: ReactNode; num?: boolean }) {
  return (
    <div>
      <div className="text-[11.5px] text-ink-3">{label}</div>
      <div className={cn("truncate text-[14px] font-semibold text-ink", num && "num")}>{value}</div>
    </div>
  );
}

function PersonFields({
  label,
  person,
  onChange,
  errors,
}: {
  label: string;
  person: { name: string; birthMonth: string };
  onChange: (p: { name: string; birthMonth: string }) => void;
  errors: { name?: string; birth?: string };
}) {
  const yearId = useId();
  const [y, m] = person.birthMonth.split("-");
  return (
    <fieldset className="grid gap-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]">
      <legend className="eyebrow mb-2">{label}</legend>
      <Field label="First name" error={errors.name} hint="Only used for labels.">
        {(id) => (
          <Input
            id={id}
            value={person.name}
            autoComplete="given-name"
            aria-invalid={!!errors.name || undefined}
            onChange={(e) => onChange({ ...person, name: e.target.value })}
          />
        )}
      </Field>
      <div className="flex flex-col gap-1">
        <label htmlFor={yearId} className="text-[12px] font-medium text-ink-2">
          Birth year
        </label>
        <Input
          id={yearId}
          inputMode="numeric"
          className="num"
          value={y}
          aria-invalid={!!errors.birth || undefined}
          onChange={(e) =>
            onChange({
              ...person,
              birthMonth: `${e.target.value.replace(/\D/g, "").slice(0, 4)}-${m}`,
            })
          }
        />
        {errors.birth ? <p className="text-[11.5px] text-negative">{errors.birth}</p> : null}
      </div>
      <Field label="Birth month">
        {(id) => (
          <Select
            id={id}
            value={m}
            onValueChange={(mm) => onChange({ ...person, birthMonth: `${y}-${mm}` })}
            options={MONTHS}
          />
        )}
      </Field>
    </fieldset>
  );
}
