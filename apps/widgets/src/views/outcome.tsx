import { useState } from "react";
import { TimeChart } from "../components/chart";
import { Actions, Button, Chip, Chips, Notice, Shell } from "../components/ui";
import { useFormatter, useWidget } from "../context";
import type { OutcomeView as OutcomeViewData } from "../types";
import { markersAt, splitMarkers, useAction, useOpenView } from "./shared";

export function OutcomeView({ data }: { data: OutcomeViewData }) {
  const { host, hostState } = useWidget();
  const fmt = useFormatter(data.plan);
  const [selected, setSelected] = useState<number | null>(null);
  const action = useAction();
  const openView = useOpenView();
  const [asked, setAsked] = useState(false);
  const { outcome, years } = data;
  const isMc = data.kind === "monte-carlo" && outcome.successRate !== null;
  const lastYear = years[years.length - 1];
  const shortYear = isMc ? data.badCaseDepletionYear : outcome.depletionYear;
  const full = hostState.context.displayMode === "fullscreen";

  const big = isMc
    ? { value: fmt.percent(outcome.successRate ?? 0, 0), label: "chance your money lasts" }
    : outcome.depletionYear !== null
      ? {
          value: `Runs short in ${fmt.year(outcome.depletionYear)}`,
          label: "in the plan’s projection",
        }
      : {
          value: lastYear !== undefined ? `Lasts to ${fmt.year(lastYear)}` : "Lasts",
          label: "in the plan’s projection",
        };
  const bigTone = isMc
    ? (outcome.successRate ?? 0) >= 0.8
      ? "good"
      : (outcome.successRate ?? 0) < 0.6
        ? "bad"
        : "neutral"
    : outcome.depletionYear !== null
      ? "bad"
      : "good";

  const endMedian = data.median[data.median.length - 1] ?? outcome.endNetWorth;
  const { guides, ticks } = splitMarkers(data.markers);
  if (shortYear !== null)
    guides.push({
      year: shortYear,
      label: isMc ? `1 in 10 short by ${shortYear}` : `Runs short ${shortYear}`,
      tone: "alert",
    });
  const summary =
    `Net worth from ${years[0]} to ${lastYear}. ${data.headline}` +
    (data.p10 && data.p90
      ? ` At the end: median ${fmt.compact(endMedian)}, bad markets ${fmt.compact(
          data.p10[data.p10.length - 1] ?? 0,
        )}, good markets ${fmt.compact(data.p90[data.p90.length - 1] ?? 0)}.`
      : ` At the end: ${fmt.compact(endMedian)}.`);

  const readIndex = selected ?? null;
  const readYear = readIndex !== null ? years[readIndex] : undefined;

  return (
    <Shell plan={data.plan} title="Will my money last?">
      <section className="hero">
        <p className={`big num tone-${bigTone}`}>{big.value}</p>
        <p className="big-label">{big.label}</p>
        <p className="headline">{data.headline}</p>
      </section>

      <div className="readout" aria-live="polite">
        {readIndex !== null && readYear !== undefined ? (
          <>
            <span className="readout-year num">{readYear}</span>
            <span className="readout-item">
              <span className="swatch" style={{ background: "var(--chart-1)" }} />
              {isMc ? "Median" : "Net worth"}{" "}
              <strong className="num">{fmt.money(data.median[readIndex] ?? 0)}</strong>
            </span>
            {markersAt(data.markers, readYear).map((name) => (
              <span className="readout-item marker-name" key={name}>
                {name}
              </span>
            ))}
            {data.p10 && data.p90 ? (
              <span className="readout-item muted">
                Bad markets <span className="num">{fmt.compact(data.p10[readIndex] ?? 0)}</span> ·
                good <span className="num">{fmt.compact(data.p90[readIndex] ?? 0)}</span>
              </span>
            ) : null}
          </>
        ) : (
          <span className="muted">Drag across the chart to see any year.</span>
        )}
      </div>

      <TimeChart
        years={years}
        lines={[{ key: "median", label: "Median", values: data.median, color: "var(--chart-1)" }]}
        band={data.p10 && data.p90 ? { lo: data.p10, hi: data.p90 } : null}
        guides={guides}
        ticks={ticks}
        selected={selected}
        onSelect={setSelected}
        formatAxis={fmt.compact}
        height={full ? 280 : 176}
        label={summary}
        valueText={(i) =>
          `${years[i]}: ${isMc ? "median" : "net worth"} ${fmt.money(data.median[i] ?? 0)}`
        }
      />
      {data.p10 && data.p90 ? (
        <p className="legend">
          <span className="swatch" style={{ background: "var(--chart-1)" }} /> Median
          <span className="swatch band-swatch" /> 8 in 10 market paths
          {data.trials ? (
            <span className="muted"> · {data.trials.toLocaleString(fmt.locale)} runs</span>
          ) : null}
        </p>
      ) : null}

      <Chips>
        <Chip
          label={isMc ? "Median at end" : "End net worth"}
          value={fmt.compact(isMc ? endMedian : outcome.endNetWorth)}
        />
        {isMc ? (
          <Chip
            label="1 in 10 runs short"
            value={
              data.badCaseDepletionYear !== null ? fmt.year(data.badCaseDepletionYear) : "Never"
            }
            tone={data.badCaseDepletionYear !== null ? "bad" : "good"}
          />
        ) : null}
        {outcome.retirementYear !== null ? (
          <Chip
            label={data.plan.retirementLabel ?? "Retirement"}
            value={fmt.year(outcome.retirementYear)}
          />
        ) : !isMc ? (
          <Chip label="Lifetime tax" value={fmt.compact(outcome.lifetimeTaxes)} />
        ) : null}
      </Chips>

      <Actions>
        {readYear !== undefined ? (
          <Button
            variant="primary"
            busy={action.busy === "year"}
            onClick={() =>
              void action.run("year", () =>
                openView("explain_year", { planId: data.plan.planId, year: readYear }, "year"),
              )
            }
          >
            What happens in {readYear}?
          </Button>
        ) : null}
        {shortYear !== null && host.canSendMessage() ? (
          <Button
            disabled={asked}
            busy={action.busy === "why"}
            onClick={() =>
              void action.run("why", async () => {
                const sent = await host.sendMessage(
                  `Why could my Glideworth plan "${data.plan.planName}" run short in bad markets (around ${shortYear})? Explain what drives it and what I could change.`,
                );
                if (sent) setAsked(true);
              })
            }
          >
            {asked ? "Asked in the chat" : "Why could it fail?"}
          </Button>
        ) : null}
      </Actions>
      {action.error ? <Notice tone="bad">{action.error}</Notice> : null}
    </Shell>
  );
}
