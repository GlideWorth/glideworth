import { Link } from "@tanstack/react-router";
import { Select } from "../../components/ui/select";
import { useMode } from "../../lib/auth";
import { currencySymbol, formatMoney, formatPercent } from "../../lib/format";
import { useSettings, useUpdateSettings } from "../../lib/settings";
import { useWorkspace } from "../../lib/workspace";
import { type DateStyle, type TaxYearConvention, usePrefs } from "../../stores/prefs";
import { CURRENCIES } from "../onboarding/build-document";
import { SecurityGroup } from "./security-group";
import { SectionIntro, SettingRow, SettingsGroup } from "./settings-ui";

const LOCALES = [
  "en-GB",
  "en-US",
  "en-CA",
  "en-AU",
  "en-IE",
  "en-NZ",
  "de-DE",
  "de-CH",
  "fr-FR",
  "nl-NL",
  "es-ES",
  "it-IT",
  "sv-SE",
  "ja-JP",
];
const HOUSEHOLD = "__household__";

export function formatDateStyle(d: Date, locale: string, style: DateStyle): string {
  if (style === "iso") return d.toISOString().slice(0, 10);
  return new Intl.DateTimeFormat(locale, { dateStyle: style, timeZone: "UTC" }).format(d);
}

export function ProfileSection() {
  const { data: ws } = useWorkspace();
  const mode = useMode();
  const { settings } = useSettings();
  const save = useUpdateSettings();
  const prefs = usePrefs();
  const hh = ws?.doc.household;
  const locale = settings.locale ?? hh?.locale ?? navigator.language;
  const currency = settings.displayCurrency ?? hh?.currency ?? "USD";
  const sample = new Date(Date.UTC(2031, 3, 6));
  const plans = ws?.doc.plans ?? [];
  return (
    <>
      <SectionIntro title="Profile & locale">
        How numbers, money and dates look. Your household’s own currency and country live in{" "}
        <Link to="/finances" className="text-accent underline underline-offset-2">
          Current finances
        </Link>
        .
      </SectionIntro>
      <div className="flex items-center gap-4 rounded-[var(--radius-card)] border border-border bg-surface-2/60 px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="eyebrow">Preview</div>
          <div className="num mt-1 flex flex-wrap gap-x-6 gap-y-1 text-[15px] font-semibold text-ink">
            <span>{formatMoney(1234567.89, { locale, currency, decimals: 2, reveal: true })}</span>
            <span>{formatMoney(1234567, { locale, currency, compact: true, reveal: true })}</span>
            <span>{formatPercent(0.0425, locale, 2)}</span>
            <span>{formatDateStyle(sample, locale, prefs.dateStyle)}</span>
          </div>
        </div>
      </div>
      <SettingsGroup title="Money and numbers">
        <SettingRow
          label="Display currency"
          where="server"
          hint={`Labels only: amounts are not converted. Your household plans in ${hh?.currency ?? "its own currency"}.`}
        >
          <Select
            aria-label="Display currency"
            className="w-[240px]"
            value={settings.displayCurrency ?? HOUSEHOLD}
            onValueChange={(v) => save.mutate({ displayCurrency: v === HOUSEHOLD ? null : v })}
            options={[
              { value: HOUSEHOLD, label: `Household currency (${hh?.currency ?? "—"})` },
              ...CURRENCIES.filter((c) => c !== hh?.currency).map((c) => ({
                value: c,
                label: `${c} · ${currencySymbol({ locale, currency: c })}`,
              })),
            ]}
          />
        </SettingRow>
        <SettingRow
          label="Number format"
          where="server"
          hint="Grouping, decimal mark and currency position."
        >
          <Select
            aria-label="Number format"
            className="w-[240px]"
            value={settings.locale ?? HOUSEHOLD}
            onValueChange={(v) => save.mutate({ locale: v === HOUSEHOLD ? null : v })}
            options={[
              { value: HOUSEHOLD, label: `Household default (${hh?.locale ?? "—"})` },
              ...LOCALES.map((l) => ({
                value: l,
                label: `${l} · ${new Intl.NumberFormat(l, { minimumFractionDigits: 2 }).format(1234.5)}`,
              })),
            ]}
          />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="Dates and tax years">
        <SettingRow label="Date style" where="device">
          <Select<DateStyle>
            aria-label="Date style"
            className="w-[240px]"
            value={prefs.dateStyle}
            onValueChange={(dateStyle) => prefs.set({ dateStyle })}
            options={(["medium", "short", "iso"] as const).map((s) => ({
              value: s,
              label: formatDateStyle(sample, locale, s),
              hint: s === "iso" ? "ISO 8601" : s === "short" ? "Short" : "Medium",
            }))}
          />
        </SettingRow>
        <SettingRow
          label="Tax-year labels"
          where="device"
          hint="How years are labelled in tables. Each plan’s own year alignment (calendar or fiscal) still decides the maths."
        >
          <Select<TaxYearConvention>
            aria-label="Tax-year labels"
            className="w-[240px]"
            value={prefs.taxYear}
            onValueChange={(taxYear) => prefs.set({ taxYear })}
            options={[
              { value: "auto", label: "Follow each plan", hint: "Recommended" },
              { value: "calendar", label: "Calendar year (2031)" },
              { value: "uk-april", label: "UK tax year (2031/32)", hint: "6 April to 5 April" },
              { value: "au-july", label: "Australian (2031–32)", hint: "1 July to 30 June" },
              { value: "nz-april", label: "New Zealand (2031–32)", hint: "1 April to 31 March" },
            ]}
          />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="Plans">
        <SettingRow
          label="Default plan"
          where="server"
          hint="Opened first on a new device. The plan switcher in the top bar changes the active plan at any time."
        >
          <Select
            aria-label="Default plan"
            className="w-[240px]"
            value={settings.defaultPlanId ?? HOUSEHOLD}
            onValueChange={(v) => save.mutate({ defaultPlanId: v === HOUSEHOLD ? null : v })}
            options={[
              { value: HOUSEHOLD, label: "The main plan" },
              ...plans.map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
        </SettingRow>
      </SettingsGroup>
      {/* Hosted mode has its own Security screen (password, two-factor, sessions). */}
      {mode === "cloud" ? null : <SecurityGroup />}
    </>
  );
}
