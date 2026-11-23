import {
  MARKET_DATASETS,
  type MarketDatasetId,
  type MarketPath,
  type MonteCarloResult,
  MonteCarloSettings,
  type ProjectionResult,
} from "@glideworth/core";
import { Dices, Loader2, Play, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SuccessGauge } from "../../components/charts/mini";
import { outcomeColor } from "../../components/charts/palette";
import { SeriesChart } from "../../components/charts/series-chart";
import {
  ChartLoading,
  EmptyState,
  ErrorState,
  ExampleBadge,
  NotAvailable,
  notImplementedInfo,
} from "../../components/charts/states";
import { Page } from "../../components/layout/app-shell";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { Field, Input } from "../../components/ui/input";
import { Segmented } from "../../components/ui/segmented";
import { Select } from "../../components/ui/select";
import { useMode } from "../../lib/auth";
import { cn } from "../../lib/cn";
import { isDemo } from "../../lib/demo";
import { total } from "../../lib/money";
import { periodShortLabel } from "../../lib/period";
import { useResolvedTheme } from "../../lib/theme";
import { useFormat } from "../../lib/workspace";
import { successTone, usePrefs } from "../../stores/prefs";
import { runSimulation } from "../../workers/sim-client";
import { foreignCurrencies } from "../currency/fx";
import { cancelDemoChanceRun, useRememberedChance } from "../demo/demo-chance";
import { exampleMonteCarlo, exampleTrialMarket } from "../results/fixtures";
import { useAnalysis } from "../results/use-analysis";
import { showDemoRunLoading, showNoRunYet } from "./chance-display";
import {
  availableMetrics,
  FAN_LABEL,
  FailureHistogram,
  FanChart,
  type FanMetric,
  MilestoneTimingView,
  SequenceRiskView,
  TrialTable,
} from "./chance-charts";
import { FxRiskSettings } from "./fx-risk";
import { McCancelled, poolSize, runChanceOfSuccess, runTrialDetail } from "./mc-pool";
import { useMcStore } from "./mc-store";
import { MethodAdvanced, SAMPLING_METHOD_OPTIONS } from "./method-advanced";

type Status = "idle" | "running" | "done" | "error" | "cancelled";

function pctInput(v: number) {
  return Math.round(v * 10000) / 100;
}

const DATASET_NOTE: Record<MarketDatasetId, string> = {
  "us-1928": "Default. Calendar-year US stocks, 10-year Treasuries, T-bills and CPI.",
  "uk-1983":
    "UK inflation, gilts and Bank Rate, with US shares in sterling (no open UK share history).",
};

