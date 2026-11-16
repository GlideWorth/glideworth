import { RotateCcw } from "lucide-react";
import { Button } from "../../components/ui/button";
import { NumberInput, PercentInput } from "../../components/ui/number-input";
import { Segmented } from "../../components/ui/segmented";
import { Switch } from "../../components/ui/switch";
import { formatPercent } from "../../lib/format";
import { useSettings, useUpdateSettings } from "../../lib/settings";
import { useFormat } from "../../lib/workspace";
import {
  DEFAULT_MC,
  DEFAULT_PLAN_DEFAULTS,
  DEFAULT_SUCCESS_BANDS,
  usePrefs,
} from "../../stores/prefs";
import { SectionIntro, SettingRow, SettingsGroup } from "./settings-ui";

const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;

export function PlanningSection() {
  const prefs = usePrefs();
  const { settings } = useSettings();
  const save = useUpdateSettings();
  const f = useFormat();
  const pd = prefs.planDefaults;
  const mc = prefs.monteCarlo;
  const bands = prefs.successBands;
  const setPd = (patch: Partial<typeof pd>) => prefs.set({ planDefaults: { ...pd, ...patch } });
  const setMc = (patch: Partial<typeof mc>) => prefs.set({ monteCarlo: { ...mc, ...patch } });
  const autoWorkers = Math.max(1, Math.min(6, cores - 1));
  return (
    <>
      <SectionIntro title="Planning defaults">
        Starting points for new plans and simulations, and how a few headline numbers are defined.
        Existing plans keep their own settings.
      </SectionIntro>
      <SettingsGroup
        title="New plans"
        description="Used by guided setup and as a reference when you create plans."
        actions={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => prefs.set({ planDefaults: DEFAULT_PLAN_DEFAULTS })}
          >
            <RotateCcw /> Reset
          </Button>
        }
      >
        <SettingRow
          label="Inflation"
          where="device"
          hint="Long-run average. Most central banks target about 2%."
        >
          <PercentInput
            className="w-[130px]"
            aria-label="Inflation"
            value={pd.inflation}
            onValueChange={(v) => setPd({ inflation: v ?? pd.inflation })}
          />
        </SettingRow>
        <SettingRow
          label="Stock returns"
          where="device"
          hint="Nominal price growth per year, before dividends."
        >
          <PercentInput
            className="w-[130px]"
            aria-label="Stock returns"
            value={pd.stockReturn}
            onValueChange={(v) => setPd({ stockReturn: v ?? pd.stockReturn })}
          />
        </SettingRow>
        <SettingRow label="Bond returns" where="device">
          <PercentInput
            className="w-[130px]"
            aria-label="Bond returns"
            value={pd.bondReturn}
            onValueChange={(v) => setPd({ bondReturn: v ?? pd.bondReturn })}
          />
        </SettingRow>
        <SettingRow
          label="Plan until age"
          where="device"
          hint="Life expectancy used for new people."
        >
          <NumberInput
            className="w-[130px]"
            aria-label="Plan until age"
            decimals={0}
            suffix="yrs"
            value={pd.lifeExpectancy}
            onValueChange={(v) => setPd({ lifeExpectancy: Math.round(v ?? pd.lifeExpectancy) })}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup
        title="What counts as spending"
        description="Used by the Spending metric, withdrawal rates and FI targets."
      >
        {(
          [
            ["includeMortgage", "Mortgage interest", "Interest is a cost of living in the home."],
            [
              "includeMortgagePrincipal",
              "Mortgage principal",
              "Principal builds equity; most people leave it out.",
            ],
            [
              "includeConsumerDebtPrincipal",
              "Other debt principal",
              "Card and loan repayments beyond interest.",
            ],
            ["includeTaxes", "Taxes", "Count income tax as spending."],
          ] as const
        ).map(([key, label, hint]) => (
          <SettingRow key={key} label={label} hint={hint} where="server" htmlFor={`sp-${key}`}>
            <Switch
              id={`sp-${key}`}
              checked={settings.spending[key]}
              onCheckedChange={(v) => save.mutate({ spending: { [key]: v } })}
            />
          </SettingRow>
        ))}
      </SettingsGroup>

      <SettingsGroup
        title="Effective tax rate"
        description="Which taxes the effective rate includes."
      >
        {(
          [
            ["includePayroll", "Payroll taxes", "National Insurance, FICA and similar."],
            ["includeLocal", "State and local income taxes", ""],
            ["includeProperty", "Property taxes", ""],
          ] as const
        ).map(([key, label, hint]) => (
          <SettingRow
            key={key}
            label={label}
            hint={hint || undefined}
            where="server"
            htmlFor={`etr-${key}`}
          >
            <Switch
              id={`etr-${key}`}
              checked={settings.effectiveTaxRate[key]}
              onCheckedChange={(v) => save.mutate({ effectiveTaxRate: { [key]: v } })}
            />
          </SettingRow>
        ))}
      </SettingsGroup>

      <SettingsGroup
        title="Chance of success"
        actions={
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              prefs.set({ monteCarlo: DEFAULT_MC, successBands: DEFAULT_SUCCESS_BANDS })
            }
          >
            <RotateCcw /> Reset
          </Button>
        }
      >
        <SettingRow
          label="Background workers"
          where="device"
          hint={`Simulations run in parallel on this device. Automatic uses ${autoWorkers} of ${cores} cores.`}
        >
          <Segmented
            aria-label="Background workers"
            size="sm"
            value={String(mc.workers)}
            onChange={(v) => setMc({ workers: Number(v) })}
            options={[
              { value: "0", label: "Auto" },
              ...[1, 2, 4, 6, 8]
                .filter((n) => n <= Math.max(2, cores))
                .map((n) => ({ value: String(n), label: String(n) })),
            ]}
          />
        </SettingRow>
        <SettingRow
          label="Trials for new plans"
          where="device"
          hint="More trials, steadier numbers, longer runs."
        >
          <Segmented
            aria-label="Trials"
            size="sm"
            value={String(mc.trials)}
            onChange={(v) => setMc({ trials: Number(v) })}
            options={[500, 1000, 2000, 5000].map((n) => ({
              value: String(n),
              label: new Intl.NumberFormat(f.locale).format(n),
            }))}
          />
        </SettingRow>
        <SettingRow
          label="Random seed"
          where="device"
          hint={
            mc.seed === null
              ? "A fresh seed each run."
              : "Fixed: the same plan gives exactly the same result every time."
          }
        >
          <div className="flex items-center gap-2">
            <Switch
              aria-label="Use a fixed seed"
              checked={mc.seed !== null}
              onCheckedChange={(on) => setMc({ seed: on ? 424242 : null })}
            />
            {mc.seed !== null ? (
              <NumberInput
                className="w-[120px]"
                aria-label="Seed"
                decimals={0}
                value={mc.seed}
                onValueChange={(v) => setMc({ seed: Math.max(0, Math.floor(v ?? 0)) })}
              />
            ) : null}
          </div>
        </SettingRow>
        <SettingRow
          label="Success bands"
          where="device"
          hint="Where a chance of success turns from on track to watch to at risk."
        >
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-[12px] text-ink-2">
              Watch below
              <PercentInput
                className="w-[96px]"
                aria-label="On-track threshold"
                decimals={0}
                value={bands.good}
                onValueChange={(v) =>
                  v !== null &&
                  prefs.set({
                    successBands: { ...bands, good: Math.min(1, Math.max(bands.fair + 0.01, v)) },
                  })
                }
              />
              at risk below
              <PercentInput
                className="w-[96px]"
                aria-label="At-risk threshold"
                decimals={0}
                value={bands.fair}
                onValueChange={(v) =>
                  v !== null &&
                  prefs.set({
                    successBands: { ...bands, fair: Math.max(0, Math.min(bands.good - 0.01, v)) },
                  })
                }
              />
            </div>
            <div className="flex h-2 overflow-hidden rounded-full" aria-hidden>
              <span className="bg-negative" style={{ width: `${bands.fair * 100}%` }} />
              <span
                className="bg-warning"
                style={{ width: `${(bands.good - bands.fair) * 100}%` }}
              />
              <span className="flex-1 bg-positive" />
            </div>
            <div className="flex justify-between text-[11px] text-ink-3">
              <span>{formatPercent(0, f.locale, 0)}</span>
              <span>{formatPercent(1, f.locale, 0)}</span>
            </div>
          </div>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Progress">
        <SettingRow
          label="Automatic snapshots"
          where="server"
          hint="When balances change, record that day’s net worth in Progress (at most one a day)."
          htmlFor="auto-snap"
        >
          <Switch
            id="auto-snap"
            checked={settings.autoProgressSnapshots}
            onCheckedChange={(v) => save.mutate({ autoProgressSnapshots: v })}
          />
        </SettingRow>
      </SettingsGroup>
    </>
  );
}
