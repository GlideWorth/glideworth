import { useState } from "react";
import { StackedBars } from "../components/chart";
import { Chip, Chips, Shell } from "../components/ui";
import { useFormatter, useWidget } from "../context";
import type { TaxView as TaxViewData } from "../types";

const COLORS = [
  "--chart-1",
  "--chart-3",
  "--chart-2",
  "--chart-4",
  "--chart-5",
  "--chart-6",
  "--chart-7",
];

export function TaxView({ data }: { data: TaxViewData }) {
  const fmt = useFormatter(data.plan);
  const { hostState } = useWidget();
  const [selected, setSelected] = useState<number | null>(null);
  const full = hostState.context.displayMode === "fullscreen";
  const kinds = data.kinds.map((k, i) => ({ ...k, color: `var(${COLORS[i % COLORS.length]})` }));
  const totals = data.years.map((_, i) => kinds.reduce((s, k) => s + (k.values[i] ?? 0), 0));
  let peak = 0;
  totals.forEach((t, i) => {
    if (t > (totals[peak] ?? 0)) peak = i;
  });
  const summary = `Tax by year from ${data.years[0]} to ${data.years[data.years.length - 1]}, ${kinds
    .map((k) => k.label)
    .join(
      ", ",
    )}. Lifetime total ${fmt.money(data.lifetimeTotal)}. Highest in ${data.years[peak]}: ${fmt.money(
    totals[peak] ?? 0,
  )}.`;

  return (
    <Shell plan={data.plan} title="Tax over time">
      <p className="headline lead">{data.headline}</p>
      <div className="readout" aria-live="polite">
        {selected !== null ? (
          <>
            <span className="readout-year num">{data.years[selected]}</span>
            {kinds.map((k) => (
              <span className="readout-item" key={k.key}>
                <span className="swatch" style={{ background: k.color }} />
                {k.label} <strong className="num">{fmt.money(k.values[selected] ?? 0)}</strong>
              </span>
            ))}
            <span className="readout-item">
              Total <strong className="num">{fmt.money(totals[selected] ?? 0)}</strong>
            </span>
          </>
        ) : (
          <span className="legend-inline">
            <span className="muted hint">Drag across the chart to see any year.</span>
            {kinds.map((k) => (
              <span className="readout-item" key={k.key}>
                <span className="swatch" style={{ background: k.color }} />
                {k.label}
              </span>
            ))}
          </span>
        )}
      </div>
      <StackedBars
        years={data.years}
        kinds={kinds}
        marker={
          data.retirementYear !== null ? { year: data.retirementYear, label: "Retire" } : null
        }
        selected={selected}
        onSelect={setSelected}
        formatAxis={fmt.compact}
        height={full ? 260 : 168}
        label={summary}
        valueText={(i) => `${data.years[i]}: total tax ${fmt.money(totals[i] ?? 0)}`}
      />
      <Chips>
        <Chip label="Lifetime tax" value={fmt.compact(data.lifetimeTotal)} />
        <Chip
          label="Highest year"
          value={String(data.years[peak] ?? "—")}
          detail={fmt.compact(totals[peak] ?? 0)}
        />
      </Chips>
    </Shell>
  );
}