function DatasetChooser({
  value,
  set,
}: {
  value: MonteCarloSettings;
  set: (p: Partial<MonteCarloSettings>) => void;
}) {
  const f = useFormat();
  const ds = MARKET_DATASETS[value.dataset as MarketDatasetId];
  const currencyMismatch = ds && ds.currency !== f.currency;
  return (
    <div className="flex flex-col gap-2">
      <Field label="Historical data set">
        {(id) => (
          <Select
            id={id}
            value={value.dataset}
            onValueChange={(d) => set({ dataset: d })}
            options={(Object.keys(MARKET_DATASETS) as MarketDatasetId[]).map((k) => ({
              value: k,
              label: `${k.startsWith("uk") ? "UK" : "US"} ${MARKET_DATASETS[k].firstYear}–${MARKET_DATASETS[k].lastYear}`,
            }))}
          />
        )}
      </Field>
      {ds ? (
        <div className="flex flex-col gap-1.5 rounded-md bg-surface-2 p-2.5 text-[11.5px] leading-relaxed text-ink-2">
          <div className="font-medium text-ink">{ds.label}</div>
          <div>{DATASET_NOTE[ds.id]}</div>
          <div>
            <span className="text-ink-3">Source: </span>
            {ds.source}
          </div>
          <div>
            <span className="text-ink-3">Licence: </span>
            {ds.licence}
          </div>
          <div>{ds.limits}</div>
          <div className="text-ink-3">{ds.attribution}</div>
          {ds.id === "uk-1983" ? (
            <div className="flex flex-wrap gap-1.5 pt-0.5">
              <Badge tone="ochre">Starts in {ds.firstYear}</Badge>
              <Badge tone="ochre">US shares</Badge>
            </div>
          ) : null}
          {currencyMismatch ? (
            <div className="text-warning">
              Returns are in {ds.currency}; your household currency is {f.currency}. Real returns
              are used, so results are still meaningful, but they reflect{" "}
              {ds.region === "GB" ? "UK" : "US"} history.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const NO_CURRENCIES: string[] = [];

function SettingsPanel({
  value,
  onChange,
  disabled,
  currencies = NO_CURRENCIES,
  base = "",
}: {
  value: MonteCarloSettings;
  onChange: (s: MonteCarloSettings) => void;
  disabled: boolean;
  /** Foreign currencies held (offers exchange-rate risk) and the base currency. */
  currencies?: string[];
  base?: string;
}) {
  const f = useFormat();
  const set = (patch: Partial<MonteCarloSettings>) => onChange({ ...value, ...patch });
  const dist = value.distributions;
  const setDist = (k: "stocks" | "bonds" | "inflation", field: "mean" | "stdDev", pct: number) =>
    set({ distributions: { ...dist, [k]: { ...dist[k], [field]: pct / 100 } } });
  return (
    <fieldset disabled={disabled} className="flex flex-col gap-3">
      <MethodAdvanced method={value.method}>
        <Field label="Method">
          {(id) => (
            <Select
              id={id}
              value={value.method}
              onValueChange={(m) => set({ method: m })}
              options={SAMPLING_METHOD_OPTIONS}
            />
          )}
        </Field>
        {value.method === "block-bootstrap" ? (
          <Field label="Block length (years)">
            {(id) => (
              <Input
                id={id}
                type="number"
                min={1}
                max={30}
                value={value.blockLength}
                onChange={(e) =>
                  set({ blockLength: Math.max(1, Math.min(30, Number(e.target.value) || 1)) })
                }
              />
            )}
          </Field>
        ) : null}
      </MethodAdvanced>
      {value.method !== "normal" ? <DatasetChooser value={value} set={set} /> : null}
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Trials"
          hint={value.method === "historical-sequential" ? "Fixed by the data" : "100–10,000"}
        >
          {(id) => (
            <Input
              id={id}
              type="number"
              min={10}
              max={10000}
              step={100}
              disabled={value.method === "historical-sequential"}
              value={value.trials}
              onChange={(e) =>
                set({ trials: Math.max(10, Math.min(10000, Number(e.target.value) || 10)) })
              }
            />
          )}
        </Field>
        <Field label="Seed" hint={value.seed === null ? "New each run" : "Reproducible"}>
          {(id) => (
            <Input
              id={id}
              type="number"
              placeholder="random"
              value={value.seed ?? ""}
              onChange={(e) =>
                set({
                  seed:
                    e.target.value === "" ? null : Math.max(0, Math.floor(Number(e.target.value))),
                })
              }
            />
          )}
        </Field>
      </div>
      {value.method === "normal" ? (
        <div className="flex flex-col gap-2 rounded-md bg-surface-2 p-2.5">
          <div className="eyebrow">Distributions (% per year)</div>
          {(["stocks", "bonds", "inflation"] as const).map((k) => (
            <div key={k} className="grid grid-cols-[72px_1fr_1fr] items-center gap-2 text-[12.5px]">
              <span className="capitalize">{k}</span>
              <Input
                aria-label={`${k} mean`}
                type="number"
                step={0.1}
                value={pctInput(dist[k].mean)}
                onChange={(e) => setDist(k, "mean", Number(e.target.value))}
              />
              <Input
                aria-label={`${k} standard deviation`}
                type="number"
                step={0.1}
                min={0}
                value={pctInput(dist[k].stdDev)}
                onChange={(e) => setDist(k, "stdDev", Number(e.target.value))}
              />
            </div>
          ))}
          <div className="grid grid-cols-[72px_1fr_1fr] text-[11px] text-ink-3">
            <span />
            <span>mean</span>
            <span>std dev</span>
          </div>
          <Field label="Shape of returns" hint="Log-normal can never lose more than 100%">
            {() => (
              <Segmented
                aria-label="Distribution shape"
                size="sm"
                value={value.distributionShape ?? "normal"}
                onChange={(shape) => set({ distributionShape: shape })}
                options={[
                  { value: "normal", label: "Normal" },
                  { value: "lognormal", label: "Log-normal" },
                ]}
              />
            )}
          </Field>
          <label className="flex items-center gap-2 text-[12.5px]">
            <input
              type="checkbox"
              checked={!!value.fatTails}
              onChange={(e) =>
                set({ fatTails: e.target.checked ? { degreesOfFreedom: 5 } : (undefined as never) })
              }
              className="accent-[var(--accent)]"
            />
            Fat tails (Student-t)
          </label>
          {value.fatTails ? (
            <Field
              label="Degrees of freedom"
              hint="Lower = fatter tails (2.5 to 1,000); standard deviation is preserved"
            >
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min={2.5}
                  max={1000}
                  step={0.5}
                  value={value.fatTails?.degreesOfFreedom ?? 5}
                  onChange={(e) =>
                    set({
                      fatTails: {
                        degreesOfFreedom: Math.max(
                          2.5,
                          Math.min(1000, Number(e.target.value) || 5),
                        ),
                      },
                    })
                  }
                />
              )}
            </Field>
          ) : null}
        </div>
      ) : null}
      <FxRiskSettings value={value} set={set} currencies={currencies} base={base} />
      <Field
        label="Sequence-risk window (years)"
        hint="Early years used for the sequence-of-returns view"
      >
        {(id) => (
          <Input
            id={id}
            type="number"
            min={1}
            max={40}
            value={value.sequenceRiskYears ?? 10}
            onChange={(e) =>
              set({
                sequenceRiskYears: Math.max(
                  1,
                  Math.min(40, Math.floor(Number(e.target.value)) || 10),
                ),
              })
            }
          />
        )}
      </Field>
      <Field label="Success means">
        {() => (
          <Segmented
            aria-label="Success definition"
            size="sm"
            value={value.success.kind}
            onChange={(k) =>
              set({
                success:
                  k === "all-funded" ? { kind: "all-funded" } : { kind: "liquid-floor", floor: 0 },
              })
            }
            options={[
              { value: "all-funded", label: "Every year funded" },
              { value: "liquid-floor", label: "Savings above a floor" },
            ]}
          />
        )}
      </Field>
      {value.success.kind === "liquid-floor" ? (
        <Field label={`Liquid savings never below (${f.currency}, today's money)`}>
          {(id) => (
            <Input
              id={id}
              type="number"
              min={0}
              step={1000}
              value={value.success.kind === "liquid-floor" ? value.success.floor : 0}
              onChange={(e) =>
                set({
                  success: { kind: "liquid-floor", floor: Math.max(0, Number(e.target.value)) },
                })
              }
            />
          )}
        </Field>
      ) : null}
    </fieldset>
  );
}

export function TrialExplorer({
  mc,
  det,
  input,
  settings,
  example,
  trial,
  onTrial,
  filter,
}: {
  mc: MonteCarloResult;
  det: ProjectionResult;
  input: Parameters<typeof runTrialDetail>[0];
  settings: MonteCarloSettings;
  example: boolean;
  trial: number | null;
  onTrial: (t: number) => void;
  filter: string | null;
}) {
  const f = useFormat();
  const ranked = useMemo(
    () =>
      [...mc.trialSummaries]
        .filter((t) => !filter || t.outcomeCategoryId === filter)
        .sort((a, b) => a.endNetWorthReal - b.endNetWorthReal),
    [mc, filter],
  );
  const [detail, setDetail] = useState<{
    trial: number;
    market: MarketPath;
    result: ProjectionResult;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const rep = mc.representativeTrials;
  const pick = (label: string) => {
    if (!ranked.length) return;
    const n = ranked.length - 1;
    const idx =
      label === "worst"
        ? 0
        : label === "p10"
          ? Math.round(n * 0.1)
          : label === "median"
            ? Math.round(n / 2)
            : label === "p90"
              ? Math.round(n * 0.9)
              : n;
    const fromRep =
      !filter && rep ? (rep as Record<string, { trial: number }>)[label]?.trial : undefined;
    onTrial(fromRep ?? ranked[idx]!.trial);
  };
  useEffect(() => {
    if (trial === null) return;
    let live = true;
    setLoading(true);
    setErr(null);
    const run = example
      ? (async () => {
          const market = exampleTrialMarket(det, trial, mc.seed ?? 424242);
          const { result } = await runSimulation({
            ...input,
            options: { ...input.options, market, strict: false },
          });
          return { market, result };
        })()
      : runTrialDetail(input, settings, trial);
    run
      .then((r) => live && setDetail({ trial, ...r }))
      .catch((e) => live && setErr(e))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [trial, example, det, input, settings, mc.seed]);

  const rank = trial === null ? -1 : ranked.findIndex((t) => t.trial === trial);
  const summary = trial === null ? undefined : mc.trialSummaries.find((t) => t.trial === trial);
  const years = mc.years ?? mc.percentiles[0]?.years ?? [];
  const path = detail
    ? years.map((y) => {
        const p = detail.result.periods.find((x) => x.year === y);
        return p ? total(p, "netWorth", "real") : 0;
      })
    : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          aria-label="Representative trial"
          size="sm"
          value={
            trial === null
              ? ""
              : (["worst", "p10", "median", "p90", "best"].find(
                  (l) => rep && (rep as Record<string, { trial: number }>)[l]?.trial === trial,
                ) ?? "")
          }
          onChange={pick}
          options={[
            { value: "worst", label: "Lowest" },
            { value: "p10", label: "10th" },
            { value: "median", label: "Median" },
            { value: "p90", label: "90th" },
            { value: "best", label: "Highest" },
          ]}
        />
        <input
          type="range"
          min={0}
          max={Math.max(0, ranked.length - 1)}
          value={Math.max(0, rank)}
          aria-label="Scrub through trials ranked by ending net worth, lowest first"
          onChange={(e) => onTrial(ranked[Number(e.target.value)]!.trial)}
          className="min-w-[140px] flex-1 accent-[var(--ochre)]"
        />
        <span className="num text-[12px] text-ink-2">
          {rank >= 0 ? `rank ${rank + 1} of ${ranked.length}` : "pick a trial"}
        </span>
      </div>
      <p className="text-[12px] text-ink-3">
        Trials are ranked by what they end with, in today's money, lowest first. A trial can run
        short in one year and still end with a high net worth, for example from property, so the
        lowest one is not always the one that failed earliest. The table below lists failed trials
        first, earliest failure first.
      </p>
      {trial === null ? (
        <EmptyState title="Pick a trial to inspect">
          Choose the lowest, median or highest ending, scrub through all trials, or click a row in
          the trial table.
        </EmptyState>
      ) : null}
      {loading ? <ChartLoading label="Re-running this trial in full…" height={200} /> : null}
      {err ? (
        notImplementedInfo(err) ? (
          <NotAvailable what="Trial re-run" error={err} />
        ) : (
          <ErrorState error={err} />
        )
      ) : null}
      {detail && path && summary && !loading ? (
        <>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12.5px]">
            <span>
              Trial <span className="num font-semibold">#{detail.trial + 1}</span>
            </span>
            <span className={summary.success ? "text-positive" : "text-negative"}>
              {summary.success
                ? "Succeeded"
                : `Failed in ${summary.failureYear ?? summary.firstShortfallYear}`}
            </span>
            <span>
              Ends with{" "}
              <span className="num font-semibold">{f.money(summary.endNetWorthReal, true)}</span>{" "}
              (today's money)
            </span>
            {summary.startYear ? <span>History from {summary.startYear}</span> : null}
          </div>
          <FanChart
            mc={mc}
            det={det}
            metric="netWorth"
            basis="real"
            height={260}
            highlight={{ name: `Trial #${detail.trial + 1}`, values: path }}
          />
          <div>
            <div className="eyebrow mb-1">Sequence of returns in this trial</div>
            <SeriesChart
              labels={detail.result.periods.map((p) => periodShortLabel(p))}
              format="percent"
              locale={f.locale}
              height={200}
              ariaLabel="Stock returns and inflation each year of this trial"
              series={[
                {
                  name: "Stocks",
                  color: (t) => t.accent,
                  type: "bar",
                  values: detail.market.periods.map((m) => m.stocks),
                },
                {
                  name: "Bonds",
                  color: (t) => t.palette[2]!,
                  type: "line",
                  values: detail.market.periods.map((m) => m.bonds),
                  width: 1.5,
                },
                {
                  name: "Inflation",
                  color: (t) => t.ochre,
                  type: "line",
                  values: detail.market.periods.map((m) => m.inflation),
                  dashed: true,
                  width: 1.5,
                },
              ]}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}

export function ChanceView() {
  const { plan, input, result: det, isLoading, error: detError, basis, f, doc } = useAnalysis();
  const cloud = useMode() === "cloud";
  const theme = useResolvedTheme();
  const currencies = useMemo(
    () => (doc && plan ? foreignCurrencies(doc, [plan]) : []),
    [doc, plan],
  );
  const [settings, setSettings] = useState<MonteCarloSettings>(() => MonteCarloSettings.parse({}));
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState<unknown>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [metric, setMetric] = useState<FanMetric>("netWorth");
  const [trial, setTrial] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null);
  const stored = useRememberedChance(plan);
  const put = useMcStore((s) => s.put);
  const demoPhase = useMcStore((s) => (plan ? s.demoPhase[plan.id] : undefined));
  const mc = stored?.result;
  const example = !!stored?.example;
  const demo = isDemo();
  const emptyState = {
    hasResult: !!mc,
    status,
    projectionLoading: isLoading,
    demo,
    demoPhase,
  };
  const demoBusy =
    demo &&
    !mc &&
    !isLoading &&
    status !== "running" &&
    demoPhase !== "failed" &&
    demoPhase !== "unavailable";

  useEffect(() => {
    if (plan) setSettings(plan.monteCarlo);
  }, [plan]);

  const run = useCallback(async () => {
    if (!input || !plan) return;
    cancelDemoChanceRun();
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setStatus("running");
    setError(null);
    setProgress({ done: 0, total: settings.trials });
    try {
      const r = await runChanceOfSuccess(input, settings, {
        signal: ac.signal,
        // (i) Settings → Planning defaults → background workers (0 = automatic).
        ...(usePrefs.getState().monteCarlo.workers > 0
          ? { workers: usePrefs.getState().monteCarlo.workers }
          : {}),
        onProgress: (done, total) => setProgress({ done, total }),
      });
      put(plan.id, { result: r, planVersion: plan.version, example: false, at: Date.now() });
      setTrial(null);
      setStatus("done");
    } catch (e) {
      if (e instanceof McCancelled) setStatus("cancelled");
      else {
        setError(e);
        setStatus("error");
      }
    }
  }, [input, plan, settings, put]);

  const preview = useCallback(() => {
    if (!det || !plan) return;
    put(plan.id, {
      result: exampleMonteCarlo(det, settings),
      planVersion: plan.version,
      example: true,
      at: Date.now(),
    });
    setError(null);
    setStatus("done");
    setTrial(null);
  }, [det, plan, settings, put]);

  const cats = settings.outcomeCategories;
  const metrics = mc ? availableMetrics(mc) : [];
  const rate = mc?.successRate ?? 0;
  // (i) colour follows the success bands in Settings → Planning defaults.
  const rateColor = `var(--${successTone(rate)})`;
  const verdict =
    rate >= 0.9
      ? "Strong"
      : rate >= 0.8
        ? "Good"
        : rate >= 0.7
          ? "Fair"
          : rate >= 0.5
            ? "At risk"
            : "Unlikely";
  const pctDone = progress.total ? progress.done / progress.total : 0;

  return (
    <Page
      title="Chance of success"
      description={
        plan
          ? `How often “${plan.name}” survives across many market histories, in today's money.`
          : undefined
      }
      actions={
        <>
          {example ? <ExampleBadge /> : null}
          {mc && !example ? (
            <Badge>{`${mc.trials.toLocaleString(f.locale)} trials · ${((mc.durationMs ?? 0) / 1000).toFixed(1)} s`}</Badge>
          ) : null}
        </>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
        <Card className="self-start lg:sticky lg:top-4">
          <CardHeader eyebrow="Settings" title="Run" />
          <CardBody className="flex flex-col gap-4">
            <SettingsPanel
              value={settings}
              onChange={setSettings}
              disabled={status === "running" || demoBusy}
              currencies={currencies}
              base={doc?.household.currency ?? ""}
            />
            {status === "running" ? (
              <div className="flex flex-col gap-2" aria-live="polite">
                <div
                  className="h-2 overflow-hidden rounded-full bg-surface-2"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(pctDone * 100)}
                >
                  <div
                    className="h-full rounded-full bg-accent transition-[width]"
                    style={{ width: `${pctDone * 100}%` }}
                  />
                </div>
                <div className="flex items-center justify-between text-[12px] text-ink-2">
                  <span className="flex items-center gap-1.5">
                    <Loader2 className="size-3.5 animate-spin" />{" "}
                    {progress.done.toLocaleString(f.locale)} /{" "}
                    {progress.total.toLocaleString(f.locale)} trials
                  </span>
                  <span>{poolSize()} workers</span>
                </div>
                <Button variant="secondary" onClick={() => abort.current?.abort()}>
                  <Square /> Cancel
                </Button>
              </div>
            ) : demoBusy ? (
              <div
                className="flex items-center gap-1.5 text-[12.5px] text-ink-2"
                aria-live="polite"
              >
                <Loader2 className="size-3.5 animate-spin" /> Running the same chance of success as
                the dashboard…
              </div>
            ) : (
              <Button variant="primary" onClick={run} disabled={!input || isLoading}>
                <Play /> Run{" "}
                {settings.method === "historical-sequential"
                  ? "backtest"
                  : `${settings.trials.toLocaleString(f.locale)} trials`}
              </Button>
            )}
            {status === "cancelled" ? (
              <div className="text-[12px] text-ink-3">Run cancelled.</div>
            ) : null}
            <p className="text-[11.5px] text-ink-3">
              {cloud
                ? "Runs in background workers in this browser. Your plans are saved in your Glideworth Cloud workspace."
                : "Runs locally in background workers; your data never leaves this device."}
            </p>
          </CardBody>
        </Card>

        <div className="flex min-w-0 flex-col gap-5">
          {isLoading && !mc ? (
            <ChartLoading
              label={plan ? "Simulating in a background worker…" : "Loading your plan…"}
            />
          ) : null}
          {showDemoRunLoading(emptyState) ? (
            <ChartLoading label="Running chance of success…" />
          ) : null}
          {detError ? (
            <ErrorState error={detError} title="The plan could not be simulated" />
          ) : null}
          {status === "error" && error ? (
            notImplementedInfo(error) ? (
              <Card>
                <NotAvailable
                  what="Chance of success"
                  error={error}
                  onPreview={det ? preview : undefined}
                />
              </Card>
            ) : (
              <Card>
                <ErrorState error={error} title="The run failed" />
              </Card>
            )
          ) : null}
          {showNoRunYet(emptyState) ? (
            <Card>
              <EmptyState
                icon={<Dices className="size-5" />}
                title="No run yet"
                action={
                  <div className="flex gap-2">
                    <Button variant="primary" size="sm" onClick={run} disabled={!input}>
                      <Play /> Run now
                    </Button>
                    {det ? (
                      <Button size="sm" variant="ghost" onClick={preview}>
                        Preview with example data
                      </Button>
                    ) : null}
                  </div>
                }
              >
                Choose a method and run. Results show how many simulated futures fund every year of
                the plan.
              </EmptyState>
            </Card>
          ) : null}
          {mc ? (
            <>
              <Card>
                <CardBody className="grid items-center gap-5 md:grid-cols-[220px_minmax(0,1fr)]">
                  <div className="flex flex-col items-center">
                    <SuccessGauge
                      rate={rate}
                      label={f.percent(rate, 0)}
                      sub={verdict}
                      color={rateColor}
                      bands={cats.map((c, i) => ({
                        name: c.name,
                        share: (mc.outcomeCounts[c.id] ?? 0) / Math.max(1, mc.trials),
                        color: outcomeColor(theme, c.id, c.kind, i),
                      }))}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <div className="eyebrow mb-1">Outcomes · click to filter trials</div>
                    {cats.map((c, i) => {
                      const n = mc.outcomeCounts[c.id] ?? 0;
                      const share = n / Math.max(1, mc.trials);
                      return (
                        <button
                          key={c.id}
                          type="button"
                          aria-pressed={filter === c.id}
                          onClick={() => setFilter(filter === c.id ? null : c.id)}
                          className={cn(
                            "grid grid-cols-[12px_minmax(0,1fr)_minmax(60px,2fr)_56px] items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12.5px] hover:bg-surface-2",
                            filter === c.id && "bg-accent-soft/70",
                            filter && filter !== c.id && "opacity-55",
                          )}
                        >
                          <span
                            className="size-2.5 rounded-[3px]"
                            style={{ background: outcomeColor(theme, c.id, c.kind, i) }}
                          />
                          <span className="truncate">{c.name}</span>
                          <span className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                            <span
                              className="block h-full rounded-full"
                              style={{
                                width: `${share * 100}%`,
                                background: outcomeColor(theme, c.id, c.kind, i),
                              }}
                            />
                          </span>
                          <span className="num text-right text-ink-2">{f.percent(share, 0)}</span>
                        </button>
                      );
                    })}
                    {mc.deterministic ? (
                      <div className="mt-2 text-[12px] text-ink-3">
                        With fixed plan assumptions the plan{" "}
                        {mc.deterministic.success ? "succeeds" : "fails"} and ends with{" "}
                        {f.money(mc.deterministic.endNetWorthReal, true)}.
                      </div>
                    ) : null}
                  </div>
                </CardBody>
              </Card>

              <Card>
                <CardHeader
                  eyebrow="Range of outcomes"
                  title="Percentile fan"
                  actions={
                    <Select
                      aria-label="Metric"
                      value={metric}
                      onValueChange={(m) => setMetric(m)}
                      options={metrics.map((m) => ({ value: m, label: FAN_LABEL[m] }))}
                      className="w-[170px]"
                    />
                  }
                />
                <CardBody>
                  <FanChart mc={mc} det={det} metric={metric} basis={basis} />
                  <p className="mt-1 text-[11.5px] text-ink-3">
                    Dark band: middle 50% of trials; light bands: 5th–95th percentile; dashed: the
                    plan with fixed assumptions.
                    {basis === "nominal" && !mc.percentilesNominal
                      ? " Future money uses the plan’s assumed inflation."
                      : ""}
                  </p>
                </CardBody>
              </Card>

              <Card>
                <CardHeader eyebrow="Trial explorer" title="Inspect one simulated future" />
                <CardBody>
                  {input && det ? (
                    <TrialExplorer
                      mc={mc}
                      det={det}
                      input={input}
                      settings={settings}
                      example={example}
                      trial={trial}
                      onTrial={setTrial}
                      filter={filter}
                    />
                  ) : null}
                </CardBody>
              </Card>

              <div className="grid gap-5 xl:grid-cols-2">
                <Card>
                  <CardHeader eyebrow="Failures" title="When failed trials run short" />
                  <CardBody>
                    <FailureHistogram mc={mc} />
                  </CardBody>
                </Card>
                <Card>
                  <CardHeader eyebrow="Sequence of returns" title="Early returns vs success" />
                  <CardBody>
                    <SequenceRiskView mc={mc} />
                  </CardBody>
                </Card>
              </div>

              <Card>
                <CardHeader eyebrow="Milestones" title="When milestones happen across trials" />
                <CardBody>
                  <MilestoneTimingView
                    mc={mc}
                    startYear={det?.periods[0]?.year ?? new Date().getFullYear()}
                  />
                </CardBody>
              </Card>

              <Card>
                <CardHeader
                  eyebrow="Trials"
                  title={
                    filter ? `Trials: ${cats.find((c) => c.id === filter)?.name}` : "All trials"
                  }
                  actions={
                    filter ? (
                      <Button size="sm" variant="ghost" onClick={() => setFilter(null)}>
                        Clear filter
                      </Button>
                    ) : null
                  }
                />
                <TrialTable
                  mc={mc}
                  settings={settings}
                  filter={filter}
                  selected={trial}
                  onSelect={setTrial}
                />
              </Card>
            </>
          ) : null}
        </div>
      </div>
    </Page>
  );
}
