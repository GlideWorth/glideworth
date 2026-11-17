import {
  ENGINE_VERSION,
  IMPLEMENTED_JURISDICTIONS,
  MARKET_DATASETS,
  SCHEMA_VERSION,
} from "@glideworth/core";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { GlideworthMark } from "../../components/layout/logo";
import { Badge } from "../../components/ui/badge";
import { api } from "../../lib/api";
import { usePrefs } from "../../stores/prefs";
import { SectionIntro, SettingRow, SettingsGroup } from "./settings-ui";

const LEVEL: Record<string, string> = {
  national: "National",
  state: "State / province",
  local: "Local",
  payroll: "Payroll",
  synthetic: "Custom",
};

export function AboutSection() {
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, retry: false });
  const setPrefs = usePrefs((s) => s.set);
  const server = health.data;
  const mismatch =
    server && (server.engineVersion !== ENGINE_VERSION || server.schemaVersion !== SCHEMA_VERSION);
  return (
    <>
      <SectionIntro title="About Glideworth" />
      <div className="flex items-center gap-4 rounded-[var(--radius-card)] border border-border bg-surface px-5 py-4 shadow-card">
        <GlideworthMark className="size-11" />
        <div>
          <div className="display text-[20px] font-semibold">Glideworth</div>
          <p className="text-[12.5px] text-ink-2">Life and retirement planning.</p>
        </div>
      </div>
      <SettingsGroup title="Versions">
        <SettingRow
          label="Engine (this browser)"
          hint="Runs projections and Monte Carlo in background workers here."
        >
          <code className="num font-mono text-[12.5px]">{ENGINE_VERSION}</code>
        </SettingRow>
        <SettingRow label="Engine (server)" hint="Used by the REST API, MCP and async jobs.">
          {server ? (
            <code className="num font-mono text-[12.5px]">{server.engineVersion}</code>
          ) : (
            <Badge tone="ochre">{health.isLoading ? "Checking…" : "Unreachable"}</Badge>
          )}
        </SettingRow>
        <SettingRow
          label="Data schema"
          hint="Every backup records its schema version; older ones are upgraded on import."
        >
          <code className="num font-mono text-[12.5px]">
            v{SCHEMA_VERSION}
            {server && server.schemaVersion !== SCHEMA_VERSION
              ? ` (server v${server.schemaVersion})`
              : ""}
          </code>
        </SettingRow>
        {mismatch ? (
          <p className="px-5 py-3 text-[12.5px] text-ochre">
            The browser and server versions differ. Reload the page after updating the server.
          </p>
        ) : null}
        <SettingRow label="Guided tour" hint="A one-minute tour of the main areas.">
          <button
            type="button"
            className="text-[12.5px] font-medium text-accent underline underline-offset-2"
            onClick={() => setPrefs({ tour: "welcome" })}
          >
            Take the tour again
          </button>
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup
        title="Tax data"
        description="The tax years each jurisdiction implements, with official sources."
      >
        <ul>
          {IMPLEMENTED_JURISDICTIONS.map((j) => {
            const years = [...new Set((j.sources ?? []).map((s) => s.taxYear))];
            return (
              <li key={j.id} className="border-b border-border px-5 py-3 last:border-b-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-semibold text-ink">{j.label}</span>
                  <Badge>{LEVEL[j.level] ?? j.level}</Badge>
                  {j.country ? <Badge>{j.country}</Badge> : null}
                  {years.length ? (
                    <span className="text-[12px] text-ink-3">Tax years {years.join(", ")}</span>
                  ) : (
                    <span className="text-[12px] text-ink-3">Your own rates</span>
                  )}
                </div>
                {(j.sources ?? []).length ? (
                  <ul className="mt-1 flex flex-col gap-0.5">
                    {dedupe(j.sources!)
                      .slice(0, 6)
                      .map((s) => (
                        <li key={`${s.taxYear}-${s.url}`} className="text-[12px] text-ink-2">
                          <a
                            href={s.url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-accent underline-offset-2 hover:underline"
                          >
                            {hostOf(s.url)} <ExternalLink className="size-3" aria-hidden />
                            <span className="sr-only">(opens in a new tab)</span>
                          </a>{" "}
                          <span className="text-ink-3">
                            {s.taxYear}
                            {s.note ? ` · ${s.note}` : ""}
                          </span>
                        </li>
                      ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      </SettingsGroup>
      <SettingsGroup
        title="Historical market data"
        description="Used by historical and bootstrap simulations."
      >
        <ul>
          {Object.entries(MARKET_DATASETS).map(([id, ds]) => (
            <li key={id} className="border-b border-border px-5 py-3 last:border-b-0">
              <div className="text-[13px] font-semibold text-ink">{ds.label}</div>
              <p className="mt-0.5 text-[12px] text-ink-2">{ds.source}</p>
              <p className="text-[11.5px] text-ink-3">Licence: {ds.licence}</p>
              <p className="text-[11.5px] text-ink-3">{ds.attribution}</p>
            </li>
          ))}
        </ul>
      </SettingsGroup>
    </>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function dedupe<T extends { url: string; taxYear: string }>(xs: T[]): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = `${x.taxYear}|${x.url}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
