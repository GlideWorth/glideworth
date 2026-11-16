/** Per-account history from recorded snapshots: stacked balances over time plus a table with sparklines. */
import type { ProgressSnapshot } from "@glideworth/core";
import { useCallback, useMemo } from "react";
import { Chart } from "../../components/charts/echarts";
import { Sparkline } from "../../components/charts/mini";
import { categoryColor, slotColor } from "../../components/charts/palette";
import {
  axisStyle,
  baseOption,
  type ChartTokens,
  tooltipHeader,
  tooltipRow,
} from "../../components/charts/tokens";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "../../components/ui/table";
import { formatMoney, formatSigned } from "../../lib/format";
import type { EntityIndex } from "../results/model";

export interface AccountHistoryRow {
  id: string;
  name: string;
  latest: number | null;
  first: number | null;
  change: number | null;
  points: number[];
}

/** Balance series per account across the given snapshots (oldest first). Gaps are skipped, not zeroed. */
export function accountHistory(snaps: ProgressSnapshot[], index: EntityIndex): AccountHistoryRow[] {
  const ids = [...new Set(snaps.flatMap((s) => s.accounts.map((a) => a.accountId)))];
  return ids
    .map((id) => {
      const pts = snaps.flatMap((s) => {
        const b = s.accounts.find((a) => a.accountId === id)?.balance;
        return b === undefined ? [] : [b];
      });
      const first = pts[0] ?? null;
      const latest = pts.at(-1) ?? null;
      return {
        id,
        name: index.accounts.get(id)?.name ?? id,
        latest,
        first,
        change: first !== null && latest !== null ? latest - first : null,
        points: pts,
      };
    })
    .sort((a, b) => (b.latest ?? 0) - (a.latest ?? 0));
}

export function AccountHistory({
  snaps,
  index,
  locale,
  currency,
  conv,
}: {
  snaps: ProgressSnapshot[];
  index: EntityIndex;
  locale: string;
  currency: string;
  conv: (date: string, v: number) => number;
}) {
  const rows = useMemo(() => accountHistory(snaps, index), [snaps, index]);
  const money = useCallback(
    (v: number, compact = true) => formatMoney(v, { locale, currency, compact }),
    [locale, currency],
  );
  const build = useCallback(
    (t: ChartTokens) => {
      const ax = axisStyle(t);
      const colorOf = (id: string, i: number) => {
        const meta = index.accounts.get(id);
        return meta ? categoryColor(t.theme, meta.category) : slotColor(t.theme, i);
      };
      return {
        ...baseOption(t),
        legend: { ...baseOption(t).legend, data: rows.map((r) => r.name) },
        grid: { ...baseOption(t).grid, top: 34 },
        tooltip: {
          ...baseOption(t).tooltip,
          axisPointer: { type: "line", lineStyle: { color: t.ink3 } },
          formatter: (
            ps: { value: [string, number | null]; seriesName: string; color: string }[],
          ) =>
            `${tooltipHeader(ps[0]?.value[0] ?? "")}${ps
              .filter((p) => p.value[1] !== null && p.value[1] !== undefined)
              .map((p) => tooltipRow(p.color, p.seriesName, money(p.value[1] as number, false)))
              .join("")}`,
        },
        xAxis: { type: "time", ...ax, splitLine: { show: false } },
        yAxis: {
          type: "value",
          ...ax,
          axisLabel: { ...ax.axisLabel, formatter: (v: number) => money(v) },
        },
        series: rows.map((r, i) => ({
          name: r.name,
          type: "line",
          stack: "accounts",
          symbol: "circle",
          symbolSize: 5,
          showSymbol: snaps.length < 40,
          connectNulls: true,
          lineStyle: { width: 1.25, color: colorOf(r.id, i) },
          itemStyle: { color: colorOf(r.id, i) },
          areaStyle: { color: colorOf(r.id, i), opacity: 0.8 },
          emphasis: { focus: "series" },
          data: snaps.map((s) => {
            const b = s.accounts.find((a) => a.accountId === r.id)?.balance;
            return [s.date, b === undefined ? null : conv(s.date, b)];
          }),
        })),
      };
    },
    [rows, snaps, index, money, conv],
  );
  if (rows.length === 0 || snaps.length < 1) return null;
  return (
    <Card>
      <CardHeader eyebrow="History" title="Balance by account" />
      <CardBody className="flex flex-col gap-4">
        <Chart
          build={build}
          height={300}
          ariaLabel="Stacked balance of each account over time from recorded snapshots. The table below lists the same values."
        />
        <Table>
          <THead>
            <TR>
              <TH>Account</TH>
              <TH numeric>Latest</TH>
              <TH numeric>Change</TH>
              <TH className="hidden sm:table-cell">Trend</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((r) => (
              <TR key={r.id}>
                <TD>{r.name}</TD>
                <TD numeric>{r.latest === null ? "—" : money(r.latest, false)}</TD>
                <TD
                  numeric
                  className={
                    r.change === null || Math.abs(r.change) < 0.5
                      ? "text-ink-3"
                      : r.change > 0
                        ? "text-positive"
                        : "text-negative"
                  }
                >
                  {r.change === null ? "—" : formatSigned(r.change, (v) => money(v, false), "—")}
                </TD>
                <TD className="hidden sm:table-cell">
                  <Sparkline
                    values={r.points}
                    width={90}
                    height={22}
                    ariaLabel={`${r.name} balance trend`}
                    fill={false}
                  />
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </CardBody>
    </Card>
  );
}
