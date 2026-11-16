import { Monitor, Moon, Sun } from "lucide-react";
import { useChartPrefs } from "../../components/charts/chart-prefs";
import { Segmented } from "../../components/ui/segmented";
import { Switch } from "../../components/ui/switch";
import { cn } from "../../lib/cn";
import { useSettings, useUpdateSettings } from "../../lib/settings";
import { usePrefs } from "../../stores/prefs";
import { type ThemePref, useUi } from "../../stores/ui";
import { SectionIntro, SettingRow, SettingsGroup } from "./settings-ui";

export function AppearanceSection() {
  const ui = useUi();
  const prefs = usePrefs();
  const patterns = useChartPrefs((s) => s.patterns);
  const setPatterns = useChartPrefs((s) => s.setPatterns);
  const { settings } = useSettings();
  const save = useUpdateSettings();
  const setTheme = (theme: ThemePref) => {
    ui.setTheme(theme);
    save.mutate({ theme });
  };
  return (
    <>
      <SectionIntro title="Appearance">
        How Glideworth looks and moves. Light and dark both meet WCAG AA contrast.
      </SectionIntro>
      <SettingsGroup title="Theme">
        <div
          className="grid grid-cols-3 gap-2 px-5 py-4 sm:gap-3"
          role="radiogroup"
          aria-label="Theme"
        >
          {(
            [
              { id: "system", label: "Match device", icon: Monitor },
              { id: "light", label: "Light", icon: Sun },
              { id: "dark", label: "Dark", icon: Moon },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={ui.theme === t.id}
              onClick={() => setTheme(t.id)}
              className={cn(
                "flex flex-col gap-2 rounded-xl border p-2 text-left transition-colors",
                ui.theme === t.id
                  ? "border-accent ring-1 ring-accent"
                  : "border-border hover:border-border-strong",
              )}
            >
              <ThemeSwatch kind={t.id} />
              <span className="flex items-center gap-1.5 px-1 text-[12.5px] font-medium">
                <t.icon className="size-3.5 text-ink-3" aria-hidden /> {t.label}
              </span>
            </button>
          ))}
        </div>
        <SettingRow
          label="Density"
          where="device"
          hint="Compact fits more on screen; comfortable is easier to scan."
        >
          <Segmented
            aria-label="Density"
            value={ui.density}
            onChange={ui.setDensity}
            options={[
              { value: "comfortable", label: "Comfortable" },
              { value: "compact", label: "Compact" },
            ]}
          />
        </SettingRow>
        <SettingRow
          label="Show amounts in"
          where="server"
          hint="The starting point for every chart and table. Press B anywhere to flip."
        >
          <Segmented
            aria-label="Show amounts in"
            value={ui.basis}
            onChange={(b) => {
              ui.setBasis(b);
              save.mutate({ valueBasis: b });
            }}
            options={[
              { value: "real", label: "Today's money" },
              { value: "nominal", label: "Future money" },
            ]}
          />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="Motion and transparency">
        <Toggle
          label="Reduce motion"
          where="server"
          hint="Turns off animations and transitions everywhere. Your device’s own setting is always respected too."
          checked={ui.reduceMotion || settings.reduceMotion}
          onChange={(v) => {
            ui.setReduceMotion(v);
            save.mutate({ reduceMotion: v });
          }}
        />
        <Toggle
          label="Reduce transparency"
          where="device"
          hint="Solid backgrounds instead of translucent, blurred bars."
          checked={ui.reduceTransparency}
          onChange={ui.setReduceTransparency}
        />
      </SettingsGroup>
      <SettingsGroup title="Charts and numbers">
        <Toggle
          label="Animate charts"
          where="device"
          hint="Charts ease in when they first draw."
          checked={prefs.chartAnimation}
          onChange={(chartAnimation) => prefs.set({ chartAnimation })}
        />
        <Toggle
          label="Smooth curves"
          where="device"
          hint="Gently rounded lines. Off draws straight segments between yearly points, which is more literal."
          checked={prefs.smoothCurves}
          onChange={(smoothCurves) => prefs.set({ smoothCurves })}
        />
        <Toggle
          label="Abbreviate large numbers"
          where="server"
          hint="1.2M and 340K in charts and summaries. Off shows every digit."
          checked={settings.compactNumbers}
          onChange={(compactNumbers) => save.mutate({ compactNumbers })}
        />
        <Toggle
          label="Patterns for colour-blind readers"
          where="device"
          hint="Adds hatching and dots to filled areas so series never rely on colour alone. Also helps in print."
          checked={patterns}
          onChange={setPatterns}
        />
      </SettingsGroup>
    </>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
  where,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  where?: "server" | "device";
}) {
  const id = `t-${label.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <SettingRow label={label} hint={hint} where={where} htmlFor={id}>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </SettingRow>
  );
}

/** A miniature of the app in each theme (pure decoration). */
function ThemeSwatch({ kind }: { kind: ThemePref }) {
  const half = (theme: "light" | "dark") => (
    <div data-theme={theme} className="flex h-full flex-1 gap-1 bg-bg p-1.5">
      <div className="flex w-1/4 flex-col gap-1">
        <span className="h-1.5 rounded-sm bg-accent" />
        <span className="h-1 rounded-sm bg-surface-3" />
        <span className="h-1 rounded-sm bg-surface-3" />
      </div>
      <div className="flex flex-1 flex-col gap-1 rounded-sm bg-surface p-1">
        <span className="h-1.5 w-2/3 rounded-sm bg-ink/70" />
        <span className="mt-auto h-3 rounded-sm bg-accent-soft" />
      </div>
    </div>
  );
  return (
    <div aria-hidden className="flex h-12 overflow-hidden rounded-lg border border-border sm:h-16">
      {kind === "system" ? (
        <>
          {half("light")}
          {half("dark")}
        </>
      ) : (
        half(kind)
      )}
    </div>
  );
}
